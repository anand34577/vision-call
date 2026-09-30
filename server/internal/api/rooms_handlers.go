package api

import (
	"crypto/rand"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"visioncall/internal/auth"
	"visioncall/internal/db"
)

// roomCodeAlphabet skips visually-ambiguous characters (0/O, 1/I/L) so a
// code read aloud or typed by hand doesn't misfire.
const roomCodeAlphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"

func generateRoomCode() (string, error) {
	b := make([]byte, 7)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	code := make([]byte, len(b))
	for i, v := range b {
		code[i] = roomCodeAlphabet[int(v)%len(roomCodeAlphabet)]
	}
	return string(code), nil
}

// roomInfo is the client-facing shape of a PrivateRoom — never carries the
// passcode hash, only whether one is required.
type roomInfo struct {
	ID              string        `json:"id"`
	Name            string        `json:"name"`
	Owner           *db.UserBrief `json:"owner,omitempty"`
	RequirePasscode bool          `json:"require_passcode"`
	RequireApproval bool          `json:"require_approval"`
	IsOwner         bool          `json:"is_owner"`
	CreatedAt       string        `json:"created_at"`
	ScheduledAt     string        `json:"scheduled_at"`
}

func (a *API) roomInfoOf(room *db.PrivateRoom, viewerID int64) roomInfo {
	info := roomInfo{
		ID:              room.ID,
		Name:            room.Name,
		RequirePasscode: room.PasscodeHash != nil,
		RequireApproval: room.RequireApproval,
		IsOwner:         room.OwnerID == viewerID,
		CreatedAt:       room.CreatedAt,
		ScheduledAt:     room.ScheduledAt,
	}
	if owner, err := a.db.GetUserByID(room.OwnerID); err == nil {
		b := briefOf(owner)
		info.Owner = b
	}
	return info
}

// briefOf trims a full user record down to the shape embedded in rooms
// (mirrors signaling.briefOf — kept local since the two packages don't
// share a UI-facing helper layer).
func briefOf(u *db.User) *db.UserBrief {
	return &db.UserBrief{ID: u.ID, DisplayName: u.DisplayName, Username: u.Username, AvatarFileID: u.AvatarFileID}
}

type createRoomRequest struct {
	Name            string  `json:"name"`
	Passcode        string  `json:"passcode"`
	RequireApproval bool    `json:"require_approval"`
	InvitedUserIDs  []int64 `json:"invited_user_ids"`
	// ScheduledAt (RFC3339) turns the room into a scheduled meeting; empty = start now.
	ScheduledAt string `json:"scheduled_at"`
}

func (a *API) handleCreateRoom(w http.ResponseWriter, r *http.Request) {
	me := auth.CurrentUser(r)
	var req createRoomRequest
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		req.Name = me.DisplayName + "'s room"
	}
	if len(req.Name) > 64 {
		writeErr(w, http.StatusBadRequest, "room name must be at most 64 characters")
		return
	}
	if len(req.InvitedUserIDs) > 100 {
		writeErr(w, http.StatusBadRequest, "too many invited users")
		return
	}
	for _, id := range req.InvitedUserIDs {
		if id == me.ID {
			continue
		}
		u, err := a.db.GetUserByID(id)
		if err != nil || u.Disabled {
			writeErr(w, http.StatusBadRequest, "invited user is unavailable")
			return
		}
	}

	scheduledAt := ""
	if s := strings.TrimSpace(req.ScheduledAt); s != "" {
		t, err := time.Parse(time.RFC3339, s)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "scheduled time must be a valid date and time")
			return
		}
		scheduledAt = t.UTC().Format(time.RFC3339)
	}

	var passcodeHash *string
	if strings.TrimSpace(req.Passcode) != "" {
		hash, err := auth.HashPassword(req.Passcode)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "could not create room")
			return
		}
		passcodeHash = &hash
	}

	// Collision odds on a 7-char, 32-symbol code are astronomically low;
	// a bounded retry loop is still cheap insurance against a stuck insert.
	var id string
	for attempt := 0; attempt < 5; attempt++ {
		code, err := generateRoomCode()
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "could not create room")
			return
		}
		if _, err := a.db.GetPrivateRoom(code); err == db.ErrNotFound {
			id = code
			break
		}
	}
	if id == "" {
		writeErr(w, http.StatusInternalServerError, "could not create room")
		return
	}

	if err := a.db.CreatePrivateRoom(id, req.Name, me.ID, passcodeHash, req.RequireApproval, req.InvitedUserIDs, scheduledAt); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not create room")
		return
	}
	a.audit(r, "room.create", "private_room", nil, id)
	room, err := a.db.GetPrivateRoom(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "room created but could not be loaded")
		return
	}
	writeJSON(w, http.StatusCreated, a.roomInfoOf(room, me.ID))
}

func (a *API) handleListMyRooms(w http.ResponseWriter, r *http.Request) {
	me := auth.CurrentUser(r)
	rooms, err := a.db.ListMyPrivateRooms(me.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not list rooms")
		return
	}
	out := make([]roomInfo, len(rooms))
	for i, room := range rooms {
		out[i] = a.roomInfoOf(room, me.ID)
	}
	writeJSON(w, http.StatusOK, out)
}

// handleGetRoom is the join-info lookup: enough to render a "join room"
// screen (name, host, whether a passcode/approval is needed) without
// requiring the caller to already be invited — the actual gate is enforced
// at WS room:join time (see signaling.authorizePrivateRoomJoin).
func (a *API) handleGetRoom(w http.ResponseWriter, r *http.Request) {
	me := auth.CurrentUser(r)
	id := strings.ToUpper(strings.TrimSpace(chi.URLParam(r, "id")))
	room, err := a.db.GetPrivateRoom(id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "room not found")
		return
	}
	writeJSON(w, http.StatusOK, a.roomInfoOf(room, me.ID))
}

func (a *API) handleDeleteRoom(w http.ResponseWriter, r *http.Request) {
	me := auth.CurrentUser(r)
	id := strings.ToUpper(strings.TrimSpace(chi.URLParam(r, "id")))
	if err := a.db.DeletePrivateRoom(id, me.ID); err != nil {
		writeErr(w, http.StatusNotFound, "room not found")
		return
	}
	if closer, ok := a.hub.(interface{ CloseRoom(string) }); ok {
		closer.CloseRoom("priv:" + id)
	}
	a.audit(r, "room.delete", "private_room", nil, id)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
