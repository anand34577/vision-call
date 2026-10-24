package sfu

import (
	"io"
	"log/slog"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/webrtc/v4"
)

// screenPendingTTL bounds how long a "screen share is starting" announcement
// stays valid while its track is still in flight. Without a bound, a client
// action that announces screen share but never actually publishes a track
// (a getDisplayMedia() the user cancelled, a renegotiation that silently
// failed) would leave the next unrelated camera track mislabeled as screen
// forever.
// subOfferTimeout is how long a subscriber offer may wait for its answer
// before a new one is allowed.
const subOfferTimeout = 10 * time.Second

const screenPendingTTL = 5 * time.Second

type Participant struct {
	room   *Room
	userID int64
	info   ParticipantInfo
	signal SignalFunc
	// advertiseIP is the server address this participant's browser used.
	advertiseIP string

	pub *webrtc.PeerConnection
	sub *webrtc.PeerConnection

	pubMu               sync.Mutex
	pubICEQueue         []ICE
	subMu               sync.Mutex
	subPending          bool
	subPendingAt        time.Time
	subNeedsRenegotiate bool
	// screenMu guards screenPending/screenPendingAt: set when the client's
	// track-state says screen share is starting, so the next published video
	// track is labeled screen rather than camera (browser track ids are
	// random, so the id alone can't identify it). This is deliberately only
	// ever cleared by onTrack consuming it or by its own TTL expiring — never
	// by a later "screen off" state message — so a rapid on/off/on toggle
	// can't have a late "off" message invalidate an announcement whose track
	// is already in flight over the wire and about to arrive.
	screenMu        sync.Mutex
	screenPending   bool
	screenPendingAt time.Time

	senders map[*webrtc.TrackLocalStaticRTP]*webrtc.RTPSender

	closeOnce sync.Once
	closed    atomic.Bool
	signalMu  sync.RWMutex
}

func (p *Participant) isClosed() bool { return p.closed.Load() }

// canResume reports whether the server-side peer connections can survive a
// signaling reconnect. A healthy client can keep the participant; a failed
// SFU peer needs a fresh participant so the client can rebuild both sides.
func (p *Participant) canResume() bool {
	if p.isClosed() {
		return false
	}
	p.pubMu.Lock()
	pub := p.pub
	p.pubMu.Unlock()
	if pub != nil && (pub.ConnectionState() == webrtc.PeerConnectionStateFailed || pub.ConnectionState() == webrtc.PeerConnectionStateClosed) {
		return false
	}
	p.subMu.Lock()
	sub := p.sub
	p.subMu.Unlock()
	return sub == nil || (sub.ConnectionState() != webrtc.PeerConnectionStateFailed && sub.ConnectionState() != webrtc.PeerConnectionStateClosed)
}

func (p *Participant) setSignal(signal SignalFunc) {
	p.signalMu.Lock()
	p.signal = signal
	p.signalMu.Unlock()
}

func (p *Participant) send(typ string, data any) {
	p.signalMu.RLock()
	signal := p.signal
	p.signalMu.RUnlock()
	if signal != nil {
		signal(typ, data)
	}
}

// resendSubscriberOffer recovers an offer that was created just before a
// signaling disconnect and never reached the browser. The pending flag is
// intentionally retained until the answer arrives.
func (p *Participant) resendSubscriberOffer() {
	p.subMu.Lock()
	if p.isClosed() || p.sub == nil || !p.subPending || p.sub.LocalDescription() == nil {
		p.subMu.Unlock()
		return
	}
	offer := *p.sub.LocalDescription()
	p.subMu.Unlock()
	p.send("sfu:sub-offer", offer)
}

// info is room-level state; read under room.mu.
func (p *Participant) infoSnapshot() ParticipantInfo {
	p.room.mu.Lock()
	defer p.room.mu.Unlock()
	return p.info
}

func (p *Participant) updateInfo(fn func(*ParticipantInfo)) {
	p.room.mu.Lock()
	if current := p.room.participants[p.userID]; current != p {
		p.room.mu.Unlock()
		return
	}
	fn(&p.info)
	info := p.info
	roomID := p.room.id
	p.room.mu.Unlock()
	p.room.engine.emit(Event{Kind: EventUpdated, RoomID: roomID, UserID: p.userID, Info: info})
}

func (p *Participant) createSubscriber() error {
	pc, err := p.room.engine.newPeer(p.advertiseIP)
	if err != nil {
		return err
	}
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c != nil {
			p.send("sfu:sub-ice", c.ToJSON())
		}
	})
	p.sub = pc
	return nil
}

// subscribeExisting wires all previously published room tracks into a new
// subscriber.
func (p *Participant) subscribeExisting(r *Room) {
	r.mu.Lock()
	var locals []*webrtc.TrackLocalStaticRTP
	for uid, byKey := range r.tracks {
		if uid == p.userID {
			continue
		}
		for _, pt := range byKey {
			locals = append(locals, pt.local)
		}
	}
	r.mu.Unlock()
	for _, l := range locals {
		p.addSender(l)
	}
}

func (p *Participant) addSender(local *webrtc.TrackLocalStaticRTP) {
	p.subMu.Lock()
	defer p.subMu.Unlock()
	if p.isClosed() || p.sub == nil {
		return
	}
	if _, exists := p.senders[local]; exists {
		return
	}
	sender, err := p.sub.AddTrack(local)
	if err != nil {
		return
	}
	// RTCP from this subscriber (NACKs, receiver reports) only reaches the
	// interceptors — which answer NACKs with retransmits — if someone reads
	// it. Without this loop lost packets are never repaired.
	go func() {
		buf := make([]byte, 1500)
		for {
			if _, _, err := sender.Read(buf); err != nil {
				return
			}
		}
	}()
	p.senders[local] = sender
	p.renegotiateSubLocked()
}

func (p *Participant) removeSender(local *webrtc.TrackLocalStaticRTP) {
	p.subMu.Lock()
	defer p.subMu.Unlock()
	if p.isClosed() || p.sub == nil {
		return
	}
	sender, exists := p.senders[local]
	if !exists {
		return
	}
	if err := p.sub.RemoveTrack(sender); err == nil {
		delete(p.senders, local)
		p.renegotiateSubLocked()
	}
}

// renegotiateSubLocked offers the subscriber PC; concurrent adds coalesce via
// subPending/subNeedsRenegotiate so we never overlap two offers.
// Caller holds subMu.
func (p *Participant) renegotiateSubLocked() {
	if p.isClosed() || p.sub == nil {
		return
	}
	if p.subPending {
		// A lost offer or failed answer must not block renegotiation forever.
		if time.Since(p.subPendingAt) < subOfferTimeout {
			p.subNeedsRenegotiate = true
			return
		}
		p.subPending = false
	}
	offer, err := p.sub.CreateOffer(nil)
	if err != nil {
		return
	}
	if err := p.sub.SetLocalDescription(offer); err != nil {
		return
	}
	p.subPending = true
	p.subPendingAt = time.Now()
	p.send("sfu:sub-offer", offer)
}

func (p *Participant) onSubAnswer(sdp SDP) {
	p.subMu.Lock()
	defer p.subMu.Unlock()
	if p.isClosed() || p.sub == nil || sdp.Type != webrtc.SDPTypeAnswer {
		return
	}
	if err := p.sub.SetRemoteDescription(sdp); err != nil {
		// That offer's tracks never got negotiated: offer again rather than
		// leaving them (and any queued changes) waiting for an unrelated change.
		p.subPending = false
		p.subNeedsRenegotiate = false
		p.renegotiateSubLocked()
		return
	}
	p.subPending = false
	if p.subNeedsRenegotiate {
		p.subNeedsRenegotiate = false
		p.renegotiateSubLocked()
	}
}

func (p *Participant) onSubICE(ice ICE) {
	p.subMu.Lock()
	defer p.subMu.Unlock()
	if !p.isClosed() && p.sub != nil {
		p.sub.AddICECandidate(ice)
	}
}

// onPubOffer answers a client publisher offer (initial and renegotiations,
// e.g. screen share added).
func (p *Participant) onPubOffer(sdp SDP) {
	p.pubMu.Lock()
	defer p.pubMu.Unlock()
	if p.isClosed() || sdp.Type != webrtc.SDPTypeOffer {
		return
	}
	if p.pub == nil {
		pc, err := p.room.engine.newPeer(p.advertiseIP)
		if err != nil {
			return
		}
		pc.OnICECandidate(func(c *webrtc.ICECandidate) {
			if c != nil {
				p.send("sfu:pub-ice", c.ToJSON())
			}
		})
		pc.OnTrack(p.onTrack)
		p.pub = pc
	}
	if err := p.pub.SetRemoteDescription(sdp); err != nil {
		p.send("error", map[string]string{"message": "invalid publisher offer"})
		return
	}
	// Candidates that arrived before the first offer can only be applied now
	// that a remote description exists (AddICECandidate rejects them before).
	for _, ice := range p.pubICEQueue {
		p.pub.AddICECandidate(ice)
	}
	p.pubICEQueue = nil
	answer, err := p.pub.CreateAnswer(nil)
	if err != nil {
		return
	}
	if err := p.pub.SetLocalDescription(answer); err != nil {
		return
	}
	p.send("sfu:pub-answer", answer)
}

func (p *Participant) onPubICE(ice ICE) {
	p.pubMu.Lock()
	defer p.pubMu.Unlock()
	if p.isClosed() {
		return
	}
	if p.pub == nil {
		if len(p.pubICEQueue) < 64 {
			p.pubICEQueue = append(p.pubICEQueue, ice)
		}
		return
	}
	p.pub.AddICECandidate(ice)
}

// trackKey maps an incoming track to its forwarding key. The client assigns
// track ids: "mic", "cam", "screen".
func trackKey(remote *webrtc.TrackRemote) string {
	if remote.Kind() == webrtc.RTPCodecTypeAudio {
		return "mic"
	}
	if remote.ID() == "screen" {
		return "screen"
	}
	return "cam"
}

func (p *Participant) onTrack(remote *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
	if p.isClosed() {
		return
	}
	key := trackKey(remote)
	if key == "cam" {
		p.screenMu.Lock()
		pending := p.screenPending && time.Since(p.screenPendingAt) < screenPendingTTL
		if pending {
			p.screenPending = false
		}
		p.screenMu.Unlock()
		if pending {
			// the client announces screen share (sfu:track-state) right before
			// publishing it, because browser track ids cannot be set to "screen"
			key = "screen"
		}
	}
	if key == "screen" && !p.infoSnapshot().CanPresent {
		// Defense in depth: onTrackState is the normal gate (it never sets
		// screenPending for a non-presenter), but a client that skips
		// straight to publishing a track it labeled "screen" would otherwise
		// still get forwarded. Drop it here too instead of trusting the
		// announcement alone.
		return
	}
	local, err := webrtc.NewTrackLocalStaticRTP(
		remote.Codec().RTPCodecCapability, key, strconv.FormatInt(p.userID, 10))
	if err != nil {
		return
	}
	pt := &publishedTrack{
		local: local,
		key:   key,
	}
	p.room.publish(p, key, pt)
	switch key {
	case "cam":
		p.updateInfo(func(i *ParticipantInfo) { i.VideoOn = true })
	case "screen":
		p.updateInfo(func(i *ParticipantInfo) { i.Screen = true })
	}
	go p.forward(remote, local, key, pt)
}

// forward pumps RTP from the publisher track into the forwarding track until
// the stream ends, then unpublishes.
func (p *Participant) forward(remote *webrtc.TrackRemote, local *webrtc.TrackLocalStaticRTP, key string, pt *publishedTrack) {
	defer func() {
		// This runs in its own goroutine per published track (started from
		// onTrack) with nothing above it to recover — an unrecovered panic
		// here would take down every active call on the server, not just
		// this one track.
		if r := recover(); r != nil {
			slog.Default().Error("sfu: panic forwarding track", "key", key, "userID", p.userID, "panic", r)
		}
	}()
	buf := make([]byte, 1500)
	for {
		n, _, err := remote.Read(buf)
		if err != nil {
			break
		}
		if _, err := local.Write(buf[:n]); err != nil {
			if err == io.ErrClosedPipe {
				break
			}
		}
	}
	if !p.room.unpublish(p.userID, key, pt) {
		return
	}
	switch key {
	case "screen":
		p.updateInfo(func(i *ParticipantInfo) { i.Screen = false })
	case "cam":
		p.updateInfo(func(i *ParticipantInfo) { i.VideoOn = false })
	case "mic":
		p.updateInfo(func(i *ParticipantInfo) { i.Muted = true })
	}
}

// onTrackState applies client mute/camera/screen toggles. Turning screen
// sharing off removes its forwarding track everywhere.
func (p *Participant) onTrackState(st TrackState) {
	info := p.infoSnapshot()
	if st.Screen && !info.Screen {
		if !info.CanPresent {
			// Room is presenter-only and this participant isn't the host or
			// an approved presenter — refuse the announcement so onTrack
			// never labels their next video track "screen".
			p.send("error", map[string]string{"message": "only the host or an approved presenter can share their screen"})
			st.Screen = false
		} else {
			// screen starts via publisher renegotiation, not here
			p.screenMu.Lock()
			p.screenPending = true
			p.screenPendingAt = time.Now()
			p.screenMu.Unlock()
		}
	}
	// Deliberately does not clear screenPending here (see its doc comment) -
	// a still-pending announcement is left for onTrack to consume or for its
	// own TTL to expire, so a quick on/off/on toggle can't have this "off"
	// message invalidate an announcement whose track is already in flight.
	if !st.Screen && info.Screen {
		p.room.unpublish(p.userID, "screen", nil)
	}
	if !st.Muted && info.Muted {
		if p.room.isLocked(p.userID) {
			// Host has locked this mute; a self-unmute request is ignored
			// server-side until the host unlocks it (see room:unlock-request).
			p.send("error", map[string]string{"message": "the host has locked your microphone"})
			st.Muted = true
		} else {
			// Restores forwarding whether this mic was force-muted by the host
			// (mutedTracks has it) or just self-muted (no-op, nothing to restore).
			p.room.restoreMic(p.userID)
		}
	}
	p.updateInfo(func(i *ParticipantInfo) {
		i.Muted = st.Muted
		i.VideoOn = st.VideoOn
		i.Screen = st.Screen
	})
}

func (p *Participant) close() {
	p.closeOnce.Do(func() {
		p.subMu.Lock()
		p.closed.Store(true)
		p.subMu.Unlock()
		p.pubMu.Lock()
		if p.pub != nil {
			p.pub.Close()
		}
		p.pubMu.Unlock()
		p.subMu.Lock()
		if p.sub != nil {
			p.sub.Close()
		}
		p.subMu.Unlock()
	})
}
