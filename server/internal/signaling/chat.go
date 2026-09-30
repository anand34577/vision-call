package signaling

import (
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"visioncall/internal/db"
)

type dbMessage = db.Message

// ---- client -> server payloads ----

type sendMessagePayload struct {
	ClientID    string `json:"client_id"`
	RecipientID *int64 `json:"recipient_id"`
	GroupID     *int64 `json:"group_id"`
	Content     string `json:"content"`
	FileID      *int64 `json:"file_id"`
	ReplyToID   *int64 `json:"reply_to_id"`
	// Mentions are the user ids @-mentioned; sent as metadata because the
	// server can't read end-to-end encrypted text.
	Mentions []int64 `json:"mentions"`
	// ThreadRootID posts this message as a reply inside another message's thread.
	ThreadRootID *int64 `json:"thread_root_id"`
	// Poll turns the message into a poll (Content should carry the question).
	Poll *struct {
		Question string   `json:"question"`
		Options  []string `json:"options"`
		Multi    bool     `json:"multi"`
	} `json:"poll"`
	// E2E: when Encrypted, Content is ciphertext and EncIV/EncKeys carry
	// what a recipient device needs to decrypt it. The server stores these
	// opaquely — see migration 008.
	Encrypted bool   `json:"encrypted"`
	EncIV     string `json:"enc_iv"`
	EncKeys   string `json:"enc_keys"`
}

// insertMessage stores p as plaintext or, when Encrypted, as an opaque
// ciphertext blob — the one branch point between the two, shared by the DM
// and group send paths.
func (h *Hub) insertMessage(senderID int64, recipientID, groupID, fileID *int64, p *sendMessagePayload) (*dbMessage, error) {
	var msg *dbMessage
	var err error
	if p.Encrypted {
		msg, err = h.db.InsertEncryptedMessage(senderID, recipientID, groupID, fileID, p.ReplyToID, p.Content, p.EncIV, p.EncKeys)
	} else {
		msg, err = h.db.InsertMessage(senderID, recipientID, groupID, fileID, p.ReplyToID, p.Content)
	}
	if err != nil {
		return nil, err
	}
	if p.ThreadRootID != nil {
		if h.db.SetThreadRoot(msg.ID, *p.ThreadRootID) == nil {
			msg.ThreadRootID = p.ThreadRootID
		}
	}
	if p.Poll != nil {
		if err := h.db.CreatePoll(msg.ID, p.Content, db.CleanPollOptions(p.Poll.Options), p.Poll.Multi); err != nil {
			_, _ = h.db.DeleteMessageAsModerator(msg.ID)
			return nil, err
		}
	}
	if ids := h.validMentions(senderID, recipientID, groupID, p.Mentions); len(ids) > 0 {
		if h.db.SetMessageMentions(msg.ID, ids) == nil {
			msg.Mentions = ids
		}
	}
	return msg, nil
}

// validMentions keeps only ids that are actually part of the conversation
// (the DM peer, or group members), so a mention can't be used to ping people
// who can't see the message.
func (h *Hub) validMentions(senderID int64, recipientID, groupID *int64, ids []int64) []int64 {
	if len(ids) == 0 {
		return nil
	}
	if len(ids) > 20 {
		ids = ids[:20]
	}
	allowed := map[int64]bool{}
	if recipientID != nil {
		allowed[*recipientID] = true
	} else if groupID != nil {
		members, err := h.db.GroupMemberIDs(*groupID)
		if err != nil {
			return nil
		}
		for _, m := range members {
			allowed[m] = true
		}
	}
	out := make([]int64, 0, len(ids))
	seen := map[int64]bool{}
	for _, id := range ids {
		if id != senderID && allowed[id] && !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}

// canAttachFile allows attaching your own upload, or re-attaching (forwarding)
// a file you're already allowed to see — the same rule CanAccessFile uses
// for downloads, so forwarding never grants access beyond what you already
// had.
func (c *Client) canAttachFile(fileID int64) bool {
	allowed, err := c.hub.db.CanAccessFile(fileID, c.user.ID)
	return err == nil && allowed
}

func (c *Client) sendMessageError(clientID, message string) {
	c.Send("error", map[string]string{"message": message, "client_id": clientID})
}

func (h *Hub) enrichBatch(msgs []*dbMessage) {
	if len(msgs) == 0 {
		return
	}
	senderIDs := make([]int64, 0, len(msgs))
	msgIDs := make([]int64, 0, len(msgs))
	replyIDs := make([]int64, 0, len(msgs))
	fileIDs := make([]int64, 0, len(msgs))
	for _, m := range msgs {
		senderIDs = append(senderIDs, m.SenderID)
		msgIDs = append(msgIDs, m.ID)
		if m.ReplyToID != nil {
			replyIDs = append(replyIDs, *m.ReplyToID)
		}
		if m.FileID != nil {
			fileIDs = append(fileIDs, *m.FileID)
		}
	}
	if users, err := h.db.UsersBrief(senderIDs); err == nil {
		for _, m := range msgs {
			m.Sender = users[m.SenderID]
		}
	}
	if len(fileIDs) > 0 {
		if files, err := h.db.FilesBrief(fileIDs); err == nil {
			for _, m := range msgs {
				if m.FileID != nil {
					m.File = files[*m.FileID]
				}
			}
		}
	}
	if len(replyIDs) > 0 {
		if previews, err := h.db.ReplyPreviews(replyIDs); err == nil {
			for _, m := range msgs {
				if m.ReplyToID != nil {
					m.ReplyTo = previews[*m.ReplyToID]
				}
			}
		}
	}
	if reactions, err := h.db.ReactionsForMessages(msgIDs); err == nil {
		for _, m := range msgs {
			m.Reactions = reactions[m.ID]
		}
	}
	if counts, err := h.db.ThreadCounts(msgIDs); err == nil {
		for _, m := range msgs {
			m.ThreadCount = counts[m.ID]
		}
	}
	if polls, err := h.db.PollsForMessages(msgIDs); err == nil {
		for _, m := range msgs {
			m.Poll = polls[m.ID]
		}
	}

}

func (h *Hub) enrich(m *dbMessage) {
	h.enrichBatch([]*dbMessage{m})
}

// replyTargetValid confirms replyToID names a real, non-deleted message in
// the same conversation the new message is being sent into (so a reply can't
// be forged to quote an unrelated DM/group the sender can't actually see).
func (h *Hub) replyTargetValid(replyToID int64, recipientID, groupID *int64, senderID int64) bool {
	target, err := h.db.GetMessage(replyToID)
	if err != nil || target.DeletedAt != nil {
		return false
	}
	if groupID != nil {
		return target.GroupID != nil && *target.GroupID == *groupID
	}
	if recipientID != nil {
		// Same DM thread: either direction between sender and recipient.
		involvesSender := target.SenderID == senderID || (target.RecipientID != nil && *target.RecipientID == senderID)
		involvesRecipient := target.SenderID == *recipientID || (target.RecipientID != nil && *target.RecipientID == *recipientID)
		return target.GroupID == nil && involvesSender && involvesRecipient
	}
	return false
}

// validPresenceStatuses are the only values a client may self-report;
// anything else (including empty) falls back to "online".
var validPresenceStatuses = map[string]bool{"online": true, "away": true, "dnd": true}

func (c *Client) handlePresenceUpdate(env *Envelope) {
	var p struct {
		Status string `json:"status"`
	}
	if json.Unmarshal(env.Data, &p) != nil {
		return
	}
	status := "online"
	if validPresenceStatuses[p.Status] {
		status = p.Status
	}
	c.setStatus(status)
	c.hub.rememberStatus(c.user.ID, status)
	c.hub.broadcast("presence:update", map[string]any{"user_id": c.user.ID, "status": status}, nil)
}

func (c *Client) handleMessageSend(env *Envelope) {
	var p sendMessagePayload
	if err := json.Unmarshal(env.Data, &p); err != nil {
		c.Send("error", map[string]string{"message": "malformed message"})
		return
	}
	if !p.Encrypted {
		p.Content = strings.TrimSpace(p.Content)
		if len([]rune(p.Content)) > 8000 {
			c.sendMessageError(p.ClientID, "message too long (8000 chars max)")
			return
		}
	} else if len(p.Content) > 32000 || len(p.EncKeys) > 65536 {
		// Ciphertext/wrapped-key blobs run larger than plaintext (base64
		// inflation, one wrapped key per recipient device) — generous caps
		// just to bound abuse, not to match the plaintext limit.
		c.sendMessageError(p.ClientID, "message too large")
		return
	}
	if p.RecipientID != nil && p.GroupID != nil {
		c.sendMessageError(p.ClientID, "message cannot target both a user and a group")
		return
	}
	if p.RecipientID != nil && (*p.RecipientID <= 0 || *p.RecipientID == c.user.ID) {
		c.sendMessageError(p.ClientID, "invalid message recipient")
		return
	}
	if p.GroupID != nil && *p.GroupID <= 0 {
		c.sendMessageError(p.ClientID, "invalid message group")
		return
	}
	if p.RecipientID == nil && p.GroupID == nil {
		c.sendMessageError(p.ClientID, "message needs recipient_id or group_id")
		return
	}
	if p.Content == "" && p.FileID == nil {
		return // nothing to send
	}
	if p.ReplyToID != nil && !c.hub.replyTargetValid(*p.ReplyToID, p.RecipientID, p.GroupID, c.user.ID) {
		c.sendMessageError(p.ClientID, "invalid reply target")
		return
	}
	if p.ThreadRootID != nil {
		root, err := c.hub.db.GetMessage(*p.ThreadRootID)
		if err != nil || root.ThreadRootID != nil || !c.hub.replyTargetValid(*p.ThreadRootID, p.RecipientID, p.GroupID, c.user.ID) {
			c.sendMessageError(p.ClientID, "invalid thread")
			return
		}
	}
	if p.Poll != nil {
		opts := db.CleanPollOptions(p.Poll.Options)
		q := strings.TrimSpace(p.Content)
		if p.Encrypted || q == "" || len([]rune(q)) > 300 || len(opts) < 2 || len(opts) > 10 || p.ThreadRootID != nil {
			c.sendMessageError(p.ClientID, "a poll needs a question and 2-10 options")
			return
		}
		for _, o := range opts {
			if len([]rune(o)) > 100 {
				c.sendMessageError(p.ClientID, "poll options must be 100 characters or fewer")
				return
			}
		}
		p.Poll.Options = opts
	}

	if p.GroupID != nil {
		c.sendGroupMessage(&p)
		return
	}
	recipient, err := c.hub.db.GetUserByID(*p.RecipientID)
	if err != nil {
		c.sendMessageError(p.ClientID, "recipient not found")
		return
	}
	if recipient.Disabled {
		c.sendMessageError(p.ClientID, "recipient is disabled")
		return
	}
	if c.hub.db.IsBlockedEitherWay(c.user.ID, recipient.ID) {
		c.sendMessageError(p.ClientID, "this person can't receive your messages")
		return
	}
	if p.FileID != nil && !c.canAttachFile(*p.FileID) {
		c.sendMessageError(p.ClientID, "invalid file reference")
		return
	}
	msg, err := c.hub.insertMessage(c.user.ID, p.RecipientID, nil, p.FileID, &p)
	if err != nil {
		c.sendMessageError(p.ClientID, "could not store message")
		return
	}
	c.hub.enrich(msg)
	if c.hub.sendToUser(recipient.ID, "message:new", map[string]any{"message": msg}) {
		now := time.Now().UTC().Format(time.RFC3339)
		if err := c.hub.db.MarkDelivered([]int64{msg.ID}, now); err != nil {
			c.log.Error("message: mark delivered", "message_id", msg.ID, "err", err)
		} else {
			msg.DeliveredAt = &now
		}
	}
	// sender ack carries the canonical message (with delivery state)
	c.Send("message:sent", map[string]any{"client_id": p.ClientID, "message": msg})
	c.hub.sendToOthers(c, "message:sent", map[string]any{"client_id": "sync-" + strconv.FormatInt(msg.ID, 10), "message": msg})
}

func (c *Client) sendGroupMessage(p *sendMessagePayload) {
	member, err := c.hub.db.IsGroupMember(*p.GroupID, c.user.ID)
	if err != nil || !member {
		c.sendMessageError(p.ClientID, "you are not a member of this group")
		return
	}
	if p.FileID != nil && !c.canAttachFile(*p.FileID) {
		c.sendMessageError(p.ClientID, "invalid file reference")
		return
	}
	memberIDs, err := c.hub.db.GroupMemberIDs(*p.GroupID)
	if err != nil {
		c.sendMessageError(p.ClientID, "could not load group members")
		return
	}
	msg, err := c.hub.insertMessage(c.user.ID, nil, p.GroupID, p.FileID, p)
	if err != nil {
		c.sendMessageError(p.ClientID, "could not store message")
		return
	}
	c.hub.enrich(msg)
	for _, uid := range memberIDs {
		if uid == c.user.ID {
			continue
		}
		c.hub.sendToUser(uid, "message:new", map[string]any{"message": msg})
	}
	c.Send("message:sent", map[string]any{"client_id": p.ClientID, "message": msg})
	c.hub.sendToOthers(c, "message:sent", map[string]any{"client_id": "sync-" + strconv.FormatInt(msg.ID, 10), "message": msg})
}

// handleMessageDelete soft-deletes a message the sender owns and tells
// whoever could see it (the DM peer, or the rest of the group) so their
// clients replace it with a "deleted" placeholder in place.
func (c *Client) handleMessageDelete(env *Envelope) {
	var p struct {
		ID int64 `json:"id"`
	}
	if json.Unmarshal(env.Data, &p) != nil || p.ID <= 0 {
		return
	}
	msg, err := c.hub.db.DeleteMessage(p.ID, c.user.ID)
	if err != nil && c.canModerate(p.ID) {
		msg, err = c.hub.db.DeleteMessageAsModerator(p.ID)
	}
	if err != nil {
		c.Send("error", map[string]string{"message": "could not delete message"})
		return
	}
	payload := map[string]any{"id": msg.ID, "sender_id": msg.SenderID, "recipient_id": msg.RecipientID, "group_id": msg.GroupID}
	c.broadcastToConversationRaw(msg, "message:deleted", payload)
}

// canModerate reports whether c may delete someone else's message: a site
// admin anywhere, or the owner/admin of the group it was posted in. DMs have
// no moderator.
func (c *Client) canModerate(msgID int64) bool {
	msg, err := c.hub.db.GetMessage(msgID)
	if err != nil || msg.DeletedAt != nil {
		return false
	}
	if msg.GroupID == nil {
		return false
	}
	if c.user.Role == "admin" {
		return true
	}
	role, err := c.hub.db.GroupMemberRole(*msg.GroupID, c.user.ID)
	return err == nil && (role == "owner" || role == "admin")
}

// handleMessageEdit updates a message's text in place. Only the sender may
// edit; the same recipients that saw "message:new" get the update.
func (c *Client) handleMessageEdit(env *Envelope) {
	var p struct {
		ID      int64  `json:"id"`
		Content string `json:"content"`
	}
	if json.Unmarshal(env.Data, &p) != nil || p.ID <= 0 {
		return
	}
	// Note: no re-encrypt-on-edit in v1 — editing an E2E message would
	// need re-wrapping the new content key to every recipient device all
	// over again. Simplest safe behavior: encrypted messages aren't
	// editable (delete and resend instead).
	if existing, err := c.hub.db.GetMessage(p.ID); err == nil && existing.IsEncrypted {
		c.Send("error", map[string]string{"message": "encrypted messages can't be edited — delete and resend instead"})
		return
	}
	p.Content = strings.TrimSpace(p.Content)
	if p.Content == "" {
		c.Send("error", map[string]string{"message": "message cannot be empty"})
		return
	}
	if len([]rune(p.Content)) > 8000 {
		c.Send("error", map[string]string{"message": "message too long (8000 chars max)"})
		return
	}
	msg, err := c.hub.db.EditMessage(p.ID, c.user.ID, p.Content)
	if err != nil {
		c.Send("error", map[string]string{"message": "could not edit message"})
		return
	}
	c.hub.enrich(msg)
	c.broadcastToConversationRaw(msg, "message:edited", map[string]any{"message": msg})
}

// handleMessageReact toggles the caller's emoji reaction on a message they
// can see (sender, DM peer, or fellow group member).
func (c *Client) handleMessageReact(env *Envelope) {
	var p struct {
		ID    int64  `json:"id"`
		Emoji string `json:"emoji"`
	}
	if json.Unmarshal(env.Data, &p) != nil || p.ID <= 0 || p.Emoji == "" || len([]rune(p.Emoji)) > 8 {
		return
	}
	msg, err := c.hub.db.GetMessage(p.ID)
	if err != nil {
		return
	}
	if !c.canSeeMessage(msg) {
		return
	}
	added, err := c.hub.db.ToggleReaction(p.ID, c.user.ID, p.Emoji)
	if err != nil {
		c.log.Error("message: toggle reaction", "message_id", p.ID, "err", err)
		return
	}
	payload := map[string]any{
		"id": msg.ID, "sender_id": msg.SenderID, "recipient_id": msg.RecipientID, "group_id": msg.GroupID,
		"user_id": c.user.ID, "emoji": p.Emoji, "added": added,
	}
	c.broadcastToConversationRaw(msg, "message:reaction", payload)
}

// handleMessagePin pins or unpins a message. Anyone who can see the message
// may pin/unpin it in a DM (either party); in a group, only the sender, a
// group owner/admin, or a site admin may.
func (c *Client) handleMessagePin(env *Envelope) {
	var p struct {
		ID     int64 `json:"id"`
		Pinned bool  `json:"pinned"`
	}
	if json.Unmarshal(env.Data, &p) != nil || p.ID <= 0 {
		return
	}
	msg, err := c.hub.db.GetMessage(p.ID)
	if err != nil || !c.canSeeMessage(msg) {
		return
	}
	if !c.canPin(msg) {
		c.Send("error", map[string]string{"message": "you cannot pin messages in this conversation"})
		return
	}
	updated, err := c.hub.db.PinMessage(p.ID, p.Pinned)
	if err != nil {
		c.Send("error", map[string]string{"message": "could not update pin"})
		return
	}
	payload := map[string]any{
		"id": updated.ID, "sender_id": updated.SenderID, "recipient_id": updated.RecipientID, "group_id": updated.GroupID,
		"pinned_at": updated.PinnedAt,
	}
	c.broadcastToConversationRaw(updated, "message:pinned", payload)
}

func (c *Client) canPin(msg *dbMessage) bool {
	if msg.SenderID == c.user.ID || c.user.Role == "admin" {
		return true
	}
	if msg.GroupID != nil {
		role, err := c.hub.db.GroupMemberRole(*msg.GroupID, c.user.ID)
		return err == nil && (role == "owner" || role == "admin")
	}
	// DM: either party may pin/unpin, not just the sender.
	return msg.RecipientID != nil && *msg.RecipientID == c.user.ID
}

// canSeeMessage reports whether c.user is a legitimate party to msg's
// conversation (DM sender/recipient, or a member of its group).
func (c *Client) canSeeMessage(msg *dbMessage) bool {
	if msg.SenderID == c.user.ID {
		return true
	}
	if msg.RecipientID != nil {
		return *msg.RecipientID == c.user.ID
	}
	if msg.GroupID != nil {
		member, err := c.hub.db.IsGroupMember(*msg.GroupID, c.user.ID)
		return err == nil && member
	}
	return false
}

// broadcastToConversationRaw sends payload to everyone who could see msg
// (including the caller, so their own other tabs/devices stay in sync).
func (c *Client) broadcastToConversationRaw(msg *dbMessage, typ string, payload any) {
	if msg.RecipientID != nil {
		// The caller may be either side of the DM (a recipient reacting to
		// or pinning a message), so notify whichever party isn't them.
		other := *msg.RecipientID
		if other == c.user.ID {
			other = msg.SenderID
		}
		c.hub.sendToUser(other, typ, payload)
		c.Send(typ, payload)
		return
	}
	if msg.GroupID != nil {
		memberIDs, err := c.hub.db.GroupMemberIDs(*msg.GroupID)
		if err != nil {
			c.log.Error("message: load group members for broadcast", "group_id", *msg.GroupID, "type", typ, "err", err)
			return
		}
		for _, uid := range memberIDs {
			if uid == c.user.ID {
				continue
			}
			c.hub.sendToUser(uid, typ, payload)
		}
		c.Send(typ, payload)
	}
}

func (c *Client) handleTyping(env *Envelope) {
	var p struct {
		RecipientID *int64 `json:"recipient_id"`
		GroupID     *int64 `json:"group_id"`
	}
	if json.Unmarshal(env.Data, &p) != nil {
		return
	}
	// from_name is what the web and Android clients read; display_name is
	// kept for anything that already relied on it.
	payload := map[string]any{"from": c.user.ID, "from_name": c.user.DisplayName, "display_name": c.user.DisplayName}
	if p.RecipientID != nil {
		// No DB lookup per keystroke: a disabled user has no live socket
		// (they're kicked when disabled), so sendToUser is already a no-op.
		if *p.RecipientID != c.user.ID {
			c.hub.sendToUser(*p.RecipientID, "message:typing", payload)
		}
		return
	}
	if p.GroupID != nil {
		if member, err := c.hub.db.IsGroupMember(*p.GroupID, c.user.ID); err == nil && member {
			if memberIDs, err := c.hub.db.GroupMemberIDs(*p.GroupID); err != nil {
				c.log.Error("message: load group members for typing", "group_id", *p.GroupID, "err", err)
			} else {
				for _, uid := range memberIDs {
					if uid != c.user.ID {
						c.hub.sendToUser(uid, "message:typing", appendMap(payload, "group_id", *p.GroupID))
					}
				}
			}
		}
	}
}

// appendMap returns a new map that is a shallow copy of m with key=val added.
// The original map is never modified.
func appendMap(m map[string]any, key string, val any) map[string]any {
	out := make(map[string]any, len(m)+1)
	for k, v := range m {
		out[k] = v
	}
	out[key] = val
	return out
}

func (c *Client) handleRead(env *Envelope) {
	var p struct {
		PeerID  *int64 `json:"peer_id"`
		GroupID *int64 `json:"group_id"`
	}
	if json.Unmarshal(env.Data, &p) != nil {
		return
	}
	if p.PeerID != nil {
		now := time.Now().UTC().Format(time.RFC3339)
		if _, err := c.hub.db.MarkDirectRead(*p.PeerID, c.user.ID, now); err != nil {
			c.log.Error("message: mark read", "peer_id", *p.PeerID, "err", err)
		} else {
			c.hub.sendToUser(*p.PeerID, "message:read", map[string]any{"from": c.user.ID})
			c.hub.syncUnread(c)
		}
		return
	}
	if p.GroupID != nil {
		if member, err := c.hub.db.IsGroupMember(*p.GroupID, c.user.ID); err == nil && member {
			if err := c.hub.db.MarkGroupRead(*p.GroupID, c.user.ID); err != nil {
				c.log.Error("message: mark group read", "group_id", *p.GroupID, "err", err)
			}
			var lastRead int64
			if states, err := c.hub.db.GroupReadStates(*p.GroupID); err == nil {
				lastRead = states[c.user.ID]
			}
			c.hub.syncUnread(c)
			if memberIDs, err := c.hub.db.GroupMemberIDs(*p.GroupID); err != nil {
				c.log.Error("message: load group members for read", "group_id", *p.GroupID, "err", err)
			} else {
				for _, uid := range memberIDs {
					if uid != c.user.ID {
						// A distinct event: clients treat "message:read" as a DM
						// read receipt from `from`, so reusing it here marked all
						// their DMs to this user as read.
						c.hub.sendToUser(uid, "message:group-read", map[string]any{"from": c.user.ID, "group_id": *p.GroupID, "last_read_id": lastRead})
					}
				}
			}
		}
	}
}

// handlePollVote toggles the caller's vote and tells everyone in the chat.
func (c *Client) handlePollVote(env *Envelope) {
	var p struct {
		PollID   int64 `json:"poll_id"`
		OptionID int64 `json:"option_id"`
	}
	if json.Unmarshal(env.Data, &p) != nil {
		return
	}
	c.withPollMessage(p.PollID, func(msg *dbMessage) {
		if err := c.hub.db.VotePoll(p.PollID, p.OptionID, c.user.ID); err != nil {
			if err == db.ErrPollClosed {
				c.Send("error", map[string]string{"message": "this poll is closed"})
			}
			return
		}
		c.broadcastPoll(msg)
	})
}

// handlePollClose ends voting; only the poll's author (or a site admin) may.
func (c *Client) handlePollClose(env *Envelope) {
	var p struct {
		PollID int64 `json:"poll_id"`
	}
	if json.Unmarshal(env.Data, &p) != nil {
		return
	}
	c.withPollMessage(p.PollID, func(msg *dbMessage) {
		if msg.SenderID != c.user.ID && c.user.Role != "admin" {
			c.Send("error", map[string]string{"message": "only the poll's author can close it"})
			return
		}
		if c.hub.db.ClosePoll(p.PollID) == nil {
			c.broadcastPoll(msg)
		}
	})
}

func (c *Client) withPollMessage(pollID int64, fn func(*dbMessage)) {
	mid, err := c.hub.db.PollMessageID(pollID)
	if err != nil {
		return
	}
	msg, err := c.hub.db.GetMessage(mid)
	if err != nil || msg.DeletedAt != nil || !c.canSeeMessage(msg) {
		return
	}
	fn(msg)
}

func (c *Client) broadcastPoll(msg *dbMessage) {
	polls, err := c.hub.db.PollsForMessages([]int64{msg.ID})
	if err != nil || polls[msg.ID] == nil {
		return
	}
	c.broadcastToConversationRaw(msg, "poll:updated", map[string]any{
		"message_id": msg.ID, "sender_id": msg.SenderID, "recipient_id": msg.RecipientID,
		"group_id": msg.GroupID, "poll": polls[msg.ID],
	})
}
