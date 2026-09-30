package db

import "testing"

func TestPollsThreadsBlocksAndChannels(t *testing.T) {
	d := openTestDB(t)
	a, _ := d.CreateUser("a", "A", "h", "user")
	b, _ := d.CreateUser("b", "B", "h", "user")
	g, err := d.CreateGroup("General", a.ID, nil)
	if err != nil {
		t.Fatal(err)
	}

	// channels: public groups can be discovered by non-members, then joined
	if list, _ := d.ListPublicGroups(b.ID); len(list) != 0 {
		t.Fatal("private group listed as public")
	}
	if err := d.SetGroupPublic(g.ID, true); err != nil {
		t.Fatal(err)
	}
	list, _ := d.ListPublicGroups(b.ID)
	if len(list) != 1 || !list[0].Public || list[0].MemberCount != 1 {
		t.Fatalf("public list = %+v", list)
	}
	if list, _ := d.ListPublicGroups(a.ID); len(list) != 0 {
		t.Fatal("member should not be offered their own channel")
	}
	_ = d.AddGroupMembers(g.ID, []int64{b.ID})
	if mine, _ := d.ListGroupsForUser(b.ID); len(mine) != 1 || !mine[0].Public {
		t.Fatal("joined channel missing or not marked public")
	}

	// polls: single choice replaces the earlier vote, multi keeps both, toggling removes
	m, _ := d.InsertMessage(a.ID, nil, &g.ID, nil, nil, "Lunch?")
	if err := d.CreatePoll(m.ID, "Lunch?", []string{"Pizza", "Sushi"}, false); err != nil {
		t.Fatal(err)
	}
	polls, _ := d.PollsForMessages([]int64{m.ID})
	p := polls[m.ID]
	if p == nil || len(p.Options) != 2 {
		t.Fatalf("poll = %+v", p)
	}
	_ = d.VotePoll(p.ID, p.Options[0].ID, b.ID)
	_ = d.VotePoll(p.ID, p.Options[1].ID, b.ID)
	p = func() *Poll { x, _ := d.PollsForMessages([]int64{m.ID}); return x[m.ID] }()
	if len(p.Options[0].Votes) != 0 || len(p.Options[1].Votes) != 1 {
		t.Fatalf("single-choice votes = %+v", p.Options)
	}
	_ = d.VotePoll(p.ID, p.Options[1].ID, b.ID)
	p = func() *Poll { x, _ := d.PollsForMessages([]int64{m.ID}); return x[m.ID] }()
	if len(p.Options[1].Votes) != 0 {
		t.Fatal("voting twice should remove the vote")
	}
	_ = d.ClosePoll(p.ID)
	if err := d.VotePoll(p.ID, p.Options[0].ID, b.ID); err != ErrPollClosed {
		t.Fatalf("closed poll accepted a vote: %v", err)
	}

	// threads
	r, _ := d.InsertMessage(b.ID, nil, &g.ID, nil, nil, "in thread")
	if err := d.SetThreadRoot(r.ID, m.ID); err != nil {
		t.Fatal(err)
	}
	if n, _ := d.ThreadCounts([]int64{m.ID}); n[m.ID] != 1 {
		t.Fatalf("thread count = %v", n)
	}
	if replies, _ := d.ThreadReplies(m.ID, 10); len(replies) != 1 || replies[0].ThreadRootID == nil || *replies[0].ThreadRootID != m.ID {
		t.Fatalf("replies = %+v", replies)
	}

	// blocking works in both directions and can be undone
	if d.IsBlockedEitherWay(a.ID, b.ID) {
		t.Fatal("blocked by default")
	}
	_ = d.BlockUser(a.ID, b.ID)
	if !d.IsBlockedEitherWay(b.ID, a.ID) {
		t.Fatal("block not seen from the other side")
	}
	_ = d.UnblockUser(a.ID, b.ID)
	if d.IsBlockedEitherWay(a.ID, b.ID) {
		t.Fatal("unblock ignored")
	}
}
