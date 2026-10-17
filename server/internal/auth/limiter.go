package auth

import (
	"sync"
	"time"
)

// LoginLimiter allows a bounded number of failed attempts per key (user+IP)
// inside a rolling window. Successful logins clear the counter.
// A background goroutine periodically purges expired entries to prevent
// unbounded memory growth.
type LoginLimiter struct {
	mu        sync.Mutex
	attempts  map[string]*attempt
	max       int
	window    time.Duration
	stop      chan struct{}
	closeOnce sync.Once
}

type attempt struct {
	count int
	until time.Time
}

// NewLoginLimiter is the per-username(+IP) limiter: 5 failures/15min against
// one account. On its own this bounds guessing against a single username,
// but not a password-spray that tries a handful of guesses across many
// different usernames from one source — see NewIPLoginLimiter for that.
func NewLoginLimiter() *LoginLimiter {
	return newLoginLimiter(5, 15*time.Minute)
}

// NewIPLoginLimiter is the per-source-IP limiter: a much higher ceiling
// (this app is built for LAN use, where many legitimate users can share one
// IP behind NAT or a VPN gateway) that still catches a spray attack trying
// a few passwords against many usernames from a single IP, which the
// per-username limiter alone cannot.
func NewIPLoginLimiter() *LoginLimiter {
	return newLoginLimiter(30, 15*time.Minute)
}

// NewRateLimiter is a general fixed-window limiter: at most max Reserve calls
// per key per window.
func NewRateLimiter(max int, window time.Duration) *LoginLimiter {
	return newLoginLimiter(max, window)
}

func newLoginLimiter(max int, window time.Duration) *LoginLimiter {
	l := &LoginLimiter{
		attempts: map[string]*attempt{},
		max:      max,
		window:   window,
		stop:     make(chan struct{}),
	}
	go l.cleanupLoop()
	return l
}

// Stop halts the background cleanup goroutine. Safe to call multiple times.
func (l *LoginLimiter) Stop() {
	l.closeOnce.Do(func() { close(l.stop) })
}

// cleanupLoop removes expired entries every 5 minutes to cap memory usage.
func (l *LoginLimiter) cleanupLoop() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			now := time.Now()
			l.mu.Lock()
			for k, a := range l.attempts {
				if now.After(a.until) {
					delete(l.attempts, k)
				}
			}
			l.mu.Unlock()
		case <-l.stop:
			return
		}
	}
}

// Reserve atomically checks the key against the cap and, if allowed, counts
// this attempt immediately (before the caller does anything slow like
// hashing a password). Checking and counting under one lock closes a race
// that plain Allowed()-then-later-Fail() has: without it, a burst of
// concurrent requests can all pass Allowed() before any of them reaches
// Fail(), letting far more than `max` attempts through in that window.
// A caller that ends up not needing the reservation (a legit, unrelated
// request) is not expected — callers of Reserve should call Success on the
// happy path to clear the key, same as before.
func (l *LoginLimiter) Reserve(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	a, ok := l.attempts[key]
	if !ok || time.Now().After(a.until) {
		if !ok && len(l.attempts) >= maxLimiterEntries {
			l.evictExpiredLocked()
			if len(l.attempts) >= maxLimiterEntries {
				return false // fail closed rather than grow without bound
			}
		}
		a = &attempt{until: time.Now().Add(l.window)}
		l.attempts[key] = a
	}
	if a.count >= l.max {
		return false
	}
	a.count++
	return true
}

// maxLimiterEntries bounds the limiter map so unauthenticated callers can't
// grow it without limit by varying the key.
const maxLimiterEntries = 100_000

func (l *LoginLimiter) evictExpiredLocked() {
	now := time.Now()
	for k, a := range l.attempts {
		if now.After(a.until) {
			delete(l.attempts, k)
		}
	}
}

// Allowed reports whether key is currently under the cap, without counting
// an attempt. Kept for read-only checks; prefer Reserve when the caller is
// about to act on the result (e.g. attempt a login).
func (l *LoginLimiter) Allowed(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	a, ok := l.attempts[key]
	if !ok {
		return true
	}
	if time.Now().After(a.until) {
		delete(l.attempts, key)
		return true
	}
	return a.count < l.max
}

// Refund un-counts one attempt Reserve counted. Used for the per-IP limiter
// on a successful login: a real login shouldn't eat into a shared NAT's
// budget, but it also mustn't wipe the counter the way Success does — or an
// attacker could reset their own spray limit by logging into one account
// they control between guesses.
func (l *LoginLimiter) Refund(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if a, ok := l.attempts[key]; ok && a.count > 0 {
		a.count--
	}
}

func (l *LoginLimiter) Success(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.attempts, key)
}
