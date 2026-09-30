package signaling

import (
	"encoding/json"
	"strconv"
	"strings"

	"visioncall/internal/db"
	"visioncall/internal/sfu"
)

// Conference rooms are bound to chat groups: room id "group:<groupID>".
func roomGroupID(roomID string) (int64, bool) {
	s := strings.TrimPrefix(roomID, "group:")
	if s == roomID || s == "" {
		return 0, false
	}
	id, err := strconv.ParseInt(s, 10, 64)
	return id, err == nil
}

type roomJoinPayload struct {
	RoomID string `json:"room_id"`
	Video  bool   `json:"video"`
	Resume bool   `json:"resume"`
	// Passcode only applies to "priv:<id>" rooms; ignored otherwise.
	Passcode *string `json:"passcode"`
}

func (c *Client) roomJoinError(message string) {
	c.Send("error", map[string]string{"code": "room-join", "message": message})
}

func (c *Client) handleRoomJoin(env *Envelope) {
	var p roomJoinPayload
	if err := json.Unmarshal(env.Data, &p); err != nil {
		c.roomJoinError("invalid room request")
		return
	}
	if groupID, ok := roomGroupID(p.RoomID); ok {
		member, err := c.hub.db.IsGroupMember(groupID, c.user.ID)
		if err != nil || !member {
			c.roomJoinError("you are not a member of this group")
			return
		}
	} else if privID, ok := privRoomID(p.RoomID); ok {
		if !c.authorizePrivateRoomJoin(privID, p.Passcode) {
			return // already responded: pending approval, denied, or an error
		}
	} else {
		c.roomJoinError("invalid room id")
		return
	}
	c.hub.callStateMu.Lock()
	defer c.hub.callStateMu.Unlock()
	c.hub.promote(c)
	if c.hub.p2p.callForUser(c.user.ID) != nil {
		c.roomJoinError("you are already in a call")
		return
	}
	_, err := c.hub.engine.Join(p.RoomID, c.user.ID, c.user.DisplayName, c.user.AvatarFileID, p.Video, p.Resume, c.advertiseIP(), c.hub.signalFunc(c.user.ID))
	if err != nil {
		c.roomJoinError(err.Error())
		return
	}
	c.hub.cancelRoomLeave(c.user.ID)
	// The room's owner (private room owner / group creator) is always host,
	// even when a guest happened to join first — otherwise that guest could
	// mute or remove the owner from their own room.
	if c.hub.isRoomOwner(p.RoomID, c.user.ID) {
		c.hub.engine.ClaimHost(p.RoomID, c.user.ID)
	}
}

func (h *Hub) isRoomOwner(roomID string, userID int64) bool {
	if groupID, ok := roomGroupID(roomID); ok {
		g, err := h.db.GetGroup(groupID)
		return err == nil && g.CreatedBy == userID
	}
	if privID, ok := privRoomID(roomID); ok {
		room, err := h.db.GetPrivateRoom(privID)
		return err == nil && room.OwnerID == userID
	}
	return false
}

// signalFunc adapts engine callbacks into WS sends to a specific user.
func (h *Hub) signalFunc(userID int64) sfu.SignalFunc {
	return func(typ string, data any) { h.sendToUser(userID, typ, data) }
}

func (c *Client) handleRoomLeave(env *Envelope) {
	c.hub.callStateMu.Lock()
	defer c.hub.callStateMu.Unlock()
	c.hub.cancelRoomLeave(c.user.ID)
	c.hub.engine.Leave(c.user.ID)
	c.hub.privateRooms.dropUserEverywhere(c.user.ID)
}

func (c *Client) handleRoomMuteRequest(env *Envelope) {
	var p struct {
		TargetUserID int64 `json:"target_user_id"`
		Lock         bool  `json:"lock"`
	}
	if err := json.Unmarshal(env.Data, &p); err != nil {
		return
	}
	if p.TargetUserID == 0 {
		return
	}
	if !c.hub.engine.MuteRequest(c.user.ID, p.TargetUserID, c.user.Role == "admin", p.Lock) {
		c.Send("error", map[string]string{"message": "only the call host can mute others"})
	}
}

func (c *Client) handleRoomUnlockRequest(env *Envelope) {
	var p struct {
		TargetUserID int64 `json:"target_user_id"`
	}
	if err := json.Unmarshal(env.Data, &p); err != nil || p.TargetUserID == 0 {
		return
	}
	if !c.hub.engine.UnlockRequest(c.user.ID, p.TargetUserID, c.user.Role == "admin") {
		c.Send("error", map[string]string{"message": "only the call host can unlock a participant"})
	}
}

func (c *Client) handleRoomKickRequest(env *Envelope) {
	var p struct {
		TargetUserID int64 `json:"target_user_id"`
	}
	if err := json.Unmarshal(env.Data, &p); err != nil || p.TargetUserID == 0 {
		return
	}
	if !c.hub.engine.KickRequest(c.user.ID, p.TargetUserID, c.user.Role == "admin") {
		c.Send("error", map[string]string{"message": "only the call host can remove participants"})
	}
}

func (c *Client) handleRoomPresenterOnlyRequest(env *Envelope) {
	var p struct {
		RoomID  string `json:"room_id"`
		Enabled bool   `json:"enabled"`
	}
	if err := json.Unmarshal(env.Data, &p); err != nil || p.RoomID == "" {
		return
	}
	if !c.hub.engine.SetPresenterOnly(c.user.ID, p.Enabled, c.user.Role == "admin") {
		c.Send("error", map[string]string{"message": "only the call host can restrict presenting"})
		return
	}
	// Announce into the room the engine actually toggled, not whatever
	// room_id the client sent — SetPresenterOnly above only ever acts on the
	// caller's real room, so the notification must match it too, or a
	// caller could point the UI announcement at an unrelated room.
	actualRoomID, ok := c.hub.engine.RoomIDForUser(c.user.ID)
	if !ok {
		return
	}
	// Per-participant CanPresent updates go out via the engine's usual
	// EventUpdated -> room:participant broadcast; this just announces the
	// room-wide toggle itself for UI copy ("presenter-only mode is on").
	c.hub.broadcastToRoom(actualRoomID, "room:presenter-only", map[string]any{"room_id": actualRoomID, "enabled": p.Enabled}, nil)
}

func (c *Client) handleRoomPresenterRequest(env *Envelope) {
	var p struct {
		TargetUserID int64 `json:"target_user_id"`
		Allowed      bool  `json:"allowed"`
	}
	if err := json.Unmarshal(env.Data, &p); err != nil || p.TargetUserID == 0 {
		return
	}
	if !c.hub.engine.SetPresenter(c.user.ID, p.TargetUserID, p.Allowed, c.user.Role == "admin") {
		c.Send("error", map[string]string{"message": "only the call host can grant presenter rights"})
	}
}

// handleRoomRosterRequest answers a private room's owner with who they
// invited and which of those (plus anyone else) are actually in the live
// call right now — the "invited vs joined" list for the in-call sidebar.
func (c *Client) handleRoomRosterRequest(env *Envelope) {
	var p struct {
		RoomID string `json:"room_id"`
	}
	if err := json.Unmarshal(env.Data, &p); err != nil || p.RoomID == "" {
		return
	}
	privID, ok := privRoomID(p.RoomID)
	if !ok {
		return
	}
	room, err := c.hub.db.GetPrivateRoom(privID)
	if err != nil || room.OwnerID != c.user.ID {
		return // roster is only meaningful (and visible) to the room owner
	}
	inviteeIDs, err := c.hub.db.PrivateRoomInviteeIDs(privID)
	if err != nil {
		return
	}
	invitees := make([]*db.UserBrief, 0, len(inviteeIDs))
	for _, uid := range inviteeIDs {
		if u, err := c.hub.db.GetUserByID(uid); err == nil {
			invitees = append(invitees, briefOf(u))
		}
	}
	c.Send("room:roster", map[string]any{
		"room_id":  p.RoomID,
		"invitees": invitees,
		"joined":   c.hub.engine.RoomUserIDs(p.RoomID),
	})
}

// handleRoomNudgeRequest re-pings an invited-but-not-yet-joined user with the
// same "room:invite" prompt used for group-call invites, so the host can
// nudge someone in without them having to be told the room code out of band.
func (c *Client) handleRoomNudgeRequest(env *Envelope) {
	var p struct {
		RoomID       string `json:"room_id"`
		TargetUserID int64  `json:"target_user_id"`
	}
	if err := json.Unmarshal(env.Data, &p); err != nil || p.RoomID == "" || p.TargetUserID == 0 {
		return
	}
	privID, ok := privRoomID(p.RoomID)
	if !ok {
		return
	}
	room, err := c.hub.db.GetPrivateRoom(privID)
	if err != nil || room.OwnerID != c.user.ID {
		return
	}
	allowed, err := c.hub.db.IsPrivateRoomAllowed(privID, p.TargetUserID)
	if err != nil || !allowed {
		return
	}
	c.hub.sendToUser(p.TargetUserID, "room:invite", map[string]any{
		"room_id":    p.RoomID,
		"group_name": room.Name,
		"from":       briefOf(c.user),
	})
}

// handleRaiseHand relays a "hand up/down" signal to the rest of the caller's
// room — purely ephemeral UI state, no persistence, no permission beyond
// "you're actually in the room you claim".
func (c *Client) handleRaiseHand(env *Envelope) {
	var p struct {
		RoomID string `json:"room_id"`
		Raised bool   `json:"raised"`
	}
	if json.Unmarshal(env.Data, &p) != nil || p.RoomID == "" {
		return
	}
	// Ignore whatever room_id the client sent for anything but display —
	// broadcast only into the room the engine actually has them in, so a
	// participant of room A can't spoof a raise-hand into unrelated room B
	// by naming its id.
	actualRoomID, ok := c.hub.engine.RoomIDForUser(c.user.ID)
	if !ok || actualRoomID != p.RoomID {
		return
	}
	for _, uid := range c.hub.engine.RoomUserIDs(p.RoomID) {
		if uid == c.user.ID {
			continue
		}
		c.hub.sendToUser(uid, "call:raise-hand", map[string]any{"room_id": p.RoomID, "user_id": c.user.ID, "raised": p.Raised})
	}
}

func (c *Client) handlePubOffer(env *Envelope) {
	var sdp sfu.SDP
	if json.Unmarshal(env.Data, &sdp) != nil {
		return
	}
	c.hub.engine.HandlePubOffer(c.user.ID, sdp)
}

func (c *Client) handlePubICE(env *Envelope) {
	var ice sfu.ICE
	if json.Unmarshal(env.Data, &ice) != nil {
		return
	}
	c.hub.engine.HandlePubICE(c.user.ID, ice)
}

func (c *Client) handleSubAnswer(env *Envelope) {
	var sdp sfu.SDP
	if json.Unmarshal(env.Data, &sdp) != nil {
		return
	}
	c.hub.engine.HandleSubAnswer(c.user.ID, sdp)
}

func (c *Client) handleSubICE(env *Envelope) {
	var ice sfu.ICE
	if json.Unmarshal(env.Data, &ice) != nil {
		return
	}
	c.hub.engine.HandleSubICE(c.user.ID, ice)
}

func (c *Client) handleTrackState(env *Envelope) {
	var st sfu.TrackState
	if json.Unmarshal(env.Data, &st) != nil {
		return
	}
	c.hub.engine.HandleTrackState(c.user.ID, st)
}

// onRoomEvent is the engine's callback into the hub: persistence + broadcasts.
func (h *Hub) onRoomEvent(ev sfu.Event) {
	switch ev.Kind {
	case sfu.EventRoomCreated:
		row, err := h.db.CreateCall(ev.RoomID, ev.UserID, true)
		if err != nil {
			h.log.Error("call: create conference call", "room_id", ev.RoomID, "err", err)
		} else {
			h.mu.Lock()
			h.roomCalls[ev.RoomID] = row.ID
			h.mu.Unlock()
			if err := h.db.AddCallParticipant(row.ID, ev.UserID, true); err != nil {
				h.log.Error("call: add conference initiator", "room_id", ev.RoomID, "err", err)
			}
		}
		// invite the rest of the group
		if groupID, ok := roomGroupID(ev.RoomID); ok {
			if group, err := h.db.GetGroup(groupID); err == nil {
				inviter, err := h.db.GetUserByID(ev.UserID)
				if err != nil {
					h.log.Error("call: load conference inviter", "user_id", ev.UserID, "err", err)
				}
				if inviter != nil {
					for _, m := range group.Members {
						if m.ID == ev.UserID {
							continue
						}
						h.sendToUser(m.ID, "room:invite", map[string]any{
							"room_id":    ev.RoomID,
							"group_id":   groupID,
							"group_name": group.Name,
							"from":       briefOf(inviter),
						})
					}
				}
			}
		}
	case sfu.EventJoined:
		if callID := h.roomCallID(ev.RoomID); callID > 0 {
			if err := h.db.AddCallParticipant(callID, ev.UserID, true); err != nil {
				h.log.Error("call: add conference participant", "room_id", ev.RoomID, "user_id", ev.UserID, "err", err)
			}
		}
	case sfu.EventLeft:
		if callID := h.roomCallID(ev.RoomID); callID > 0 {
			if err := h.db.CallParticipantLeft(callID, ev.UserID); err != nil {
				h.log.Error("call: mark conference participant left", "room_id", ev.RoomID, "user_id", ev.UserID, "err", err)
			}
		}
		h.broadcastToRoom(ev.RoomID, "room:left", map[string]any{
			"room_id": ev.RoomID, "user_id": ev.UserID,
		}, &ev.UserID)
	case sfu.EventUpdated:
		h.broadcastToRoom(ev.RoomID, "room:participant", map[string]any{
			"room_id": ev.RoomID, "participant": ev.Info,
		}, nil)
	case sfu.EventRoomClosed:
		// Tell the group the call is over so "join call" indicators clear —
		// room:invite set them, and nothing else ever unset them. A new
		// event (not room:closed): clients treat room:closed as "end my call".
		if groupID, ok := roomGroupID(ev.RoomID); ok {
			if ids, err := h.db.GroupMemberIDs(groupID); err == nil {
				for _, uid := range ids {
					h.sendToUser(uid, "room:ended", map[string]any{"room_id": ev.RoomID, "group_id": groupID})
				}
			}
		}
		if callID := h.roomCallID(ev.RoomID); callID > 0 {
			if err := h.db.EndCall(callID); err != nil {
				h.log.Error("call: end conference call", "room_id", ev.RoomID, "err", err)
			}
			h.mu.Lock()
			delete(h.roomCalls, ev.RoomID)
			h.mu.Unlock()
		}
	}
}

func (h *Hub) roomCallID(roomID string) int64 {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.roomCalls[roomID]
}

func (h *Hub) broadcastToRoom(roomID, typ string, data any, except *int64) {
	for _, uid := range h.engine.RoomUserIDs(roomID) {
		if except != nil && uid == *except {
			continue
		}
		h.sendToUser(uid, typ, data)
	}
}
