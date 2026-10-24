package sfu

import (
	"fmt"
	"sync"
	"testing"
)

func noopSignal(string, any) {}

// TestEngineJoinLeaveConcurrent exercises concurrent joins/leaves/signaling
// lookups on shared rooms. Run with -race: it reproduces the historic map race
// where Engine.Leave/lookup read Room.participants without Room.mu.
func TestEngineJoinLeaveConcurrent(t *testing.T) {
	e := NewEngine(Config{MaxParticipants: 8})
	var wg sync.WaitGroup
	for g := 0; g < 4; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 30; i++ {
				uid := int64(g*100 + i)
				if _, err := e.Join(fmt.Sprintf("group:%d", i%3), uid, "u", nil, true, false, "", noopSignal); err != nil {
					t.Errorf("join: %v", err)
					return
				}
				// concurrent signaling lookups while others join/leave
				_ = e.lookup(uid)
				e.HandleTrackState(uid, TrackState{Muted: true})
				e.Leave(uid)
			}
		}(g)
	}
	wg.Wait()
	if n := e.RoomCount(); n != 0 {
		t.Errorf("rooms left behind: %d", n)
	}
}

// TestRoomHostPromotion checks that the host role moves to the earliest
// remaining participant when the host leaves.
func TestRoomHostPromotion(t *testing.T) {
	e := NewEngine(Config{MaxParticipants: 8})
	parts, err := e.Join("group:1", 1, "a", nil, true, false, "", noopSignal)
	if err != nil {
		t.Fatalf("join: %v", err)
	}
	if !parts[0].Host {
		t.Fatal("first joiner should be host")
	}
	if _, err := e.Join("group:1", 2, "b", nil, true, false, "", noopSignal); err != nil {
		t.Fatalf("join2: %v", err)
	}
	e.Leave(1)
	room := e.rooms["group:1"]
	if room == nil {
		t.Fatal("room vanished with a participant left")
	}
	room.mu.Lock()
	p2 := room.participants[2]
	room.mu.Unlock()
	if p2 == nil || !p2.infoSnapshot().Host {
		t.Fatal("remaining participant should be promoted to host")
	}
}

// TestClaimHost: the room owner takes host from whoever joined first.
func TestClaimHost(t *testing.T) {
	e := NewEngine(Config{MaxParticipants: 8})
	defer e.Close()
	if _, err := e.Join("priv:X", 1, "guest", nil, false, false, "", noopSignal); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Join("priv:X", 2, "owner", nil, false, false, "", noopSignal); err != nil {
		t.Fatal(err)
	}
	e.ClaimHost("priv:X", 2)
	if e.lookup(1).infoSnapshot().Host || !e.lookup(2).infoSnapshot().Host {
		t.Fatal("owner should be the only host")
	}
}

// TestRejoinKeepsRoom: a page reload (rejoin without resume) while alone in
// a room must not close and recreate it — that re-rings the whole group.
func TestRejoinKeepsRoom(t *testing.T) {
	e := NewEngine(Config{MaxParticipants: 8})
	defer e.Close()
	var mu sync.Mutex
	kinds := map[string]int{}
	e.OnEvent = func(ev Event) { mu.Lock(); kinds[ev.Kind]++; mu.Unlock() }
	for i := 0; i < 2; i++ {
		if _, err := e.Join("group:1", 1, "a", nil, true, false, "", noopSignal); err != nil {
			t.Fatal(err)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if kinds[EventRoomCreated] != 1 || kinds[EventRoomClosed] != 0 {
		t.Fatalf("rejoin recreated the room: %v", kinds)
	}
	if !e.lookup(1).infoSnapshot().Host {
		t.Fatal("rejoined sole participant should be host")
	}
}
