package api

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"visioncall/internal/config"
	"visioncall/internal/db"
	"visioncall/internal/settings"
)

// newLoginTestAPI builds an API with a real in-memory DB, as the handler
// tests do, so login attempts hit the actual limiters.
func newLoginTestAPI(t *testing.T) *API {
	t.Helper()
	d, err := db.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	cfg := &config.Config{}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	a := New(cfg, d, nopHub{}, nil, settings.New(d, cfg, new(slog.LevelVar)), log)
	t.Cleanup(func() {
		a.Limiter().Stop()
		a.IPLimiter().Stop()
	})
	return a
}

func mustCreateUser(t *testing.T, d *db.DB, username, password string) {
	t.Helper()
	if _, err := d.CreateUser(username, username, mustHash(t, password), "user"); err != nil {
		t.Fatal(err)
	}
}

// loginAs posts to handleLogin as if from the given remote address.
func loginAs(a *API, remoteAddr, username, password string) *httptest.ResponseRecorder {
	body := strings.NewReader(`{"username": "` + username + `", "password": "` + password + `"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/login", body)
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = remoteAddr + ":12345"
	w := httptest.NewRecorder()
	a.handleLogin(w, req)
	return w
}

// TestLoginFailureByOneUserDoesNotLockOutOthers is the regression test for
// the shared per-IP lockout: everyone behind one NAT/VPN gateway shares an
// IP, so one account's repeated wrong passwords must not lock out a
// different user signing in correctly from the same address.
func TestLoginFailureByOneUserDoesNotLockOutOthers(t *testing.T) {
	a := newLoginTestAPI(t)
	mustCreateUser(t, a.db, "alice", "alice-pass-1234")
	mustCreateUser(t, a.db, "bob", "bob-pass-123456")

	// Alice's client keeps retrying a stale password. After the per-username
	// cap (5) engages, the server answers 429 — that is correct; what must
	// never happen is bob being locked out afterwards.
	for i := 0; i < 40; i++ {
		w := loginAs(a, "10.0.0.7", "alice", "stale-password")
		if w.Code != http.StatusUnauthorized && w.Code != http.StatusTooManyRequests {
			t.Fatalf("attempt %d: expected 401 or 429 for a wrong password, got %d", i, w.Code)
		}
	}

	// Bob, same IP, CORRECT password, must still get in.
	w := loginAs(a, "10.0.0.7", "bob", "bob-pass-123456")
	if w.Code != http.StatusOK {
		t.Fatalf("bob's correct login from the same IP got %d: %s", w.Code, w.Body.String())
	}
}

// TestLoginUnknownUserDoesNotLockOutOthers: guessing at nonexistent
// usernames from one address must not lock out real users either.
func TestLoginUnknownUserDoesNotLockOutOthers(t *testing.T) {
	a := newLoginTestAPI(t)
	mustCreateUser(t, a.db, "carol", "carol-pass-12345")
	for i := 0; i < 40; i++ {
		loginAs(a, "10.0.0.8", "ghost", "whatever")
	}
	w := loginAs(a, "10.0.0.8", "carol", "carol-pass-12345")
	if w.Code != http.StatusOK {
		t.Fatalf("carol's correct login after unknown-user spray got %d: %s", w.Code, w.Body.String())
	}
}

// TestLoginSprayAcrossUsernamesIsStillLimited: the fix must not remove the
// spray guard — wrong-password attempts across several real usernames from
// one source must eventually hit the per-IP cap.
func TestLoginSprayAcrossUsernamesIsStillLimited(t *testing.T) {
	a := newLoginTestAPI(t)
	const count = 12
	for i := 0; i < count; i++ {
		mustCreateUser(t, a.db, sprayUser(i), "real-pass-"+string(rune('a'+i))+"-123456")
	}
	// 12 accounts × 5 wrong-password attempts each = 60 genuine failures
	// from one address; the per-username cap never engages (5 per account
	// is exactly reached on the last batch), so only the per-IP cap can
	// stop this.
	sawLimit := false
	for i := 0; i < count; i++ {
		for attempt := 0; attempt < 5; attempt++ {
			w := loginAs(a, "10.0.0.9", sprayUser(i), "whatever")
			if w.Code == http.StatusTooManyRequests {
				sawLimit = true
				break
			}
			if w.Code != http.StatusUnauthorized {
				t.Fatalf("user %d attempt %d: expected 401, got %d", i, attempt, w.Code)
			}
		}
		if sawLimit {
			break
		}
	}
	if !sawLimit {
		t.Fatal("per-IP spray guard never engaged after 60 wrong-password attempts across 12 accounts")
	}
}

// TestLoginSuccessfulAttemptRefundsIPBudget: a successful login must return
// the shared IP reservation, so normal sign-ins don't eat into the spray
// budget of everyone behind the same address.
func TestLoginSuccessfulAttemptRefundsIPBudget(t *testing.T) {
	a := newLoginTestAPI(t)
	mustCreateUser(t, a.db, "dave", "dave-pass-123456")
	const ip = "10.0.0.10"
	for i := 0; i < 25; i++ {
		w := loginAs(a, ip, "dave", "dave-pass-123456")
		if w.Code != http.StatusOK {
			t.Fatalf("successful login %d got %d: %s", i, w.Code, w.Body.String())
		}
	}
	// 25 successful logins + a handful of failures must stay under the
	// per-IP cap of 30 failures/15min.
	for i := 0; i < 4; i++ {
		if w := loginAs(a, ip, "dave", "wrong"); w.Code != http.StatusUnauthorized {
			t.Fatalf("failure %d: expected 401, got %d", i, w.Code)
		}
	}
	if w := loginAs(a, ip, "dave", "dave-pass-123456"); w.Code != http.StatusOK {
		t.Fatalf("correct login after mixed traffic got %d: %s", w.Code, w.Body.String())
	}
}

// TestLoginWrongPasswordStillCountsTowardIPLimit: a wrong password must
// consume the IP budget (the spray guard), not just the per-username one.
func TestLoginWrongPasswordStillCountsTowardIPLimit(t *testing.T) {
	a := newLoginTestAPI(t)
	mustCreateUser(t, a.db, "erin", "erin-pass-123456")
	limited := false
	for i := 0; i < 35; i++ {
		w := loginAs(a, "10.0.0.11", "erin", "wrong")
		if w.Code == http.StatusTooManyRequests {
			limited = true
			break
		}
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d: expected 401, got %d", i, w.Code)
		}
	}
	if !limited {
		t.Fatal("wrong-password attempts never hit the per-IP cap")
	}
}

func sprayUser(i int) string {
	return "spray" + string(rune('a'+i%26)) + string(rune('0'+i/26%10)) + string(rune('0'+i/260%10))
}
