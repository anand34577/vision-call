package signaling

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"sync"
	"time"

	"visioncall/internal/db"
)

const ringTimeout = 45 * time.Second

// p2pManager tracks 1:1 call lifecycles and relays WebRTC signaling between
// the two peers. Media itself flows directly between peers.
type p2pManager struct {
	hub *Hub
	mu  sync.Mutex
	// callID -> call
	calls map[string]*p2pCall
	// userID -> callID for both parties
	byUser map[int64]string
	// userID -> pending "end their call unless they resume" timer, armed when
	// their socket drops (see scheduleDisconnect).
	grace map[int64]*time.Timer
}

// p2pResumeGrace is how long a 1:1 call survives its signaling socket
// dropping. Media flows peer-to-peer and keeps working meanwhile; the client
// reconnects and sends call:resume to keep the call.
const p2pResumeGrace = 15 * time.Second

type p2pCall struct {
	id       string
	callerID int64
	calleeID int64
	dbID     int64
	state    string // ringing | active | ended
	timer    *time.Timer
}

func newP2PManager(h *Hub) *p2pManager {
	return &p2pManager{hub: h, calls: map[string]*p2pCall{}, byUser: map[int64]string{}, grace: map[int64]*time.Timer{}}
}

func newCallID() string {
	buf := make([]byte, 12)
	if _, err := rand.Read(buf); err != nil {
		return "p2p-" + hex.EncodeToString([]byte(time.Now().UTC().Format(time.RFC3339Nano)))
	}
	return "p2p-" + hex.EncodeToString(buf)
}

func (m *p2pManager) get(callID string) *p2pCall {
	m.mu.Lock()
	call := m.calls[callID]
	if call == nil {
		m.mu.Unlock()
		return nil
	}
	snapshot := *call
	m.mu.Unlock()
	return &snapshot
}

func (m *p2pManager) callForUser(uid int64) *p2pCall {
	m.mu.Lock()
	callID := m.byUser[uid]
	call := m.calls[callID]
	if call == nil {
		m.mu.Unlock()
		return nil
	}
	snapshot := *call
	m.mu.Unlock()
	return &snapshot
}

func (c *Client) handleCallInvite(env *Envelope) {
	var p struct {
		CalleeID int64  `json:"callee_id"`
		CallID   string `json:"call_id"`
		Video    bool   `json:"video"`
	}
	if json.Unmarshal(env.Data, &p) != nil {
		c.Send("error", map[string]string{"code": "call", "message": "invalid call request"})
		return
	}
	if p.CalleeID == 0 || p.CalleeID == c.user.ID {
		c.Send("call:ended", map[string]any{"call_id": p.CallID, "reason": "unavailable"})
		return
	}
	if p.CallID == "" {
		p.CallID = newCallID()
	}
	c.hub.callStateMu.Lock()
	defer c.hub.callStateMu.Unlock()
	c.hub.promote(c)
	callee, err := c.hub.db.GetUserByID(p.CalleeID)
	if err != nil || callee.Disabled || c.hub.db.IsBlockedEitherWay(c.user.ID, callee.ID) {
		c.Send("call:ended", map[string]any{"call_id": p.CallID, "reason": "unavailable"})
		return
	}
	if c.hub.engine.UserInRoom(c.user.ID) || c.hub.engine.UserInRoom(callee.ID) {
		c.Send("call:ended", map[string]any{"call_id": p.CallID, "reason": "busy"})
		return
	}
	c.hub.p2p.invite(c.user, callee, p.CallID, p.Video)
}

func (m *p2pManager) invite(caller *db.User, callee *db.User, callID string, video bool) {
	call := &p2pCall{id: callID, callerID: caller.ID, calleeID: callee.ID, state: "ringing"}

	m.mu.Lock()
	if _, exists := m.calls[callID]; exists {
		m.mu.Unlock()
		return
	}
	if _, busy := m.byUser[caller.ID]; busy {
		m.mu.Unlock()
		m.hub.sendToUser(caller.ID, "call:ended", map[string]any{"call_id": callID, "reason": "busy"})
		return
	}
	if _, busy := m.byUser[callee.ID]; busy {
		m.mu.Unlock()
		m.hub.sendToUser(caller.ID, "call:ended", map[string]any{"call_id": callID, "reason": "busy"})
		return
	}
	calleeOnline := m.hub.client(callee.ID) != nil
	row, err := m.hub.db.CreateCall(callID, caller.ID, false)
	if err != nil {
		m.mu.Unlock()
		m.hub.sendToUser(caller.ID, "call:ended", map[string]any{"call_id": callID, "reason": "server-error"})
		return
	}
	call.dbID = row.ID
	if err := m.hub.db.AddCallParticipant(row.ID, caller.ID, true); err != nil {
		m.mu.Unlock()
		m.finalizeDB(call)
		m.hub.sendToUser(caller.ID, "call:ended", map[string]any{"call_id": callID, "reason": "server-error"})
		return
	}
	if err := m.hub.db.AddCallParticipant(row.ID, callee.ID, false); err != nil {
		m.mu.Unlock()
		m.finalizeDB(call)
		m.hub.sendToUser(caller.ID, "call:ended", map[string]any{"call_id": callID, "reason": "server-error"})
		return
	}
	// Check if callee is offline while holding the manager lock so there is no
	// race between the check and registering the call.
	if !calleeOnline {
		m.mu.Unlock()
		// callee offline: log as missed immediately
		if err := m.hub.db.MarkParticipantMissed(call.dbID, callee.ID); err != nil {
			m.hub.log.Error("call: mark offline participant missed", "call_id", call.id, "err", err)
		}
		m.finalizeDB(call)
		m.hub.sendToUser(caller.ID, "call:ended", map[string]any{"call_id": callID, "reason": "offline"})
		return
	}
	m.calls[callID] = call
	m.byUser[caller.ID] = callID
	m.byUser[callee.ID] = callID
	call.timer = time.AfterFunc(ringTimeout, func() { m.timeout(callID) })
	m.mu.Unlock()

	m.hub.sendToUser(caller.ID, "call:outgoing", map[string]any{
		"call_id": callID, "callee": briefOf(callee), "video": video,
	})
	m.hub.sendToUser(callee.ID, "call:invite", map[string]any{
		"call_id": callID, "from": briefOf(caller), "video": video,
	})
}

func (c *Client) handleCallRinging(env *Envelope) {
	var p struct {
		CallID string `json:"call_id"`
	}
	if json.Unmarshal(env.Data, &p) != nil {
		return
	}
	if call := c.hub.p2p.get(p.CallID); call != nil && call.state == "ringing" && call.calleeID == c.user.ID {
		c.hub.sendToUser(call.callerID, "call:ringing", map[string]any{"call_id": call.id})
	}
}

func (c *Client) handleCallAccept(env *Envelope) {
	var p struct {
		CallID string `json:"call_id"`
	}
	if json.Unmarshal(env.Data, &p) != nil {
		return
	}
	m := c.hub.p2p
	c.hub.callStateMu.Lock()
	defer c.hub.callStateMu.Unlock()
	call, ok := m.accept(p.CallID, c.user.ID)
	if !ok {
		c.Send("call:ended", map[string]any{"call_id": p.CallID, "reason": "unavailable"})
		return
	}
	// This device takes the call; stop the others from ringing.
	c.hub.promote(c)
	c.hub.sendToOthers(c, "call:ended", map[string]any{"call_id": p.CallID, "reason": "answered-elsewhere"})
	if err := m.hub.db.AddCallParticipant(call.dbID, c.user.ID, true); err != nil {
		ended, endedOK := m.end(call.id, "active")
		if endedOK {
			m.hub.sendToUser(ended.callerID, "call:ended", map[string]any{"call_id": ended.id, "reason": "server-error"})
		}
		c.Send("call:ended", map[string]any{"call_id": call.id, "reason": "server-error"})
		return
	}
	m.hub.sendToUser(call.callerID, "call:accepted", map[string]any{
		"call_id": call.id, "callee": briefOf(c.user),
	})
}

func (c *Client) handleCallDecline(env *Envelope) {
	var p struct {
		CallID string `json:"call_id"`
	}
	if json.Unmarshal(env.Data, &p) != nil {
		return
	}
	m := c.hub.p2p
	call := m.get(p.CallID)
	if call == nil || call.calleeID != c.user.ID {
		return
	}
	call, ok := m.end(p.CallID, "ringing")
	if !ok {
		return
	}
	if err := m.hub.db.MarkParticipantMissed(call.dbID, call.calleeID); err != nil {
		m.hub.log.Error("call: mark declined participant missed", "call_id", call.id, "err", err)
	}
	m.hub.sendToUser(call.callerID, "call:declined", map[string]any{"call_id": call.id})
	m.hub.sendToUser(call.calleeID, "call:ended", map[string]any{"call_id": call.id, "reason": "declined"})
}

func (c *Client) handleCallHangup(env *Envelope) {
	var p struct {
		CallID string `json:"call_id"`
	}
	if json.Unmarshal(env.Data, &p) != nil {
		return
	}
	m := c.hub.p2p
	call := m.get(p.CallID)
	if call == nil {
		return
	}
	if call.callerID != c.user.ID && call.calleeID != c.user.ID {
		return
	}
	other := call.callerID
	if other == c.user.ID {
		other = call.calleeID
	}
	ended, ok := m.end(call.id, "")
	if !ok {
		return
	}
	m.hub.sendToUser(other, "call:ended", map[string]any{"call_id": ended.id, "reason": "hangup"})
	c.Send("call:ended", map[string]any{"call_id": ended.id, "reason": "hangup"})
}

// webrtc:relay forwards SDP/ICE payloads verbatim between the two call parties.
func (c *Client) handleRelay(env *Envelope) {
	var p struct {
		To     int64           `json:"to"`
		CallID string          `json:"call_id"`
		Data   json.RawMessage `json:"data"`
	}
	if json.Unmarshal(env.Data, &p) != nil {
		return
	}
	call := c.hub.p2p.get(p.CallID)
	if call == nil {
		return
	}
	if call.callerID != c.user.ID && call.calleeID != c.user.ID {
		return
	}
	if p.To == c.user.ID || (p.To != call.callerID && p.To != call.calleeID) {
		return
	}
	c.hub.sendToUser(p.To, "webrtc:relay", map[string]any{
		"from":    c.user.ID,
		"call_id": p.CallID,
		"data":    p.Data,
	})
}

func (m *p2pManager) timeout(callID string) {
	call, ok := m.end(callID, "ringing")
	if !ok {
		return
	}
	if err := m.hub.db.MarkParticipantMissed(call.dbID, call.calleeID); err != nil {
		m.hub.log.Error("call: mark timed-out participant missed", "call_id", call.id, "err", err)
	}
	m.hub.sendToUser(call.callerID, "call:ended", map[string]any{"call_id": call.id, "reason": "no-answer"})
	m.hub.sendToUser(call.calleeID, "call:ended", map[string]any{"call_id": call.id, "reason": "missed"})
}

func (m *p2pManager) accept(callID string, calleeID int64) (*p2pCall, bool) {
	m.mu.Lock()
	call := m.calls[callID]
	if call == nil || call.state != "ringing" || call.calleeID != calleeID {
		m.mu.Unlock()
		return nil, false
	}
	call.state = "active"
	if call.timer != nil {
		call.timer.Stop()
		call.timer = nil
	}
	snapshot := *call
	m.mu.Unlock()
	return &snapshot, true
}

// end finalizes the in-memory + DB state of a call. expectedState is empty to
// end any live call, or a concrete state for an atomic timeout/decline.
func (m *p2pManager) end(callID, expectedState string) (*p2pCall, bool) {
	m.mu.Lock()
	call := m.calls[callID]
	if call == nil || call.state == "ended" || (expectedState != "" && call.state != expectedState) {
		m.mu.Unlock()
		return nil, false
	}
	call.state = "ended"
	if call.timer != nil {
		call.timer.Stop()
		call.timer = nil
	}
	delete(m.calls, call.id)
	if m.byUser[call.callerID] == call.id {
		delete(m.byUser, call.callerID)
	}
	if m.byUser[call.calleeID] == call.id {
		delete(m.byUser, call.calleeID)
	}
	snapshot := *call
	m.mu.Unlock()
	m.finalizeDB(&snapshot)
	return &snapshot, true
}

func (m *p2pManager) finalizeDB(call *p2pCall) {
	if call.dbID > 0 {
		if err := m.hub.db.CallParticipantLeft(call.dbID, call.callerID); err != nil {
			m.hub.log.Error("call: mark caller left", "call_id", call.id, "err", err)
		}
		if err := m.hub.db.CallParticipantLeft(call.dbID, call.calleeID); err != nil {
			m.hub.log.Error("call: mark callee left", "call_id", call.id, "err", err)
		}
		if err := m.hub.db.EndCall(call.dbID); err != nil {
			m.hub.log.Error("call: end p2p call", "call_id", call.id, "err", err)
		}
	}
}

// scheduleDisconnect ends uid's call after p2pResumeGrace unless
// resume(uid, callID) cancels it first. Called when uid's socket drops.
func (m *p2pManager) scheduleDisconnect(uid int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, inCall := m.byUser[uid]; !inCall {
		return
	}
	if t := m.grace[uid]; t != nil {
		t.Stop()
	}
	var t *time.Timer
	t = time.AfterFunc(p2pResumeGrace, func() {
		m.hub.callStateMu.Lock()
		defer m.hub.callStateMu.Unlock()
		m.mu.Lock()
		current := m.grace[uid] == t
		if current {
			delete(m.grace, uid)
		}
		m.mu.Unlock()
		if current {
			m.onDisconnect(uid)
		}
	})
	m.grace[uid] = t
}

// resume cancels a pending scheduleDisconnect if uid is still a party to
// callID. Reports whether the call is still alive for them.
func (m *p2pManager) resume(uid int64, callID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.byUser[uid] != callID {
		return false
	}
	if t := m.grace[uid]; t != nil {
		t.Stop()
		delete(m.grace, uid)
	}
	return true
}

func (c *Client) handleCallResume(env *Envelope) {
	var p struct {
		CallID string `json:"call_id"`
	}
	if json.Unmarshal(env.Data, &p) != nil || p.CallID == "" {
		return
	}
	if !c.hub.p2p.resume(c.user.ID, p.CallID) {
		c.Send("call:ended", map[string]any{"call_id": p.CallID, "reason": "hangup"})
		return
	}
	c.hub.promote(c)
}

func (m *p2pManager) onDisconnect(uid int64) {
	call := m.callForUser(uid)
	if call == nil {
		return
	}
	other := call.callerID
	if other == uid {
		other = call.calleeID
	}
	ended, ok := m.end(call.id, "")
	if ok {
		m.hub.sendToUser(other, "call:ended", map[string]any{"call_id": ended.id, "reason": "hangup"})
	}
}

func (m *p2pManager) count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := 0
	for _, c := range m.calls {
		if c.state != "ended" {
			n++
		}
	}
	return n
}

func (m *p2pManager) closeAll() {
	m.mu.Lock()
	calls := make([]*p2pCall, 0, len(m.calls))
	for _, c := range m.calls {
		calls = append(calls, c)
	}
	m.mu.Unlock()
	for _, c := range calls {
		m.end(c.id, "")
	}
}
