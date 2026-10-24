package api

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/go-chi/chi/v5"

	"visioncall/internal/auth"
	"visioncall/internal/config"
	"visioncall/internal/db"
	"visioncall/internal/settings"
)

// nopHub satisfies PresenceProvider for handler tests.
type nopHub struct{}

func (nopHub) GetPresence() map[int64]string           { return nil }
func (nopHub) OnlineCount() int                        { return 0 }
func (nopHub) ActiveCalls() int                        { return 0 }
func (nopHub) KickUser(int64, string)                  {}
func (nopHub) KickSession(int64, string, string)       {}
func (nopHub) KickOtherSessions(int64, string, string) {}
func (nopHub) SendToUser(int64, string, any) bool      { return false }
func (nopHub) DirectoryChanged()                       {}
func (nopHub) AccountUpdated(int64)                    {}
func (nopHub) EvictFromGroupRoom(int64, int64) bool    { return false }

// TestGroupAdminCannotRemoveAdmin: a group admin may remove members but not
// another admin; the owner may remove either.
func TestGroupAdminCannotRemoveAdmin(t *testing.T) {
	d, err := db.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	cfg := &config.Config{}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	a := New(cfg, d, nopHub{}, nil, settings.New(d, cfg, new(slog.LevelVar)), log)

	mk := func(name string) *db.User {
		u, err := d.CreateUser(name, name, "x", "user")
		if err != nil {
			t.Fatal(err)
		}
		return u
	}
	owner, adm1, adm2, member := mk("owner"), mk("adm1"), mk("adm2"), mk("member")
	g, err := d.CreateGroup("g", owner.ID, []int64{adm1.ID, adm2.ID, member.ID})
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []int64{adm1.ID, adm2.ID} {
		if err := d.SetGroupMemberRole(g.ID, id, "admin"); err != nil {
			t.Fatal(err)
		}
	}
	remove := func(as *db.User, target int64) int {
		rc := chi.NewRouteContext()
		rc.URLParams.Add("id", strconv.FormatInt(g.ID, 10))
		rc.URLParams.Add("userID", strconv.FormatInt(target, 10))
		ctx := context.WithValue(auth.WithUser(context.Background(), as), chi.RouteCtxKey, rc)
		w := httptest.NewRecorder()
		a.handleRemoveGroupMember(w, httptest.NewRequest(http.MethodDelete, "/", nil).WithContext(ctx))
		return w.Code
	}
	if c := remove(adm1, adm2.ID); c != http.StatusForbidden {
		t.Errorf("admin removing admin: got %d, want 403", c)
	}
	if c := remove(adm1, member.ID); c != http.StatusOK {
		t.Errorf("admin removing member: got %d, want 200", c)
	}
	if c := remove(owner, adm2.ID); c != http.StatusOK {
		t.Errorf("owner removing admin: got %d, want 200", c)
	}
}
