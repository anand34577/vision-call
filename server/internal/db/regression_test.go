package db

import (
	"testing"
	"time"
)

// TestDirectMessagesPaging: the ?before cursor must apply to both directions
// of a DM (it used to bind only to the last OR branch).
func TestDirectMessagesPaging(t *testing.T) {
	d := openTestDB(t)
	a, _ := d.CreateUser("alice", "Alice", "h", "user")
	b, _ := d.CreateUser("bob", "Bob", "h", "user")
	var ids []int64
	for i := 0; i < 10; i++ {
		m1, _ := d.InsertMessage(a.ID, &b.ID, nil, nil, nil, "a->b")
		m2, _ := d.InsertMessage(b.ID, &a.ID, nil, nil, nil, "b->a")
		ids = append(ids, m1.ID, m2.ID)
	}
	before := ids[4]
	got, err := d.ListDirectMessages(a.ID, b.ID, before, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 4 {
		t.Fatalf("want the 4 messages older than %d, got %d", before, len(got))
	}
	for _, m := range got {
		if m.ID >= before {
			t.Errorf("paging leak: id %d >= before %d", m.ID, before)
		}
	}
}

// TestRecentConversations: one latest message per DM peer and per group, and
// the user's own group messages never show up as a DM "peer".
func TestRecentConversations(t *testing.T) {
	d := openTestDB(t)
	a, _ := d.CreateUser("alice", "Alice", "h", "user")
	b, _ := d.CreateUser("bob", "Bob", "h", "user")
	g, _ := d.CreateGroup("team", a.ID, []int64{b.ID})
	d.InsertMessage(a.ID, &b.ID, nil, nil, nil, "old")
	last, _ := d.InsertMessage(b.ID, &a.ID, nil, nil, nil, "new")
	d.InsertMessage(a.ID, nil, &g.ID, nil, nil, "group 1")
	glast, _ := d.InsertMessage(a.ID, nil, &g.ID, nil, nil, "group 2")

	peers, err := d.RecentDirectPeers(a.ID, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(peers) != 1 || peers[b.ID] == nil || peers[b.ID].ID != last.ID {
		t.Fatalf("want only bob's latest DM, got %+v", peers)
	}
	groups, err := d.RecentGroupMessages(a.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(groups) != 1 || groups[0].ID != glast.ID {
		t.Fatalf("want latest group message %d, got %+v", glast.ID, groups)
	}
}

// TestListGroupsForUserBatched: the batched query returns each of the user's
// groups once, with all of its members.
func TestListGroupsForUserBatched(t *testing.T) {
	d := openTestDB(t)
	a, _ := d.CreateUser("alice", "Alice", "h", "user")
	b, _ := d.CreateUser("bob", "Bob", "h", "user")
	c, _ := d.CreateUser("carol", "Carol", "h", "user")
	d.CreateGroup("one", a.ID, []int64{b.ID, c.ID})
	d.CreateGroup("two", b.ID, []int64{a.ID})
	d.CreateGroup("not mine", b.ID, []int64{c.ID})
	gs, err := d.ListGroupsForUser(a.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(gs) != 2 || len(gs[0].Members) != 3 || len(gs[1].Members) != 2 {
		t.Fatalf("unexpected groups/members: %+v", gs)
	}
}

// TestMarkGroupReadUpsert exercises the table-qualified upsert (the form
// Postgres needs) on sqlite: the stored marker only ever moves forward.
func TestMarkGroupReadUpsert(t *testing.T) {
	d := openTestDB(t)
	a, _ := d.CreateUser("alice", "Alice", "h", "user")
	b, _ := d.CreateUser("bob", "Bob", "h", "user")
	g, _ := d.CreateGroup("team", a.ID, []int64{b.ID})
	d.InsertMessage(a.ID, nil, &g.ID, nil, nil, "1")
	if err := d.MarkGroupRead(g.ID, b.ID); err != nil {
		t.Fatal(err)
	}
	m2, _ := d.InsertMessage(a.ID, nil, &g.ID, nil, nil, "2")
	if err := d.MarkGroupRead(g.ID, b.ID); err != nil {
		t.Fatal(err)
	}
	states, _ := d.GroupReadStates(g.ID)
	if states[b.ID] != m2.ID {
		t.Fatalf("want last read %d, got %d", m2.ID, states[b.ID])
	}
}

// TestCallParticipantRejoinUpsert exercises the table-qualified ON CONFLICT update.
func TestCallParticipantRejoinUpsert(t *testing.T) {
	d := openTestDB(t)
	a, _ := d.CreateUser("alice", "Alice", "h", "user")
	b, _ := d.CreateUser("bob", "Bob", "h", "user")
	c, _ := d.CreateCall("r", a.ID, true)
	if err := d.AddCallParticipant(c.ID, b.ID, false); err != nil {
		t.Fatal(err)
	}
	if err := d.AddCallParticipant(c.ID, b.ID, true); err != nil {
		t.Fatal(err)
	}
	calls, _ := d.ListCallsForUser(b.ID, 10)
	if len(calls) != 1 || calls[0].Participants[0].Missed || calls[0].Participants[0].JoinedAt == nil {
		t.Fatalf("rejoin should clear missed and set joined_at: %+v", calls)
	}
}

// TestDeleteOrphanFiles: only old, unreferenced uploads are removed, and
// their bytes stop counting toward the uploader's quota.
func TestDeleteOrphanFiles(t *testing.T) {
	d := openTestDB(t)
	a, _ := d.CreateUser("alice", "Alice", "h", "user")
	b, _ := d.CreateUser("bob", "Bob", "h", "user")
	orphan, _ := d.InsertFile(a.ID, "o.txt", "text/plain", 1, "/data/files/o")
	attached, _ := d.InsertFile(a.ID, "a.txt", "text/plain", 1, "/data/files/a")
	avatar, _ := d.InsertFile(a.ID, "av.png", "image/png", 1, "/data/files/av")
	deleted, _ := d.InsertFile(a.ID, "d.txt", "text/plain", 1, "/data/files/d")
	d.InsertMessage(a.ID, &b.ID, nil, &attached.ID, nil, "")
	d.SetUserAvatar(a.ID, &avatar.ID)
	m, _ := d.InsertMessage(a.ID, &b.ID, nil, &deleted.ID, nil, "")
	d.DeleteMessage(m.ID, a.ID) // clears file_id: its file is now an orphan

	if paths, _ := d.DeleteOrphanFiles(time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)); len(paths) != 0 {
		t.Fatalf("fresh uploads must survive the age cutoff, removed %v", paths)
	}
	paths, err := d.DeleteOrphanFiles(time.Now().Add(time.Hour).UTC().Format(time.RFC3339))
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) != 2 {
		t.Fatalf("want orphan + deleted-attachment removed, got %v", paths)
	}
	if _, err := d.GetFile(orphan.ID); err != ErrNotFound {
		t.Error("orphan row should be gone")
	}
	if _, err := d.GetFile(attached.ID); err != nil {
		t.Error("attached file must be kept")
	}
	if used, _ := d.SumFileBytesForUploader(a.ID); used != 2 {
		t.Errorf("quota should drop to the 2 kept files, got %d", used)
	}
}

// A literal % or _ in a search must match itself, not act as a wildcard.
func TestSearchTreatsWildcardsLiterally(t *testing.T) {
	d := openTestDB(t)
	a, _ := d.CreateUser("a", "A", "h", "user")
	b, _ := d.CreateUser("b", "B", "h", "user")
	_, _ = d.InsertMessage(a.ID, &b.ID, nil, nil, nil, "100% done")
	_, _ = d.InsertMessage(a.ID, &b.ID, nil, nil, nil, "hello there")
	got, err := d.SearchMessages(a.ID, SearchFilter{Query: "0%"})
	if err != nil || len(got) != 1 {
		t.Fatalf("got %d results, err %v; want 1", len(got), err)
	}
	if got, _ := d.SearchMessages(a.ID, SearchFilter{Query: "h_llo"}); len(got) != 0 {
		t.Fatal("underscore acted as wildcard")
	}
}
