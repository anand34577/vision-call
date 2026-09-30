package api

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"visioncall/internal/auth"
	"visioncall/internal/db"
)

// enrichMessages attaches sender briefs, file metadata, reply previews, and
// reactions for API responses — the REST-load equivalent of Hub.enrich for a
// realtime message.
func (a *API) enrichMessages(msgs []*db.Message) {
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
	if users, err := a.db.UsersBrief(senderIDs); err == nil {
		for _, m := range msgs {
			m.Sender = users[m.SenderID]
		}
	}
	if len(fileIDs) > 0 {
		if files, err := a.db.FilesBrief(fileIDs); err == nil {
			for _, m := range msgs {
				if m.FileID != nil {
					m.File = files[*m.FileID]
				}
			}
		}
	}
	if reactions, err := a.db.ReactionsForMessages(msgIDs); err == nil {
		for _, m := range msgs {
			m.Reactions = reactions[m.ID]
		}
	}
	if counts, err := a.db.ThreadCounts(msgIDs); err == nil {
		for _, m := range msgs {
			m.ThreadCount = counts[m.ID]
		}
	}
	if polls, err := a.db.PollsForMessages(msgIDs); err == nil {
		for _, m := range msgs {
			m.Poll = polls[m.ID]
		}
	}
	if len(replyIDs) > 0 {
		if previews, err := a.db.ReplyPreviews(replyIDs); err == nil {
			for _, m := range msgs {
				if m.ReplyToID != nil {
					m.ReplyTo = previews[*m.ReplyToID]
				}
			}
		}
	}
}

func (a *API) handleDirectHistory(w http.ResponseWriter, r *http.Request) {
	me := auth.CurrentUser(r)
	peerID, err := strconv.ParseInt(chi.URLParam(r, "userID"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid user id")
		return
	}
	if _, err := a.db.GetUserByID(peerID); err != nil {
		writeErr(w, http.StatusNotFound, "user not found")
		return
	}
	before, limit := paging(r)
	msgs, err := a.db.ListDirectMessages(me.ID, peerID, before, limit)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not load messages")
		return
	}
	a.enrichMessages(msgs)
	writeJSON(w, http.StatusOK, msgs)
}

// handleRecentConversations returns the latest message of each of the
// caller's DMs and groups, so the chat list can show previews and sort by
// recency without opening (and paging in) every conversation first.
func (a *API) handleRecentConversations(w http.ResponseWriter, r *http.Request) {
	me := auth.CurrentUser(r)
	peers, err := a.db.RecentDirectPeers(me.ID, 200)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not load conversations")
		return
	}
	groups, err := a.db.RecentGroupMessages(me.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not load conversations")
		return
	}
	dms := make([]*db.Message, 0, len(peers))
	for _, m := range peers {
		dms = append(dms, m)
	}
	a.enrichMessages(dms)
	a.enrichMessages(groups)
	writeJSON(w, http.StatusOK, map[string]any{"dms": dms, "groups": groups})
}

func paging(r *http.Request) (before int64, limit int) {
	limit = 50
	if v, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && v > 0 && v <= 200 {
		limit = v
	}
	if v, err := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64); err == nil && v > 0 {
		before = v
	}
	return
}

// canManageGroup reports whether user may rename/retopic the group, manage
// its membership, or pin messages in it: the owner, a group admin, or a
// site admin. Deleting the group and managing roles stay owner-only.
func (a *API) canManageGroup(group *db.Group, user *db.User) bool {
	if group.CreatedBy == user.ID || user.Role == "admin" {
		return true
	}
	role, err := a.db.GroupMemberRole(group.ID, user.ID)
	return err == nil && role == "admin"
}

func (a *API) handleListGroups(w http.ResponseWriter, r *http.Request) {
	me := auth.CurrentUser(r)
	groups, err := a.db.ListGroupsForUser(me.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not load groups")
		return
	}
	writeJSON(w, http.StatusOK, groups)
}

type createGroupRequest struct {
	Name      string  `json:"name"`
	MemberIDs []int64 `json:"member_ids"`
	// Public makes it a channel anyone on the server can find and join.
	Public bool `json:"public"`
}

func (a *API) handleCreateGroup(w http.ResponseWriter, r *http.Request) {
	me := auth.CurrentUser(r)
	var req createGroupRequest
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if len(req.Name) < 1 || len(req.Name) > 64 {
		writeErr(w, http.StatusBadRequest, "group name must be 1-64 characters")
		return
	}
	for _, id := range req.MemberIDs {
		if id == me.ID {
			continue
		}
		member, err := a.db.GetUserByID(id)
		if err != nil || member.Disabled {
			writeErr(w, http.StatusBadRequest, "member is unavailable")
			return
		}
	}
	group, err := a.db.CreateGroup(req.Name, me.ID, req.MemberIDs)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not create group")
		return
	}
	if req.Public {
		if err := a.db.SetGroupPublic(group.ID, true); err == nil {
			group.Public = true
		}
	}
	a.audit(r, "group_create", "group", &group.ID, "name="+group.Name)
	a.notifyGroup(group.ID)
	writeJSON(w, http.StatusCreated, group)
}

func (a *API) handleDeleteGroup(w http.ResponseWriter, r *http.Request) {
	me := auth.CurrentUser(r)
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid group id")
		return
	}
	group, err := a.db.GetGroup(id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "group not found")
		return
	}
	if group.CreatedBy != me.ID && me.Role != "admin" {
		writeErr(w, http.StatusForbidden, "only the group owner can delete it")
		return
	}
	members, _ := a.db.GroupMemberIDs(id)
	if err := a.db.DeleteGroup(id); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not delete group")
		return
	}
	a.notifyUsers(members)
	if closer, ok := a.hub.(interface{ CloseRoom(string) }); ok {
		closer.CloseRoom("group:" + strconv.FormatInt(id, 10))
	}
	a.audit(r, "group_delete", "group", &id, "name="+group.Name)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

type updateGroupRequest struct {
	Name         *string `json:"name"`
	Topic        *string `json:"topic"`
	AvatarFileID *int64  `json:"avatar_file_id"`
	Public       *bool   `json:"public"`
}

// handleRenameGroup also handles topic and icon updates despite the name —
// it's the one PATCH /api/groups/{id} endpoint for all group metadata.
func (a *API) handleRenameGroup(w http.ResponseWriter, r *http.Request) {
	me := auth.CurrentUser(r)
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid group id")
		return
	}
	group, err := a.db.GetGroup(id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "group not found")
		return
	}
	if !a.canManageGroup(group, me) {
		writeErr(w, http.StatusForbidden, "only the group owner or an admin can edit it")
		return
	}
	var req updateGroupRequest
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Name != nil {
		name := strings.TrimSpace(*req.Name)
		if len(name) < 1 || len(name) > 64 {
			writeErr(w, http.StatusBadRequest, "group name must be 1-64 characters")
			return
		}
		req.Name = &name
	}
	if req.Topic != nil {
		topic := strings.TrimSpace(*req.Topic)
		if len(topic) > 500 {
			writeErr(w, http.StatusBadRequest, "topic must be 500 characters or fewer")
			return
		}
		req.Topic = &topic
	}
	if req.Public != nil {
		if err := a.db.SetGroupPublic(id, *req.Public); err != nil {
			writeErr(w, http.StatusInternalServerError, "could not update group visibility")
			return
		}
	}
	if req.Name != nil || req.Topic != nil {
		if err := a.db.UpdateGroup(id, req.Name, req.Topic); err != nil {
			writeErr(w, http.StatusInternalServerError, "could not update group")
			return
		}
	}
	if req.AvatarFileID != nil {
		if *req.AvatarFileID == 0 {
			if err := a.db.SetGroupAvatar(id, nil); err != nil {
				writeErr(w, http.StatusInternalServerError, "could not clear group icon")
				return
			}
		} else {
			// Must be the caller's own upload: a group icon is readable by every
			// member (see CanAccessFile), so accepting any file id would let a
			// group owner read anyone's private image by id.
			file, err := a.db.GetFile(*req.AvatarFileID)
			if err != nil || file.UploaderID != me.ID || !strings.HasPrefix(file.Mime, "image/") {
				writeErr(w, http.StatusBadRequest, "group icon must be an image uploaded by you")
				return
			}
			if err := a.db.SetGroupAvatar(id, req.AvatarFileID); err != nil {
				writeErr(w, http.StatusInternalServerError, "could not set group icon")
				return
			}
		}
	}
	a.audit(r, "group_update", "group", &id, "")
	a.notifyGroup(id)
	group, err = a.db.GetGroup(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not reload group")
		return
	}
	writeJSON(w, http.StatusOK, group)
}

// handleSetGroupMemberRole promotes/demotes a member between "admin" and
// "member". Owner-only: role management doesn't delegate to group admins.
func (a *API) handleSetGroupMemberRole(w http.ResponseWriter, r *http.Request) {
	me := auth.CurrentUser(r)
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid group id")
		return
	}
	targetID, err := strconv.ParseInt(chi.URLParam(r, "userID"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid user id")
		return
	}
	group, err := a.db.GetGroup(id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "group not found")
		return
	}
	if group.CreatedBy != me.ID && me.Role != "admin" {
		writeErr(w, http.StatusForbidden, "only the group owner can manage roles")
		return
	}
	if targetID == group.CreatedBy {
		writeErr(w, http.StatusBadRequest, "the group owner's role can't be changed")
		return
	}
	var req struct {
		Role string `json:"role"`
	}
	if err := readJSON(r, &req); err != nil || (req.Role != "admin" && req.Role != "member") {
		writeErr(w, http.StatusBadRequest, `role must be "admin" or "member"`)
		return
	}
	if err := a.db.SetGroupMemberRole(id, targetID, req.Role); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not update role")
		return
	}
	a.audit(r, "group_set_role", "group", &id, fmt.Sprintf("user_id=%d role=%s", targetID, req.Role))
	a.notifyGroup(id)
	group, err = a.db.GetGroup(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not reload group")
		return
	}
	writeJSON(w, http.StatusOK, group)
}

// handleGroupReadState exposes the raw group_read_state rows so the client
// can compute a "seen by" indicator per message.
func (a *API) handleGroupReadState(w http.ResponseWriter, r *http.Request) {
	me := auth.CurrentUser(r)
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid group id")
		return
	}
	if member, err := a.db.IsGroupMember(id, me.ID); err != nil || !member {
		writeErr(w, http.StatusForbidden, "not a member of this group")
		return
	}
	states, err := a.db.GroupReadStates(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not load read state")
		return
	}
	writeJSON(w, http.StatusOK, states)
}

// handlePinnedMessages returns a conversation's pinned messages, newest
// first. Pass either ?group_id= or ?peer_id=.
func (a *API) handlePinnedMessages(w http.ResponseWriter, r *http.Request) {
	me := auth.CurrentUser(r)
	if v := r.URL.Query().Get("group_id"); v != "" {
		gid, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "invalid group id")
			return
		}
		if member, err := a.db.IsGroupMember(gid, me.ID); err != nil || !member {
			writeErr(w, http.StatusForbidden, "not a member of this group")
			return
		}
		msgs, err := a.db.PinnedInGroup(gid)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "could not load pinned messages")
			return
		}
		a.enrichMessages(msgs)
		writeJSON(w, http.StatusOK, msgs)
		return
	}
	if v := r.URL.Query().Get("peer_id"); v != "" {
		peerID, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "invalid peer id")
			return
		}
		msgs, err := a.db.PinnedInDM(me.ID, peerID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "could not load pinned messages")
			return
		}
		a.enrichMessages(msgs)
		writeJSON(w, http.StatusOK, msgs)
		return
	}
	writeErr(w, http.StatusBadRequest, "group_id or peer_id required")
}

// handleSearchMessages does a simple substring search over the caller's own
// conversations (their DMs and any group they belong to).
// handleSearchMessages supports a free-text query (?q=) plus optional
// filters: ?sender_id=, ?since=/?until= (RFC3339), ?has_file=true. At least
// one of q/sender_id/since/until/has_file must be given.
func (a *API) handleSearchMessages(w http.ResponseWriter, r *http.Request) {
	me := auth.CurrentUser(r)
	q := r.URL.Query()
	f := db.SearchFilter{Query: strings.TrimSpace(q.Get("q"))}
	if f.Query != "" && len(f.Query) < 2 {
		writeErr(w, http.StatusBadRequest, "search query must be at least 2 characters")
		return
	}
	if v := q.Get("sender_id"); v != "" {
		id, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "invalid sender_id")
			return
		}
		f.SenderID = id
	}
	f.Since = q.Get("since")
	f.Until = q.Get("until")
	f.HasFile = q.Get("has_file") == "true"
	if f.Query == "" && f.SenderID == 0 && f.Since == "" && f.Until == "" && !f.HasFile {
		writeErr(w, http.StatusBadRequest, "provide at least one of: q, sender_id, since, until, has_file")
		return
	}
	if v, err := strconv.Atoi(q.Get("limit")); err == nil && v > 0 && v <= 200 {
		f.Limit = v
	}
	msgs, err := a.db.SearchMessages(me.ID, f)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "search failed")
		return
	}
	a.enrichMessages(msgs)
	writeJSON(w, http.StatusOK, msgs)
}

// handleToggleSaveMessage stars/unstars a message as a personal bookmark.
// PUT saves, DELETE unsaves; both are idempotent.
func (a *API) handleToggleSaveMessage(w http.ResponseWriter, r *http.Request) {
	me := auth.CurrentUser(r)
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid message id")
		return
	}
	allowed, err := a.db.CanSeeMessage(id, me.ID)
	if err != nil || !allowed {
		writeErr(w, http.StatusNotFound, "message not found")
		return
	}
	if r.Method == http.MethodDelete {
		if err := a.db.UnsaveMessage(me.ID, id); err != nil {
			writeErr(w, http.StatusInternalServerError, "could not unsave message")
			return
		}
	} else {
		if err := a.db.SaveMessage(me.ID, id); err != nil {
			writeErr(w, http.StatusInternalServerError, "could not save message")
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *API) handleListSavedMessages(w http.ResponseWriter, r *http.Request) {
	me := auth.CurrentUser(r)
	msgs, err := a.db.ListSavedMessages(me.ID, 200)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not load saved messages")
		return
	}
	a.enrichMessages(msgs)
	writeJSON(w, http.StatusOK, msgs)
}

// handleExportMessages downloads the caller's full history with one peer or
// group as a JSON attachment.
func (a *API) handleExportMessages(w http.ResponseWriter, r *http.Request) {
	me := auth.CurrentUser(r)
	var msgs []*db.Message
	var filename string
	if v := r.URL.Query().Get("peer_id"); v != "" {
		peerID, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "invalid peer id")
			return
		}
		all, err := a.db.ListDirectMessages(me.ID, peerID, 0, 10_000)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "export failed")
			return
		}
		msgs = all
		filename = fmt.Sprintf("chat-dm-%d.json", peerID)
	} else if v := r.URL.Query().Get("group_id"); v != "" {
		gid, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "invalid group id")
			return
		}
		if member, err := a.db.IsGroupMember(gid, me.ID); err != nil || !member {
			writeErr(w, http.StatusForbidden, "not a member of this group")
			return
		}
		all, err := a.db.ListGroupMessages(gid, 0, 10_000)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "export failed")
			return
		}
		msgs = all
		filename = fmt.Sprintf("chat-group-%d.json", gid)
	} else {
		writeErr(w, http.StatusBadRequest, "group_id or peer_id required")
		return
	}
	a.enrichMessages(msgs)
	a.audit(r, "export", "messages", nil, filename)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	writeJSON(w, http.StatusOK, msgs)
}

type addGroupMembersRequest struct {
	MemberIDs []int64 `json:"member_ids"`
}

func (a *API) handleAddGroupMembers(w http.ResponseWriter, r *http.Request) {
	me := auth.CurrentUser(r)
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid group id")
		return
	}
	group, err := a.db.GetGroup(id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "group not found")
		return
	}
	if !a.canManageGroup(group, me) {
		writeErr(w, http.StatusForbidden, "only the group owner or an admin can add members")
		return
	}
	var req addGroupMembersRequest
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}
	for _, uid := range req.MemberIDs {
		member, err := a.db.GetUserByID(uid)
		if err != nil || member.Disabled {
			writeErr(w, http.StatusBadRequest, "member is unavailable")
			return
		}
	}
	if err := a.db.AddGroupMembers(id, req.MemberIDs); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not add members")
		return
	}
	a.audit(r, "group_add_members", "group", &id, fmt.Sprintf("%v", req.MemberIDs))
	a.notifyGroup(id)
	group, err = a.db.GetGroup(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not reload group")
		return
	}
	writeJSON(w, http.StatusOK, group)
}

// handleRemoveGroupMember drops a member from a group (self-removal is
// "leave"). If they're currently on that group's conference call, they are
// also evicted from it immediately via hub.EvictFromGroupRoom - "removed
// from the group" means off the call too, not "still watching until they
// personally hang up".
func (a *API) handleRemoveGroupMember(w http.ResponseWriter, r *http.Request) {
	me := auth.CurrentUser(r)
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid group id")
		return
	}
	targetID, err := strconv.ParseInt(chi.URLParam(r, "userID"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid user id")
		return
	}
	group, err := a.db.GetGroup(id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "group not found")
		return
	}
	isSelf := targetID == me.ID
	if !isSelf && !a.canManageGroup(group, me) {
		writeErr(w, http.StatusForbidden, "only the group owner or an admin can remove other members")
		return
	}
	if targetID == group.CreatedBy {
		writeErr(w, http.StatusBadRequest, "the group owner cannot be removed; delete the group instead")
		return
	}
	member, err := a.db.IsGroupMember(id, targetID)
	if err != nil || !member {
		writeErr(w, http.StatusNotFound, "not a member of this group")
		return
	}
	if err := a.db.RemoveGroupMember(id, targetID); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not remove member")
		return
	}
	if !isSelf {
		a.hub.EvictFromGroupRoom(id, targetID)
	}
	action := "group_remove_member"
	if isSelf {
		action = "group_leave"
	}
	a.audit(r, action, "group", &id, fmt.Sprintf("user_id=%d", targetID))
	a.notifyGroup(id)
	a.notifyUsers([]int64{targetID})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *API) handleGroupHistory(w http.ResponseWriter, r *http.Request) {
	me := auth.CurrentUser(r)
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid group id")
		return
	}
	member, err := a.db.IsGroupMember(id, me.ID)
	if err != nil || !member {
		writeErr(w, http.StatusForbidden, "you are not a member of this group")
		return
	}
	before, limit := paging(r)
	msgs, err := a.db.ListGroupMessages(id, before, limit)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not load messages")
		return
	}
	a.enrichMessages(msgs)
	writeJSON(w, http.StatusOK, msgs)
}

// notifyUsers tells each user's devices to reload their group list.
func (a *API) notifyUsers(ids []int64) {
	for _, id := range ids {
		a.hub.SendToUser(id, "group:changed", nil)
	}
}

// notifyGroup tells every current member of a group to reload their groups.
func (a *API) notifyGroup(groupID int64) {
	if ids, err := a.db.GroupMemberIDs(groupID); err == nil {
		a.notifyUsers(ids)
	}
}

// handleListConvoPrefs returns the caller's mute/archive settings.
func (a *API) handleListConvoPrefs(w http.ResponseWriter, r *http.Request) {
	prefs, err := a.db.ListConversationPrefs(auth.CurrentUser(r).ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not load conversation settings")
		return
	}
	writeJSON(w, http.StatusOK, prefs)
}

// handleSetConvoPref stores mute/archive for one DM or group, then tells the
// user's other devices so they stay in step.
func (a *API) handleSetConvoPref(w http.ResponseWriter, r *http.Request) {
	me := auth.CurrentUser(r)
	var p db.ConversationPref
	if err := readJSON(r, &p); err != nil || (p.Kind != "dm" && p.Kind != "group") || p.TargetID <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid conversation setting")
		return
	}
	if err := a.db.SetConversationPref(me.ID, p); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not save conversation setting")
		return
	}
	a.hub.SendToUser(me.ID, "conversation:prefs", p)
	writeJSON(w, http.StatusOK, p)
}

// handleUnreadSummary is a cheap "anything new?" check for clients whose
// realtime connection isn't running (a phone whose background service was
// stopped by the OS). It carries counts only, no message content.
func (a *API) handleUnreadSummary(w http.ResponseWriter, r *http.Request) {
	me := auth.CurrentUser(r)
	dms, err := a.db.UnreadDirectCounts(me.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not load unread counts")
		return
	}
	groups, err := a.db.GroupUnreadCounts(me.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not load unread counts")
		return
	}
	total := 0
	for _, n := range dms {
		total += n
	}
	for _, n := range groups {
		total += n
	}
	writeJSON(w, http.StatusOK, map[string]int{"total": total, "chats": len(dms) + len(groups)})
}

// ---- channels, blocking, threads, admin overview ----

// handleListPublicGroups lists channels the caller can join.
func (a *API) handleListPublicGroups(w http.ResponseWriter, r *http.Request) {
	groups, err := a.db.ListPublicGroups(auth.CurrentUser(r).ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not list channels")
		return
	}
	writeJSON(w, http.StatusOK, groups)
}

// handleJoinGroup lets anyone join a public channel.
func (a *API) handleJoinGroup(w http.ResponseWriter, r *http.Request) {
	me := auth.CurrentUser(r)
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || !a.db.IsGroupPublic(id) {
		writeErr(w, http.StatusNotFound, "channel not found")
		return
	}
	if err := a.db.AddGroupMembers(id, []int64{me.ID}); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not join channel")
		return
	}
	a.audit(r, "group_join", "group", &id, "")
	a.notifyGroup(id)
	group, err := a.db.GetGroup(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not load channel")
		return
	}
	writeJSON(w, http.StatusOK, group)
}

// handleAdminListGroups is the admin overview of every group and channel.
func (a *API) handleAdminListGroups(w http.ResponseWriter, r *http.Request) {
	groups, err := a.db.ListAllGroups()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not list groups")
		return
	}
	writeJSON(w, http.StatusOK, groups)
}

func (a *API) handleBlockUser(w http.ResponseWriter, r *http.Request) {
	me := auth.CurrentUser(r)
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id == me.ID {
		writeErr(w, http.StatusBadRequest, "invalid user")
		return
	}
	if _, err := a.db.GetUserByID(id); err != nil {
		writeErr(w, http.StatusNotFound, "user not found")
		return
	}
	if err := a.db.BlockUser(me.ID, id); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not block user")
		return
	}
	a.hub.SendToUser(me.ID, "blocks:changed", nil)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *API) handleUnblockUser(w http.ResponseWriter, r *http.Request) {
	me := auth.CurrentUser(r)
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid user")
		return
	}
	if err := a.db.UnblockUser(me.ID, id); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not unblock user")
		return
	}
	a.hub.SendToUser(me.ID, "blocks:changed", nil)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *API) handleListBlocked(w http.ResponseWriter, r *http.Request) {
	ids, err := a.db.ListBlocked(auth.CurrentUser(r).ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not load blocked users")
		return
	}
	writeJSON(w, http.StatusOK, ids)
}

// handleThread returns the replies inside one message's thread.
func (a *API) handleThread(w http.ResponseWriter, r *http.Request) {
	me := auth.CurrentUser(r)
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid message id")
		return
	}
	if ok, err := a.db.CanSeeMessage(id, me.ID); err != nil || !ok {
		writeErr(w, http.StatusNotFound, "message not found")
		return
	}
	msgs, err := a.db.ThreadReplies(id, 300)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not load thread")
		return
	}
	a.enrichMessages(msgs)
	writeJSON(w, http.StatusOK, msgs)
}
