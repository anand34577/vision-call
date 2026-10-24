// Package sfu implements a small Selective Forwarding Unit on pion/webrtc.
// Each participant maintains two PeerConnections to the server:
//
//	publisher  (client -> SFU): client creates offers; SFU answers.
//	subscriber (SFU -> client): SFU creates offers when tracks are
//	                           added/removed; client answers.
//
// Splitting directions avoids offer collisions; only the publisher ever
// renegotiates from the client side and only the subscriber from the server.
package sfu

import (
	"errors"
	"log/slog"
	"net"
	"sync"

	"github.com/pion/ice/v4"
	"github.com/pion/interceptor"
	"github.com/pion/interceptor/pkg/intervalpli"
	"github.com/pion/webrtc/v4"
)

type Config struct {
	MaxParticipants int
	// ExternalIP, when set, is the address advertised to every participant.
	ExternalIP string
	// FallbackIP is advertised when neither ExternalIP nor the address the
	// participant used to reach the server is known (the auto-detected LAN IP).
	FallbackIP string
	// UDPPort, when above zero, carries all SFU media over this one UDP port,
	// so a firewall rule or `docker run -p` only has to cover a single port.
	UDPPort int
}

const (
	EventRoomCreated = "created"
	EventJoined      = "joined"
	EventLeft        = "left"
	EventUpdated     = "updated"
	EventRoomClosed  = "closed"
)

// ParticipantInfo is the room-level state broadcast to everyone.
type ParticipantInfo struct {
	UserID       int64  `json:"user_id"`
	DisplayName  string `json:"display_name"`
	AvatarFileID *int64 `json:"avatar_file_id"`
	Muted        bool   `json:"muted"`
	VideoOn      bool   `json:"video_on"`
	Screen       bool   `json:"screen"`
	Host         bool   `json:"host"`
	// Locked is true once the host has force-muted this participant with the
	// lock flag: unlike a plain force-mute (a one-shot nudge the participant
	// can undo by unmuting themselves), a locked mute is rejected server-side
	// until the host explicitly unlocks it — see Room.locked / onTrackState.
	Locked bool `json:"locked"`
	// CanPresent is false only when the room is in presenter-only mode and
	// this participant isn't the host and hasn't been granted presenter
	// rights — see Room.presenterOnly/presenters.
	CanPresent bool `json:"can_present"`
}

// Event is emitted (outside internal locks) to the owning application.
type Event struct {
	Kind         string            `json:"kind"`
	RoomID       string            `json:"room_id"`
	UserID       int64             `json:"user_id"`
	Info         ParticipantInfo   `json:"info"`
	Participants []ParticipantInfo `json:"participants,omitempty"`
}

// SignalFunc delivers a WS message to one client.
type SignalFunc func(typ string, data any)

// SDP is the wire form of a session description (pion-native JSON).
type SDP = webrtc.SessionDescription

// ICE is the wire form of a trickle candidate.
type ICE = webrtc.ICECandidateInit

// TrackState carries mute/camera/screen toggles that don't need renegotiation.
type TrackState struct {
	Muted   bool `json:"muted"`
	VideoOn bool `json:"video_on"`
	Screen  bool `json:"screen"`
}

var (
	ErrRoomFull      = errors.New("room is full")
	ErrAlreadyInRoom = errors.New("user is already in another room")
)

type Engine struct {
	cfg     Config
	mu      sync.Mutex
	rooms   map[string]*Room
	users   map[int64]*Room
	OnEvent func(Event)
	log     *slog.Logger
	udpMux  *ice.UDPMuxDefault // nil when media uses random ports
}

func NewEngine(cfg Config, logs ...*slog.Logger) *Engine {
	log := slog.Default()
	if len(logs) > 0 && logs[0] != nil {
		log = logs[0]
	}
	e := &Engine{cfg: cfg, rooms: map[string]*Room{}, users: map[int64]*Room{}, log: log}
	if cfg.UDPPort > 0 {
		conn, err := net.ListenUDP("udp", &net.UDPAddr{Port: cfg.UDPPort})
		if err != nil {
			log.Warn("sfu: cannot bind WebRTC UDP port, falling back to random ports", "port", cfg.UDPPort, "err", err)
		} else {
			e.udpMux = ice.NewUDPMuxDefault(ice.UDPMuxParams{UDPConn: conn})
			log.Info("sfu: media on a single UDP port", "port", cfg.UDPPort)
		}
	}
	return e
}

func (e *Engine) emit(ev Event) {
	if e.OnEvent != nil {
		e.OnEvent(ev)
	}
}

// Join adds a user to a room (creating it when absent). With resume=true and a
// live participant for the same user (brief WS drop), the existing peer
// connections are kept and only the signal callback is swapped.
//
// advertiseIP is the server address this participant's browser connected
// to; see newPeer.
func (e *Engine) Join(roomID string, userID int64, displayName string, avatarFileID *int64, video bool, resume bool, advertiseIP string, signal SignalFunc) ([]ParticipantInfo, error) {
	for {
		// Engine membership is reserved while the room lock is held. This makes
		// concurrent joins for one user deterministic across different rooms.
		e.mu.Lock()
		room := e.rooms[roomID]
		created := false
		if room == nil {
			room = newRoom(roomID, e)
			e.rooms[roomID] = room
			created = true
		}
		if existing := e.users[userID]; existing != nil && existing != room {
			if created {
				delete(e.rooms, roomID)
			}
			e.mu.Unlock()
			return nil, ErrAlreadyInRoom
		}

		room.mu.Lock()
		if old := room.participants[userID]; old != nil {
			if resume && old.canResume() {
				old.setSignal(signal)
				parts := room.snapshotLocked()
				room.mu.Unlock()
				e.mu.Unlock()
				e.log.Debug("sfu: participant resumed", "room_id", roomID, "user_id", userID)
				signal("room:joined", map[string]any{"room_id": roomID, "participants": parts, "resumed": true})
				old.resendSubscriberOffer()
				return parts, nil
			}
			room.mu.Unlock()
			e.mu.Unlock()
			e.log.Debug("sfu: dropping stale participant before rejoin", "room_id", roomID, "user_id", userID, "resume", resume)
			room.drop(userID, false) // page reload: drop stale participant, keep the room
			continue
		}
		if len(room.participants) >= e.cfg.MaxParticipants {
			if created && e.rooms[roomID] == room {
				delete(e.rooms, roomID)
			}
			room.mu.Unlock()
			e.mu.Unlock()
			e.log.Warn("sfu: room full", "room_id", roomID, "max", e.cfg.MaxParticipants)
			return nil, ErrRoomFull
		}
		p := &Participant{
			room:        room,
			userID:      userID,
			signal:      signal,
			advertiseIP: advertiseIP,
			senders:     map[*webrtc.TrackLocalStaticRTP]*webrtc.RTPSender{},
			info: ParticipantInfo{
				UserID:       userID,
				DisplayName:  displayName,
				AvatarFileID: avatarFileID,
				VideoOn:      video,
			},
		}
		if len(room.participants) == 0 {
			p.info.Host = true
		}
		p.info.CanPresent = room.canPresentLocked(userID, p.info.Host)
		if err := p.createSubscriber(); err != nil {
			if created && e.rooms[roomID] == room {
				delete(e.rooms, roomID)
			}
			room.mu.Unlock()
			e.mu.Unlock()
			e.log.Error("sfu: create subscriber PeerConnection", "room_id", roomID, "user_id", userID, "err", err)
			// A room kept open for this rejoin must not linger empty.
			if !created && room.isEmptyThenDelete() {
				e.emit(Event{Kind: EventRoomClosed, RoomID: roomID})
			}
			return nil, err
		}
		e.users[userID] = room
		room.participants[userID] = p
		room.order = append(room.order, userID)
		parts := room.snapshotLocked()
		info := p.info
		room.mu.Unlock()
		e.mu.Unlock()

		if created {
			e.log.Info("sfu: room created", "room_id", roomID, "creator", userID)
			e.emit(Event{Kind: EventRoomCreated, RoomID: roomID, UserID: userID})
		}
		// Immediately deliver existing room tracks to the newcomer.
		p.subscribeExisting(room)

		e.log.Info("sfu: participant joined", "room_id", roomID, "user_id", userID, "total", len(parts))
		signal("room:joined", map[string]any{"room_id": roomID, "participants": parts, "resumed": false})
		e.emit(Event{Kind: EventJoined, RoomID: roomID, UserID: userID, Info: info, Participants: parts})
		return parts, nil
	}
}

// Leave removes the user from whatever room they are in.
func (e *Engine) Leave(userID int64) {
	if room := e.roomForUser(userID); room != nil {
		room.remove(userID)
		return
	}
	// Defensive fallback for state created before the membership index existed.
	e.mu.Lock()
	rooms := make([]*Room, 0, len(e.rooms))
	for _, r := range e.rooms {
		rooms = append(rooms, r)
	}
	e.mu.Unlock()
	for _, r := range rooms {
		if r.participant(userID) != nil {
			r.remove(userID)
			return
		}
	}
}

func (e *Engine) roomForUser(userID int64) *Room {
	e.mu.Lock()
	if room := e.users[userID]; room != nil {
		e.mu.Unlock()
		return room
	}
	rooms := make([]*Room, 0, len(e.rooms))
	for _, r := range e.rooms {
		rooms = append(rooms, r)
	}
	e.mu.Unlock()
	for _, r := range rooms {
		if r.participant(userID) != nil {
			return r
		}
	}
	return nil
}

func (e *Engine) releaseUser(userID int64, room *Room) {
	e.mu.Lock()
	if e.users[userID] == room {
		delete(e.users, userID)
	}
	e.mu.Unlock()
}

// UserInRoom reports whether the user currently occupies a conference room.
func (e *Engine) UserInRoom(userID int64) bool { return e.roomForUser(userID) != nil }

// RoomIDForUser reports the id of the room userID actually occupies, so
// callers can validate a client-supplied room_id against reality before
// broadcasting to it (a client can claim any room_id in a message; only the
// engine's own membership index says which room they're really in).
func (e *Engine) RoomIDForUser(userID int64) (string, bool) {
	room := e.roomForUser(userID)
	if room == nil {
		return "", false
	}
	return room.id, true
}

// RoomUserIDs lists current members of a room.
func (e *Engine) RoomUserIDs(roomID string) []int64 {
	e.mu.Lock()
	r := e.rooms[roomID]
	e.mu.Unlock()
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]int64, 0, len(r.order))
	for _, uid := range r.order {
		if _, ok := r.participants[uid]; ok {
			out = append(out, uid)
		}
	}
	return out
}

func (e *Engine) RoomCount() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.rooms)
}

// LeaveRoom removes userID only if they are currently in exactly this room -
// unlike Leave, which removes them from whatever room they happen to be in.
// Used for targeted eviction (e.g. a group member being removed) where the
// caller must not accidentally kick someone from an unrelated room they may
// have since joined. Returns whether a removal actually happened.
func (e *Engine) LeaveRoom(roomID string, userID int64) bool {
	e.mu.Lock()
	room := e.rooms[roomID]
	e.mu.Unlock()
	if room == nil || room.participant(userID) == nil {
		return false
	}
	room.remove(userID)
	return true
}

// CloseRoom removes every participant from one room. Callers that need to
// coordinate room state with another subsystem should serialize around this
// operation; the engine itself still keeps its room maps consistent.
func (e *Engine) CloseRoom(roomID string) {
	for _, userID := range e.RoomUserIDs(roomID) {
		e.Leave(userID)
	}
}

func (e *Engine) lookup(userID int64) *Participant {
	if room := e.roomForUser(userID); room != nil {
		return room.participant(userID)
	}
	return nil
}

// ---- signaling entry points ----

func (e *Engine) HandlePubOffer(userID int64, sdp SDP) {
	if p := e.lookup(userID); p != nil {
		p.onPubOffer(sdp)
	}
}

func (e *Engine) HandlePubICE(userID int64, ice ICE) {
	if p := e.lookup(userID); p != nil {
		p.onPubICE(ice)
	}
}

func (e *Engine) HandleSubAnswer(userID int64, sdp SDP) {
	if p := e.lookup(userID); p != nil {
		p.onSubAnswer(sdp)
	}
}

func (e *Engine) HandleSubICE(userID int64, ice ICE) {
	if p := e.lookup(userID); p != nil {
		p.onSubICE(ice)
	}
}

func (e *Engine) HandleTrackState(userID int64, st TrackState) {
	if p := e.lookup(userID); p != nil {
		p.onTrackState(st)
	}
}

// requireHost looks up the requester and checks they're the room host (or an
// admin), returning the requester and target participants when both exist in
// the same room. Shared by every host-only control below.
func (e *Engine) requireHost(requesterID, targetID int64, isAdmin bool) (requester, target *Participant, ok bool) {
	p := e.lookup(requesterID)
	if p == nil || (!p.infoSnapshot().Host && !isAdmin) {
		return nil, nil, false
	}
	t := e.lookup(targetID)
	if t == nil || t.room.id != p.room.id {
		return nil, nil, false
	}
	return p, t, true
}

// MuteRequest lets the room host (or an admin) force-mute a participant.
// With lock=true, the mute additionally can't be undone by the participant
// unmuting themselves (see Room.locked) until a later UnlockRequest.
func (e *Engine) MuteRequest(requesterID, targetID int64, isAdmin, lock bool) bool {
	_, t, ok := e.requireHost(requesterID, targetID, isAdmin)
	if !ok {
		return false
	}
	t.send("room:muted", map[string]any{"by": requesterID, "locked": lock})
	t.updateInfo(func(i *ParticipantInfo) { i.Muted = true; i.Locked = lock })
	t.room.forceMuteMic(targetID) // server-side enforcement, not just a client-trusted request
	if lock {
		t.room.setLocked(targetID, true)
	}
	return true
}

// UnlockRequest releases a previous lock=true mute, letting the participant
// unmute themselves again. Audio stays off until they actually do.
func (e *Engine) UnlockRequest(requesterID, targetID int64, isAdmin bool) bool {
	_, t, ok := e.requireHost(requesterID, targetID, isAdmin)
	if !ok {
		return false
	}
	t.room.setLocked(targetID, false)
	t.updateInfo(func(i *ParticipantInfo) { i.Locked = false })
	t.send("room:unlocked", map[string]any{"by": requesterID})
	return true
}

// KickRequest removes a participant from the call on the host's behalf.
func (e *Engine) KickRequest(requesterID, targetID int64, isAdmin bool) bool {
	p := e.lookup(requesterID)
	if p == nil || (!p.infoSnapshot().Host && !isAdmin) {
		return false
	}
	t := e.lookup(targetID)
	if t == nil || t.room.id != p.room.id {
		return false
	}
	t.send("room:removed", map[string]any{"by": requesterID})
	t.room.remove(targetID)
	return true
}

// ClaimHost makes userID the room's host, demoting whoever held it. Used when
// the room's owner joins after someone else already got host by joining first.
func (e *Engine) ClaimHost(roomID string, userID int64) {
	e.mu.Lock()
	room := e.rooms[roomID]
	e.mu.Unlock()
	if room == nil {
		return
	}
	room.mu.Lock()
	if room.participants[userID] == nil || room.participants[userID].info.Host {
		room.mu.Unlock()
		return
	}
	var changed []ParticipantInfo
	for uid, p := range room.participants {
		isHost := uid == userID
		if p.info.Host != isHost {
			p.info.Host = isHost
			p.info.CanPresent = room.canPresentLocked(uid, isHost)
			changed = append(changed, p.info)
		}
	}
	room.mu.Unlock()
	for _, info := range changed {
		e.emit(Event{Kind: EventUpdated, RoomID: roomID, UserID: info.UserID, Info: info})
	}
}

// SetPresenterOnly toggles a room's presenter-only restriction. Every
// participant's updated info is broadcast via the usual EventUpdated path.
func (e *Engine) SetPresenterOnly(requesterID int64, enabled, isAdmin bool) bool {
	p := e.lookup(requesterID)
	if p == nil || (!p.infoSnapshot().Host && !isAdmin) {
		return false
	}
	p.room.setPresenterOnly(enabled)
	return true
}

// SetPresenter grants or revokes one participant's exception to
// presenter-only mode.
func (e *Engine) SetPresenter(requesterID, targetID int64, allowed, isAdmin bool) bool {
	_, t, ok := e.requireHost(requesterID, targetID, isAdmin)
	if !ok {
		return false
	}
	t.updateInfo(func(i *ParticipantInfo) {
		if allowed {
			t.room.presenters[targetID] = true
		} else {
			delete(t.room.presenters, targetID)
		}
		i.CanPresent = t.room.canPresentLocked(targetID, i.Host)
	})
	return true
}

// Close tears down every room (server shutdown).
func (e *Engine) Close() {
	e.mu.Lock()
	rooms := make([]*Room, 0, len(e.rooms))
	for _, r := range e.rooms {
		rooms = append(rooms, r)
	}
	e.rooms = map[string]*Room{}
	e.users = map[int64]*Room{}
	e.mu.Unlock()
	for _, r := range rooms {
		r.closeAll()
	}
	if e.udpMux != nil {
		_ = e.udpMux.Close()
	}
	e.log.Info("sfu: engine closed", "rooms_closed", len(rooms))
}

// newPeer builds a PeerConnection with default codecs/interceptors and, when
// configured, a 1:1 NAT address so ICE advertises the LAN/VPN IP instead of an
// internal container address. intervalpli keeps asking publishers for
// keyframes so late joiners and recovered decoders get clean pictures.
func (e *Engine) newPeer(advertiseIP string) (*webrtc.PeerConnection, error) {
	me := &webrtc.MediaEngine{}
	if err := me.RegisterDefaultCodecs(); err != nil {
		e.log.Error("sfu: register codecs", "err", err)
		return nil, err
	}
	ir := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(me, ir); err != nil {
		e.log.Error("sfu: register interceptors", "err", err)
		return nil, err
	}
	pli, err := intervalpli.NewReceiverInterceptor()
	if err != nil {
		e.log.Error("sfu: create PLI interceptor", "err", err)
		return nil, err
	}
	ir.Add(pli)
	se := webrtc.SettingEngine{}
	// Advertise one address the browser can reach. An explicit EXTERNAL_IP
	// wins; otherwise use the address the browser already reached over HTTP,
	// which is right even inside a Docker bridge network where the server
	// only sees its container IP.
	ip := e.cfg.ExternalIP
	if ip == "" {
		ip = advertiseIP
	}
	if ip == "" {
		ip = e.cfg.FallbackIP
	}
	if ip != "" {
		se.SetNAT1To1IPs([]string{ip}, webrtc.ICECandidateTypeHost)
	}
	if e.udpMux != nil {
		se.SetICEUDPMux(e.udpMux)
	}
	api := webrtc.NewAPI(
		webrtc.WithMediaEngine(me),
		webrtc.WithInterceptorRegistry(ir),
		webrtc.WithSettingEngine(se),
	)
	return api.NewPeerConnection(webrtc.Configuration{})
}
