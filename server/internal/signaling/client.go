package signaling

import (
	"encoding/json"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"visioncall/internal/db"
)

const (
	writeWait  = 10 * time.Second
	pongWait   = 60 * time.Second
	pingPeriod = 30 * time.Second
	maxMsgSize = 512 * 1024

	// Per-client WS message rate limits per 10 seconds. Chat/control
	// messages get 60; WebRTC signaling (ICE candidates, SDP, track state)
	// gets its own, larger budget — a multi-homed machine can emit dozens of
	// candidates per call setup, and dropping them silently breaks calls.
	msgRateMax    = 60
	sigRateMax    = 400
	msgRateWindow = 10 * time.Second
)

// signalingTypes are the media-signaling messages rate-limited separately.
var signalingTypes = map[string]bool{
	"webrtc:relay": true, "sfu:pub-offer": true, "sfu:pub-ice": true,
	"sfu:sub-answer": true, "sfu:sub-ice": true, "sfu:track-state": true,
}

// msgRateLimiter is a fixed-window rate limiter scoped to one client.
type msgRateLimiter struct {
	mu      sync.Mutex
	count   int
	resetAt time.Time
}

func (m *msgRateLimiter) Allow(max int) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	if now.After(m.resetAt) {
		m.count = 0
		m.resetAt = now.Add(msgRateWindow)
	}
	if m.count >= max {
		return false
	}
	m.count++
	return true
}

type Client struct {
	hub       *Hub
	user      *db.User
	conn      *websocket.Conn
	send      chan []byte
	statusVal atomic.Value // string: "online" | "away" | "dnd"; unset == "online"
	closeOnce sync.Once
	rateLim   msgRateLimiter
	sigLim    msgRateLimiter
	finishing atomic.Bool // set by Finish: stop routing, flush, then close
	log       *slog.Logger
	// deviceID identifies the browser/device this connection came from (sent
	// as a query param by the web client, persisted in its localStorage).
	// Used to tell "same device reconnecting" apart from "a different device
	// signed in" when a user's second connection replaces their first.
	deviceID string
	// sessionID is this connection's server-side session row (see auth.Claims).
	// Kicking a client for "signed in elsewhere" deletes this row too, so its
	// reload can't just silently re-authenticate and re-kick the new session
	// back - without that, two real devices would fight forever.
	sessionID string
	// host is the Host header the browser used to reach the server.
	host string
}

func (c *Client) status() string {
	if v, ok := c.statusVal.Load().(string); ok && v != "" {
		return v
	}
	return "online"
}

func (c *Client) setStatus(s string) { c.statusVal.Store(s) }

func (c *Client) Send(typ string, data any) bool {
	payload, err := marshalEnvelope(typ, data)
	if err != nil {
		c.log.Error("ws: marshal envelope", "type", typ, "err", err)
		return false
	}
	return c.SendRaw(payload)
}

func (c *Client) SendRaw(payload []byte) (ok bool) {
	select {
	case c.send <- payload:
		return true
	default:
		// Send buffer is full — the client is too slow; disconnect it.
		c.log.Warn("ws: send buffer full; closing connection")
		c.close()
		return false
	}
}

func (c *Client) close() {
	c.closeOnce.Do(func() {
		c.conn.Close()
	})
}

// Kick tells the client it has been signed out, then closes the socket.
func (c *Client) Kick(reason string) {
	c.Finish("force:logout", map[string]string{"reason": reason})
}

// Finish queues one last message and closes the connection once the write
// pump has flushed it. Only writePump ever writes to the socket (gorilla
// allows a single concurrent writer), so this never blocks the caller —
// important since callers hold the hub's call-state lock. Messages the
// client sends after this are ignored.
func (c *Client) Finish(typ string, data any) {
	if !c.finishing.CompareAndSwap(false, true) {
		return
	}
	if payload, err := marshalEnvelope(typ, data); err == nil {
		select {
		case c.send <- payload:
		default:
		}
	}
	select {
	case c.send <- nil: // sentinel: writePump sends a close frame and exits
	default:
		c.close()
	}
	time.AfterFunc(3*time.Second, c.close) // backstop if the peer stops reading
}

func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.close() // ensure readPump gets a read error and exits promptly
	}()
	for {
		select {
		case msg, ok := <-c.send:
			if !ok {
				return
			}
			if msg == nil { // Finish sentinel
				c.conn.SetWriteDeadline(time.Now().Add(writeWait))
				_ = c.conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
				return
			}
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				c.log.Debug("ws: write error", "err", err)
				return
			}
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				c.log.Debug("ws: ping error", "err", err)
				return
			}
		}
	}
}

func (c *Client) readPump() {
	defer func() {
		c.close()
		c.hub.unregister(c)
	}()
	c.conn.SetReadLimit(maxMsgSize)
	c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})
	for {
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				c.log.Debug("ws: read error", "err", err)
			}
			return
		}

		if c.finishing.Load() {
			continue // kicked/replaced: nothing it sends may take effect
		}

		var env Envelope
		if err := json.Unmarshal(data, &env); err != nil || env.Type == "" {
			c.log.Debug("ws: malformed envelope", "err", err)
			continue
		}

		// Rate-limit WS messages per client, with media signaling on its own budget.
		limiter, max := &c.rateLim, msgRateMax
		if signalingTypes[env.Type] {
			limiter, max = &c.sigLim, sigRateMax
		}
		if !limiter.Allow(max) {
			c.log.Warn("ws: rate limit exceeded; dropping message", "type", env.Type)
			c.Send("error", map[string]string{"code": "rate-limit", "message": "sending too fast; slow down"})
			continue
		}
		c.route(&env)
	}
}

func (c *Client) route(env *Envelope) {
	defer func() {
		// A panic here would otherwise crash the whole process — readPump
		// runs this in a per-connection goroutine with nothing above it to
		// recover. Log it and drop just this connection instead.
		if r := recover(); r != nil {
			c.log.Error("ws: panic in message handler", "type", env.Type, "panic", r)
			c.close()
		}
	}()
	switch env.Type {
	case "presence:update":
		c.handlePresenceUpdate(env)
	case "message:send":
		c.handleMessageSend(env)
	case "message:delete":
		c.handleMessageDelete(env)
	case "message:edit":
		c.handleMessageEdit(env)
	case "message:react":
		c.handleMessageReact(env)
	case "message:pin":
		c.handleMessagePin(env)
	case "poll:vote":
		c.handlePollVote(env)
	case "poll:close":
		c.handlePollClose(env)
	case "message:typing":
		c.handleTyping(env)
	case "message:read":
		c.handleRead(env)
	case "call:invite":
		c.handleCallInvite(env)
	case "call:ringing":
		c.handleCallRinging(env)
	case "call:accept":
		c.handleCallAccept(env)
	case "call:decline":
		c.handleCallDecline(env)
	case "call:hangup":
		c.handleCallHangup(env)
	case "call:resume":
		c.handleCallResume(env)
	case "webrtc:relay":
		c.handleRelay(env)
	case "room:join":
		c.handleRoomJoin(env)
	case "room:leave":
		c.handleRoomLeave(env)
	case "room:mute-request":
		c.handleRoomMuteRequest(env)
	case "room:unlock-request":
		c.handleRoomUnlockRequest(env)
	case "room:kick-request":
		c.handleRoomKickRequest(env)
	case "room:presenter-only-request":
		c.handleRoomPresenterOnlyRequest(env)
	case "room:presenter-request":
		c.handleRoomPresenterRequest(env)
	case "room:roster-request":
		c.handleRoomRosterRequest(env)
	case "room:nudge-request":
		c.handleRoomNudgeRequest(env)
	case "room:admit":
		c.handleRoomAdmit(env)
	case "room:deny":
		c.handleRoomDeny(env)
	case "call:raise-hand":
		c.handleRaiseHand(env)
	case "sfu:pub-offer":
		c.handlePubOffer(env)
	case "sfu:pub-ice":
		c.handlePubICE(env)
	case "sfu:sub-answer":
		c.handleSubAnswer(env)
	case "sfu:sub-ice":
		c.handleSubICE(env)
	case "sfu:track-state":
		c.handleTrackState(env)
	default:
		c.log.Debug("ws: unknown message type", "type", env.Type)
	}
}
