package auth

import (
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"visioncall/internal/db"
)

func TestHashPasswordRoundTrip(t *testing.T) {
	hash, err := HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	ok, err := VerifyPassword(hash, "correct horse battery staple")
	if err != nil || !ok {
		t.Fatalf("VerifyPassword(correct) = %v, %v; want true, nil", ok, err)
	}
	ok, err = VerifyPassword(hash, "wrong password")
	if err != nil || ok {
		t.Fatalf("VerifyPassword(wrong) = %v, %v; want false, nil", ok, err)
	}
	// The anonymized-account placeholder hash (db.unusablePasswordHash) must
	// never verify against anything.
	if ok, _ := VerifyPassword(`$argon2id$v=19$m=0,t=0,p=0$-$-`, "anything"); ok {
		t.Fatal("unusable placeholder hash must never verify")
	}
}

func TestTokenRoundTrip(t *testing.T) {
	secret := []byte("test-secret")
	token, err := MintToken(secret, 42, "sess-1", "admin", time.Hour)
	if err != nil {
		t.Fatalf("MintToken: %v", err)
	}
	claims, err := ParseToken(secret, token)
	if err != nil {
		t.Fatalf("ParseToken: %v", err)
	}
	if claims.UserID != 42 || claims.SessionID != "sess-1" || claims.Role != "admin" {
		t.Fatalf("unexpected claims: %+v", claims)
	}
	if _, err := ParseToken([]byte("wrong-secret"), token); err == nil {
		t.Fatal("ParseToken should reject a token signed with a different secret")
	}
}

func TestLoginLimiter(t *testing.T) {
	l := NewLoginLimiter()
	defer l.Stop()
	l.max = 3
	key := "user|1.2.3.4"
	for i := 0; i < 3; i++ {
		if !l.Reserve(key) {
			t.Fatalf("attempt %d should still be allowed", i)
		}
	}
	if l.Reserve(key) {
		t.Fatal("should be locked out after max failures")
	}
	l.Success(key)
	if !l.Reserve(key) {
		t.Fatal("a success should clear the lockout")
	}
}

func TestLoginLimiterReserveConcurrentRace(t *testing.T) {
	l := NewLoginLimiter()
	defer l.Stop()
	l.max = 5
	key := "user|1.2.3.4"

	var wg sync.WaitGroup
	var allowed int32
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if l.Reserve(key) {
				atomic.AddInt32(&allowed, 1)
			}
		}()
	}
	wg.Wait()
	if allowed != 5 {
		t.Fatalf("expected exactly max=5 reservations to succeed under concurrency, got %d", allowed)
	}
}

// TestLimiterRefund: a refund gives back one attempt without wiping the
// counter the way Success does.
func TestLimiterRefund(t *testing.T) {
	l := newLoginLimiter(2, time.Minute)
	defer l.Stop()
	l.Reserve("ip")
	l.Reserve("ip")
	if l.Allowed("ip") {
		t.Fatal("should be at the cap")
	}
	l.Refund("ip")
	if !l.Reserve("ip") || l.Reserve("ip") {
		t.Fatal("refund should free exactly one attempt")
	}
}

// TestRealIPRightmostForwarded: only the hop the trusted proxy appended counts.
func TestRealIPRightmostForwarded(t *testing.T) {
	r, _ := http.NewRequest("GET", "/", nil)
	r.RemoteAddr = "10.0.0.2:5555"
	r.Header.Set("X-Forwarded-For", "6.6.6.6, 192.168.1.20")
	if got := RealIP(r, true); got != "192.168.1.20" {
		t.Fatalf("want proxy-appended hop, got %s", got)
	}
	if got := RealIP(r, false); got != "10.0.0.2" {
		t.Fatalf("untrusted proxy headers must be ignored, got %s", got)
	}
}

func TestTOTPRFC6238Vector(t *testing.T) {
	// RFC 6238 appendix B, SHA-1 secret "12345678901234567890", T=59s -> 94287082 (last 6: 287082).
	secret := b32.EncodeToString([]byte("12345678901234567890"))
	if got, _ := totpCode(secret, 1); got != "287082" {
		t.Fatalf("totp = %s, want 287082", got)
	}
	if !VerifyTOTP(secret, "287082", time.Unix(59, 0)) || VerifyTOTP(secret, "000000", time.Unix(59, 0)) {
		t.Fatal("VerifyTOTP wrong")
	}
}

// A used session slides forward, an unused one is not extended, and the
// signed token itself never has to change.
func TestSessionSlidesWhileUsed(t *testing.T) {
	d, err := db.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	u, _ := d.CreateUser("bob", "Bob", "x", "user")
	secret := []byte("s")
	id, tok, _ := MintSession(secret, u.ID, "user")
	// 1h of a 720h session left: well inside the slide window.
	if err := d.CreateSession(id, u.ID, HashToken(tok), time.Now().Add(time.Hour), "ua", "1.1.1.1"); err != nil {
		t.Fatal(err)
	}
	if _, err := ValidateSession(d, secret, tok, 720*time.Hour); err != nil {
		t.Fatal(err)
	}
	_, exp, _, _ := d.GetSession(id)
	if time.Until(exp) < 700*time.Hour {
		t.Fatalf("session not extended: %v left", time.Until(exp))
	}
	// Expired sessions are rejected, not revived.
	id2, tok2, _ := MintSession(secret, u.ID, "user")
	_ = d.CreateSession(id2, u.ID, HashToken(tok2), time.Now().Add(-time.Minute), "", "")
	if _, err := ValidateSession(d, secret, tok2, 720*time.Hour); err == nil {
		t.Fatal("expired session accepted")
	}
}
