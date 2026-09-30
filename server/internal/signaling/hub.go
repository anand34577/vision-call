package signaling

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"visioncall/internal/auth"
	"visioncall/internal/config"
	"visioncall/internal/db"
	"visioncall/internal/settings"
	"visioncall/internal/sfu"
)

// Envelope is the single WS message shape in both directions.
type Envelope struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data,omitempty"`
}

type Hub struct {
	cfg      *config.Config
	db       *db.DB
	engine   *sfu.Engine
	log      *slog.Logger
	settings *settings.Store

	mu sync.RWMutex
	// clients holds each user's primary connection: the one calls and
	// conference signaling go to. extras holds their other signed-in devices
	// (phone + laptop at once); chat traffic fans out to all of them, and
	// call-related actions promote the acting device to primary.
	clients map[int64]*Client
	extras  map[int64][]*Client
	// active conference roomID -> call DB row id
	roomCalls       map[string]int64
	roomLeaveTimers map[int64]*time.Timer
	roomLeaveTokens map[int64]uint64
	callStateMu     sync.Mutex

	p2p          *p2pManager
	privateRooms *privateRoomGate
	// passcodes throttles wrong private-room passcodes per (user, room) —
	// without it a short numeric passcode falls to brute force over one
	// socket, each guess costing the server an argon2 hash.
	passcodes *auth.LoginLimiter
	upgrader  websocket.Upgrader
	closed    atomic.Bool

	// lastStatus remembers each user's last explicitly-chosen presence status
	// ("away"/"dnd") across reconnects — a Client's status lives on that one
	// connection and is lost when it's replaced, so without this a reconnect
	// (network blip, laptop sleep/wake, tab backgrounded) would silently reset
	// a user-set DND back to "online" on every new connection.
	lastStatus sync.Map // int64 user id -> string status
}

func (h *Hub) rememberStatus(userID int64, status string) {
	h.lastStatus.Store(userID, status)
}

func (h *Hub) recallStatus(userID int64) string {
	if v, ok := h.lastStatus.Load(userID); ok {
		if s, ok := v.(string); ok && s != "" {
			return s
		}
	}
	return "online"
}

func NewHub(cfg *config.Config, dbh *db.DB, log *slog.Logger, settingsStore *settings.Store) *Hub {
	h := &Hub{
		cfg:             cfg,
		db:              dbh,
		log:             log,
		settings:        settingsStore,
		clients:         map[int64]*Client{},
		roomCalls:       map[string]int64{},
		roomLeaveTimers: map[int64]*time.Timer{},
		roomLeaveTokens: map[int64]uint64{},
		privateRooms:    newPrivateRoomGate(),
		passcodes:       auth.NewLoginLimiter(),
		upgrader: websocket.Upgrader{
			ReadBufferSize:  4096,
			WriteBufferSize: 4096,
			CheckOrigin: func(r *http.Request) bool {
				// Same-origin only; absent Origin (native clients / curl) is allowed.
				origin := r.Header.Get("Origin")
				return origin == "" || origin == "http://"+r.Host || origin == "https://"+r.Host
			},
		},
	}
	h.p2p = newP2PManager(h)
	// MaxParticipants/ExternalIP are "restart to take effect" settings — the
	// SFU engine doesn't re-read them mid-run, but a restart after an admin
	// edit does, since settingsStore.Get() already merges env/.env/DB/default.
	sv := settingsStore.Get()
	h.engine = sfu.NewEngine(sfu.Config{
		MaxParticipants: sv.MaxCallParticipants,
		ExternalIP:      sv.ExternalIP,
		FallbackIP:      config.DetectPrimaryLANIP(),
		UDPPort:         cfg.WebRTCUDPPort,
	}, log)
	h.engine.OnEvent = h.onRoomEvent
	return h
}

// HandleWS upgrades an authenticated HTTP request into a client WebSocket session.
func (h *Hub) HandleWS(w http.ResponseWriter, r *http.Request) {
	if h.closed.Load() {
		http.Error(w, "server shutting down", http.StatusServiceUnavailable)
		return
	}

	cookie, err := r.Cookie(auth.CookieName)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	user, err := auth.ValidateSession(h.db, h.cfg.JWTSecret, cookie.Value, time.Duration(h.settings.Get().SessionTTLHours)*time.Hour)
	if err != nil {
		h.log.Warn("ws: invalid session", "ip", realIP(r, h.settings.Get().TrustProxy), "err", err)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	claims, err := auth.ParseToken(h.cfg.JWTSecret, cookie.Value)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if user.Disabled {
		http.Error(w, "account disabled", http.StatusForbidden)
		return
	}

	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		h.log.Warn("ws: upgrade failed", "user_id", user.ID, "ip", realIP(r, h.settings.Get().TrustProxy), "err", err)
		return
	}

	ip := realIP(r, h.settings.Get().TrustProxy)
	clog := h.log.With("user_id", user.ID, "username", user.Username, "ip", ip)
	c := &Client{
		hub:       h,
		user:      user,
		conn:      conn,
		send:      make(chan []byte, 256),
		log:       clog,
		deviceID:  r.URL.Query().Get("device"),
		host:      r.Host,
		sessionID: claims.SessionID,
	}
	h.register(c)
	clog.Info("ws: connected")
	go c.writePump()
	go c.readPump()
}

func realIP(r *http.Request, trustProxy bool) string { return auth.RealIP(r, trustProxy) }

func (h *Hub) register(c *Client) {
	h.callStateMu.Lock()
	h.mu.Lock()
	uid := c.user.ID
	if h.extras == nil {
		h.extras = map[int64][]*Client{}
	}
	old := h.clients[uid]
	var replaced *Client // same-device connection this one supersedes
	switch {
	case old == nil:
		h.clients[uid] = c
	case sameDevice(old, c):
		replaced = old
		h.clients[uid] = c
		// Keep an SFU participant alive briefly so a reconnect can resume.
		h.scheduleRoomLeaveLocked(uid)
	default:
		// A different device signed in: it stays connected alongside the
		// first one instead of signing it out. Only its own earlier socket
		// (same device id, e.g. a refresh) is superseded.
		list := h.extras[uid]
		placed := false
		for i, e := range list {
			if sameDevice(e, c) {
				replaced = e
				list[i] = c
				placed = true
				break
			}
		}
		if !placed {
			h.extras[uid] = append(list, c)
		}
	}
	h.mu.Unlock()
	if replaced != nil {
		// ws:replaced tells that tab's client to stop reconnecting on its own
		// instead of fighting over the slot with this one.
		h.log.Debug("ws: replacing existing connection (same device)", "user_id", uid)
		replaced.Finish("ws:replaced", nil)
		if replaced == old {
			// Most likely the same tab reconnecting: a 1:1 call survives if the
			// client sends call:resume within the grace period.
			h.p2p.scheduleDisconnect(uid)
		}
	}
	h.callStateMu.Unlock()
	h.onConnect(c)
}

func sameDevice(a, b *Client) bool { return a.deviceID != "" && a.deviceID == b.deviceID }

// promote makes c the user's primary connection (the target of call and
// conference signaling), demoting the previous primary to an extra device.
func (h *Hub) promote(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	uid := c.user.ID
	cur := h.clients[uid]
	if cur == c || cur == nil {
		return
	}
	list := h.extras[uid][:0:0]
	for _, e := range h.extras[uid] {
		if e != c {
			list = append(list, e)
		}
	}
	h.extras[uid] = append(list, cur)
	h.clients[uid] = c
}

// allConns returns every live connection of a user, primary first.
func (h *Hub) allConns(userID int64) []*Client {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.allConnsLocked(userID)
}

func (h *Hub) allConnsLocked(userID int64) []*Client {
	p := h.clients[userID]
	if p == nil {
		return nil
	}
	out := make([]*Client, 0, 1+len(h.extras[userID]))
	out = append(out, p)
	return append(out, h.extras[userID]...)
}

// sendToOthers delivers to the user's other devices, not c itself.
func (h *Hub) sendToOthers(c *Client, typ string, data any) {
	for _, o := range h.allConns(c.user.ID) {
		if o != c {
			o.Send(typ, data)
		}
	}
}

// fansOut reports whether a message type goes to every device of a user
// (chat, group and ring events) rather than only the primary connection
// (WebRTC/SFU signaling, which belongs to exactly one device).
func fansOut(typ string) bool {
	if strings.HasPrefix(typ, "message:") || strings.HasPrefix(typ, "group:") || strings.HasPrefix(typ, "poll:") || typ == "blocks:changed" {
		return true
	}
	switch typ {
	case "call:invite", "call:ended", "room:invite", "account:updated", "conversation:prefs":
		return true
	}
	return false
}

// KickSession signs out just the connections that belong to one session.
func (h *Hub) KickSession(userID int64, sessionID, reason string) {
	for _, c := range h.allConns(userID) {
		if c.sessionID == sessionID {
			c.Kick(reason)
		}
	}
}

// KickOtherSessions signs out every connection except those of keepSessionID.
func (h *Hub) KickOtherSessions(userID int64, keepSessionID, reason string) {
	for _, c := range h.allConns(userID) {
		if c.sessionID != keepSessionID {
			c.Kick(reason)
		}
	}
}

func (h *Hub) unregister(c *Client) {
	h.callStateMu.Lock()
	defer h.callStateMu.Unlock()
	h.mu.Lock()
	uid := c.user.ID
	if h.clients[uid] != c {
		// An extra device (or a connection that was already replaced).
		list := h.extras[uid]
		for i, e := range list {
			if e == c {
				h.extras[uid] = append(list[:i:i], list[i+1:]...)
				break
			}
		}
		if len(h.extras[uid]) == 0 {
			delete(h.extras, uid)
		}
		h.mu.Unlock()
		return
	}
	delete(h.clients, uid)
	promoted := false
	if list := h.extras[uid]; len(list) > 0 {
		h.clients[uid] = list[len(list)-1]
		if len(list) == 1 {
			delete(h.extras, uid)
		} else {
			h.extras[uid] = list[:len(list)-1]
		}
		promoted = true
	}
	if h.closed.Load() {
		h.mu.Unlock()
		return
	}
	h.scheduleRoomLeaveLocked(uid)
	h.mu.Unlock()
	c.log.Info("ws: disconnected")
	if !promoted {
		h.broadcast("presence:update", map[string]any{"user_id": uid, "status": "offline"}, nil)
	}
	// Any call this device was in cannot be carried on by another device.
	h.p2p.scheduleDisconnect(uid)
	h.privateRooms.dropUserEverywhere(uid)
}

const sfuResumeGrace = 15 * time.Second

// scheduleRoomLeaveLocked delays SFU teardown after a signaling disconnect so
// the browser can reconnect and swap the participant's signal callback.
// Caller holds callStateMu and h.mu.
func (h *Hub) scheduleRoomLeaveLocked(userID int64) {
	if h.roomLeaveTimers == nil {
		h.roomLeaveTimers = map[int64]*time.Timer{}
	}
	if h.roomLeaveTokens == nil {
		h.roomLeaveTokens = map[int64]uint64{}
	}
	if timer := h.roomLeaveTimers[userID]; timer != nil {
		timer.Stop()
	}
	token := h.roomLeaveTokens[userID] + 1
	h.roomLeaveTokens[userID] = token
	h.roomLeaveTimers[userID] = time.AfterFunc(sfuResumeGrace, func() {
		h.expireRoomLeave(userID, token)
	})
}

func (h *Hub) cancelRoomLeave(userID int64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.roomLeaveTokens == nil {
		h.roomLeaveTokens = map[int64]uint64{}
	}
	if timer := h.roomLeaveTimers[userID]; timer != nil {
		timer.Stop()
		delete(h.roomLeaveTimers, userID)
	}
	h.roomLeaveTokens[userID]++
}

func (h *Hub) expireRoomLeave(userID int64, token uint64) {
	h.callStateMu.Lock()
	defer h.callStateMu.Unlock()
	h.mu.Lock()
	if h.roomLeaveTokens[userID] != token {
		h.mu.Unlock()
		return
	}
	delete(h.roomLeaveTimers, userID)
	delete(h.roomLeaveTokens, userID)
	h.mu.Unlock()
	if h.closed.Load() {
		return
	}
	h.engine.Leave(userID)
}

func (h *Hub) client(userID int64) *Client {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.clients[userID]
}

// sendToUser delivers a message if the user is connected; returns false if
// offline. Chat and ring events reach every device, signaling only the primary.
func (h *Hub) sendToUser(userID int64, typ string, data any) bool {
	conns := h.allConns(userID)
	if len(conns) == 0 {
		return false
	}
	ok := conns[0].Send(typ, data)
	if fansOut(typ) {
		for _, c := range conns[1:] {
			c.Send(typ, data)
		}
	}
	return ok
}

// SendToUser is the exported form used by the REST API for realtime events.
func (h *Hub) SendToUser(userID int64, typ string, data any) bool {
	return h.sendToUser(userID, typ, data)
}

// DirectoryChanged tells every connected app to reload the people list, so
// an account an admin just created, suspended or removed shows up (or
// disappears) for everyone at once.
func (h *Hub) DirectoryChanged() { h.broadcast("directory:changed", nil, nil) }

// AccountUpdated tells a user's own app to reload their profile, for example
// after an admin changes their role or name.
func (h *Hub) AccountUpdated(userID int64) { h.sendToUser(userID, "account:updated", nil) }

func (h *Hub) broadcast(typ string, data any, except *int64) {
	payload, err := marshalEnvelope(typ, data)
	if err != nil {
		h.log.Error("ws: marshal broadcast", "type", typ, "err", err)
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for id, c := range h.clients {
		if except != nil && id == *except {
			continue
		}
		c.SendRaw(payload)
		for _, e := range h.extras[id] {
			e.SendRaw(payload)
		}
	}
}

func marshalEnvelope(typ string, data any) ([]byte, error) {
	raw, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}
	return json.Marshal(Envelope{Type: typ, Data: raw})
}

// onConnect pushes everything the client missed while offline.
func (h *Hub) onConnect(c *Client) {
	c.Send("hello", map[string]any{"user": briefOf(c.user)})
	status := h.recallStatus(c.user.ID)
	c.setStatus(status)
	h.broadcast("presence:update", map[string]any{"user_id": c.user.ID, "status": status}, nil)
	c.Send("presence:sync", map[string]any{"users": h.presenceList()})

	// Offline delivery: direct messages that were sent but never marked delivered.
	msgs, err := h.db.UndeliveredDirect(c.user.ID, 200)
	if err != nil {
		h.log.Error("ws: fetch undelivered", "user_id", c.user.ID, "err", err)
	} else if len(msgs) > 0 {
		now := time.Now().UTC().Format(time.RFC3339)
		toMark := make([]int64, 0, len(msgs))
		h.enrichBatch(msgs)
		for _, m := range msgs {
			if c.Send("message:new", map[string]any{"message": m}) {
				m.DeliveredAt = &now
				toMark = append(toMark, m.ID)
			}
		}
		if len(toMark) > 0 {
			if err := h.db.MarkDelivered(toMark, now); err != nil {
				h.log.Error("ws: mark delivered", "user_id", c.user.ID, "err", err)
			}
		}
		c.log.Info("ws: delivered offline messages", "count", len(msgs))
	}

	counts, groupCounts := h.unreadCounts(c.user.ID)
	c.Send("message:unread", map[string]any{"counts": counts, "group_counts": groupCounts})
}

func (h *Hub) unreadCounts(userID int64) (map[int64]int, map[int64]int) {
	counts, err := h.db.UnreadDirectCounts(userID)
	if err != nil {
		h.log.Error("ws: fetch unread direct counts", "user_id", userID, "err", err)
		counts = map[int64]int{}
	}
	groupCounts, err := h.db.GroupUnreadCounts(userID)
	if err != nil {
		h.log.Error("ws: fetch unread group counts", "user_id", userID, "err", err)
		groupCounts = map[int64]int{}
	}
	return counts, groupCounts
}

// syncUnread tells a user's other devices the current unread counts, so
// reading a chat on the phone clears its badge on the laptop too.
func (h *Hub) syncUnread(c *Client) {
	if len(h.allConns(c.user.ID)) < 2 {
		return
	}
	counts, groupCounts := h.unreadCounts(c.user.ID)
	h.sendToOthers(c, "message:unread", map[string]any{"counts": counts, "group_counts": groupCounts})
}

func (h *Hub) presenceList() []map[string]any {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make([]map[string]any, 0, len(h.clients))
	for id, c := range h.clients {
		out = append(out, map[string]any{"user_id": id, "status": c.status()})
	}
	return out
}

// GetPresence implements api.PresenceProvider.
func (h *Hub) GetPresence() map[int64]string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make(map[int64]string, len(h.clients))
	for id, c := range h.clients {
		out[id] = c.status()
	}
	return out
}

func (h *Hub) OnlineCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}

func (h *Hub) ActiveCalls() int {
	return h.p2p.count() + h.engine.RoomCount()
}

// KickUser force-disconnects a user (e.g. admin disabled / deleted the account).
// KickUser signs a connected user out right away. reason tells their app
// what to say: "suspended", "deleted", "password_changed" or "signed_out".
func (h *Hub) KickUser(userID int64, reason string) {
	h.callStateMu.Lock()
	defer h.callStateMu.Unlock()
	for _, c := range h.allConns(userID) {
		c.log.Info("ws: user signed out by the server", "reason", reason)
		c.Kick(reason)
	}
	h.cancelRoomLeave(userID)
	h.engine.Leave(userID)
	h.p2p.onDisconnect(userID)
}

// EvictFromGroupRoom removes targetID from the conference room bound to
// groupID, if they're currently in it — used when an admin/owner removes
// them from the group itself while a call for that group is in progress, so
// "removed from the group" actually means "off the call", not "still
// watching/listening until they personally hang up". Returns whether an
// eviction happened (false if they weren't on that call).
func (h *Hub) EvictFromGroupRoom(groupID, targetID int64) bool {
	h.callStateMu.Lock()
	defer h.callStateMu.Unlock()
	roomID := fmt.Sprintf("group:%d", groupID)
	h.sendToUser(targetID, "room:kicked", map[string]any{
		"room_id": roomID,
		"reason":  "removed-from-group",
	})
	h.cancelRoomLeave(targetID)
	return h.engine.LeaveRoom(roomID, targetID)
}

// CloseRoom forcibly ends a conference room, used when its owning group is
// deleted. It is serialized with joins so no participant can re-enter while
// the room is being torn down.
func (h *Hub) CloseRoom(roomID string) {
	h.callStateMu.Lock()
	defer h.callStateMu.Unlock()
	for _, userID := range h.engine.RoomUserIDs(roomID) {
		h.sendToUser(userID, "room:closed", map[string]any{
			"room_id": roomID,
			"reason":  "group-deleted",
		})
	}
	h.engine.CloseRoom(roomID)
}

// Close tears down all clients and rooms (graceful server shutdown).
func (h *Hub) Close() {
	h.closed.Store(true)
	h.callStateMu.Lock()
	h.mu.Lock()
	clients := make([]*Client, 0, len(h.clients))
	for id, c := range h.clients {
		clients = append(clients, c)
		clients = append(clients, h.extras[id]...)
	}
	h.clients = map[int64]*Client{}
	h.extras = map[int64][]*Client{}
	for userID, timer := range h.roomLeaveTimers {
		timer.Stop()
		delete(h.roomLeaveTimers, userID)
	}
	h.roomLeaveTokens = map[int64]uint64{}
	h.mu.Unlock()
	for _, c := range clients {
		c.close()
	}
	h.p2p.closeAll()
	h.engine.Close()
	h.passcodes.Stop()
	h.callStateMu.Unlock()
	h.log.Info("ws: hub closed")
}

func briefOf(u *db.User) *db.UserBrief {
	return &db.UserBrief{ID: u.ID, DisplayName: u.DisplayName, Username: u.Username, AvatarFileID: u.AvatarFileID}
}
