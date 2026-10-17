package sfu

import (
	"sync"

	"github.com/pion/webrtc/v4"
)

// publishedTrack is one incoming publisher track being forwarded.
type publishedTrack struct {
	local *webrtc.TrackLocalStaticRTP
	key   string // mic | cam | screen
}

type Room struct {
	id     string
	engine *Engine
	mu     sync.Mutex
	// order preserves join sequence for stable participant lists
	order        []int64
	participants map[int64]*Participant
	// userID -> track key -> published track
	tracks map[int64]map[string]*publishedTrack
	// userID -> track key -> published track currently withheld from
	// forwarding by forceMuteMic (host mute enforcement). Kept separate from
	// tracks so a later restoreMic can re-publish the same track without
	// waiting for the publisher to renegotiate.
	mutedTracks map[int64]map[string]*publishedTrack
	// locked holds userIDs whose force-mute the host has additionally locked:
	// onTrackState refuses to restore their mic on a self-unmute request
	// until the host calls unlock. Absent/false = not locked.
	locked map[int64]bool
	// presenterOnly, when set, restricts screen-share to the host plus
	// whoever's in presenters. Both start zero-valued (off / empty), meaning
	// "anyone can present" — today's default behavior.
	presenterOnly bool
	presenters    map[int64]bool
}

func newRoom(id string, e *Engine) *Room {
	return &Room{
		id:           id,
		engine:       e,
		participants: map[int64]*Participant{},
		tracks:       map[int64]map[string]*publishedTrack{},
		mutedTracks:  map[int64]map[string]*publishedTrack{},
		locked:       map[int64]bool{},
		presenters:   map[int64]bool{},
	}
}

// canPresentLocked reports whether userID may currently start screen share.
// Caller must hold r.mu.
func (r *Room) canPresentLocked(userID int64, isHost bool) bool {
	if isHost || !r.presenterOnly {
		return true
	}
	return r.presenters[userID]
}

func (r *Room) isLocked(userID int64) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.locked[userID]
}

func (r *Room) setLocked(userID int64, lock bool) {
	r.mu.Lock()
	if lock {
		r.locked[userID] = true
	} else {
		delete(r.locked, userID)
	}
	r.mu.Unlock()
}

// setPresenterOnly toggles the room-wide restriction, recomputes every
// participant's CanPresent, and emits an update for each so the change
// actually reaches everyone (not just the toggling host).
func (r *Room) setPresenterOnly(enabled bool) {
	r.mu.Lock()
	r.presenterOnly = enabled
	out := make([]ParticipantInfo, 0, len(r.participants))
	for _, p := range r.participants {
		p.info.CanPresent = r.canPresentLocked(p.userID, p.info.Host)
		out = append(out, p.info)
	}
	roomID := r.id
	r.mu.Unlock()
	for _, info := range out {
		r.engine.emit(Event{Kind: EventUpdated, RoomID: roomID, UserID: info.UserID, Info: info})
	}
}

// participant returns the member under room.mu; callers outside this package's
// internal locking must use it instead of touching the map directly.
func (r *Room) participant(userID int64) *Participant {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.participants[userID]
}

func (r *Room) snapshotLocked() []ParticipantInfo {
	out := make([]ParticipantInfo, 0, len(r.order))
	for _, uid := range r.order {
		if p, ok := r.participants[uid]; ok {
			out = append(out, p.info)
		}
	}
	return out
}

// isEmptyThenDelete removes an empty room from the engine; caller learns
// whether deletion happened so it can emit the closed event.
func (r *Room) isEmptyThenDelete() bool {
	r.engine.mu.Lock()
	defer r.engine.mu.Unlock()
	if r.engine.rooms[r.id] != r {
		return false
	}
	r.mu.Lock()
	empty := len(r.participants) == 0
	r.mu.Unlock()
	if !empty {
		return false
	}
	delete(r.engine.rooms, r.id)
	return true
}

// remove tears down a participant: closes its PCs, un-forwards its tracks,
// emits left, promotes a new host when the host leaves, and closes the room
// when the last person leaves.
func (r *Room) remove(userID int64) {
	r.mu.Lock()
	p := r.participants[userID]
	if p == nil {
		r.mu.Unlock()
		return
	}
	wasHost := p.info.Host
	delete(r.participants, userID)
	// rebuild join order without this user
	order := make([]int64, 0, len(r.order))
	for _, uid := range r.order {
		if uid != userID {
			order = append(order, uid)
		}
	}
	r.order = order
	published := r.tracks[userID]
	delete(r.tracks, userID)
	delete(r.mutedTracks, userID)
	delete(r.locked, userID)
	delete(r.presenters, userID)
	others := make([]*Participant, 0, len(r.participants))
	for _, op := range r.participants {
		others = append(others, op)
	}
	// host role moves to the earliest remaining joiner so mute-others keeps working
	var promotedInfo *ParticipantInfo
	if wasHost && len(order) > 0 {
		if np, ok := r.participants[order[0]]; ok {
			np.info.Host = true
			np.info.CanPresent = r.canPresentLocked(order[0], true)
			info := np.info
			promotedInfo = &info
		}
	}
	r.mu.Unlock()
	r.engine.releaseUser(userID, r)

	p.close()

	for _, op := range others {
		for _, pt := range published {
			op.removeSender(pt.local)
		}
	}

	r.engine.emit(Event{Kind: EventLeft, RoomID: r.id, UserID: userID})
	if promotedInfo != nil {
		r.engine.emit(Event{Kind: EventUpdated, RoomID: r.id, UserID: promotedInfo.UserID, Info: *promotedInfo})
	}
	if deleted := r.isEmptyThenDelete(); deleted {
		r.engine.emit(Event{Kind: EventRoomClosed, RoomID: r.id})
	}
}

func (r *Room) closeAll() {
	r.mu.Lock()
	members := make([]*Participant, 0, len(r.participants))
	for _, p := range r.participants {
		members = append(members, p)
	}
	r.participants = map[int64]*Participant{}
	r.tracks = map[int64]map[string]*publishedTrack{}
	r.mutedTracks = map[int64]map[string]*publishedTrack{}
	r.mu.Unlock()
	for _, p := range members {
		p.close()
	}
}

// publish registers a forwarding track for uid and fans it out to others.
// Called from the publisher's OnTrack.
func (r *Room) publish(p *Participant, key string, pt *publishedTrack) {
	r.mu.Lock()
	if current := r.participants[p.userID]; current != p || p.isClosed() {
		r.mu.Unlock()
		return
	}
	if key == "mic" && r.locked[p.userID] {
		// Host-locked mute: a freshly published mic (e.g. the client
		// renegotiated a new audio track) is parked with the force-muted
		// tracks instead of forwarded, so re-publishing can't bypass the lock.
		if r.mutedTracks[p.userID] == nil {
			r.mutedTracks[p.userID] = map[string]*publishedTrack{}
		}
		r.mutedTracks[p.userID]["mic"] = pt
		previous := r.tracks[p.userID]["mic"]
		delete(r.tracks[p.userID], "mic")
		others := r.othersLocked(p.userID)
		r.mu.Unlock()
		if previous != nil {
			for _, op := range others {
				op.removeSender(previous.local)
			}
		}
		return
	}
	if r.tracks[p.userID] == nil {
		r.tracks[p.userID] = map[string]*publishedTrack{}
	}
	previous := r.tracks[p.userID][key]
	r.tracks[p.userID][key] = pt
	others := make([]*Participant, 0, len(r.participants))
	for uid, op := range r.participants {
		if uid != p.userID {
			others = append(others, op)
		}
	}
	r.mu.Unlock()

	for _, op := range others {
		if previous != nil {
			op.removeSender(previous.local)
		}
		op.addSender(pt.local)
	}
}

// othersLocked lists every participant except userID. Caller holds r.mu.
func (r *Room) othersLocked(userID int64) []*Participant {
	out := make([]*Participant, 0, len(r.participants))
	for uid, op := range r.participants {
		if uid != userID {
			out = append(out, op)
		}
	}
	return out
}

// unpublish stops forwarding one track (e.g. screen share stopped).
func (r *Room) unpublish(userID int64, key string, expected *publishedTrack) bool {
	r.mu.Lock()
	tracks := r.tracks[userID]
	pt := tracks[key]
	if pt == nil || (expected != nil && pt != expected) {
		r.mu.Unlock()
		return false
	}
	delete(tracks, key)
	others := make([]*Participant, 0, len(r.participants))
	for uid, op := range r.participants {
		if uid != userID {
			others = append(others, op)
		}
	}
	r.mu.Unlock()
	for _, op := range others {
		op.removeSender(pt.local)
	}
	return true
}

// forceMuteMic stops forwarding userID's mic track to everyone else without
// ending the underlying publisher stream, so a later unmute can restore audio
// without a renegotiation round-trip. This is what makes a host mute actually
// enforced instead of merely advisory: a modified client that ignores the
// "room:muted" message still goes silent to everyone else, because the
// server stops relaying its packets — it isn't waiting for the client's
// cooperation. No-ops if the mic isn't currently published (e.g. the
// participant joined audio-off).
func (r *Room) forceMuteMic(userID int64) {
	r.mu.Lock()
	pt := r.tracks[userID]["mic"]
	if pt == nil {
		r.mu.Unlock()
		return
	}
	delete(r.tracks[userID], "mic")
	if r.mutedTracks[userID] == nil {
		r.mutedTracks[userID] = map[string]*publishedTrack{}
	}
	r.mutedTracks[userID]["mic"] = pt
	others := make([]*Participant, 0, len(r.participants))
	for uid, op := range r.participants {
		if uid != userID {
			others = append(others, op)
		}
	}
	r.mu.Unlock()
	for _, op := range others {
		op.removeSender(pt.local)
	}
}

// restoreMic re-publishes a mic track previously withheld by forceMuteMic.
// A participant unmuting themselves (which is allowed — a host mute is a
// one-shot nudge, not a permanent lock, matching typical conferencing UX)
// goes through here. No-op if the mic was never force-muted (a plain
// client-side self-mute never touches mutedTracks).
func (r *Room) restoreMic(userID int64) {
	r.mu.Lock()
	pt := r.mutedTracks[userID]["mic"]
	if pt == nil {
		r.mu.Unlock()
		return
	}
	delete(r.mutedTracks[userID], "mic")
	if r.tracks[userID] == nil {
		r.tracks[userID] = map[string]*publishedTrack{}
	}
	r.tracks[userID]["mic"] = pt
	others := make([]*Participant, 0, len(r.participants))
	for uid, op := range r.participants {
		if uid != userID {
			others = append(others, op)
		}
	}
	r.mu.Unlock()
	for _, op := range others {
		op.addSender(pt.local)
	}
}
