// Package oidc wires up optional SSO login via any standards-compliant
// OpenID Connect provider (Keycloak, Authentik, Entra ID, Okta, Google
// Workspace, …). Entirely inert unless OIDC_ISSUER_URL is configured — the
// rest of the app has zero dependency on it.
package oidc

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	gooidc "github.com/coreos/go-oidc/v3/oidc"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/oauth2"
)

// Flow distinguishes "log me in as whoever this identity already maps to"
// from "attach this identity to my currently logged-in account" — see the
// package doc on Manager.Exchange for why both exist.
type Flow string

const (
	FlowLogin Flow = "login"
	FlowLink  Flow = "link"
)

// stateClaims rides in the OAuth2 "state" parameter itself (signed, so no
// server-side session store is needed for the handshake) and carries the
// nonce the ID token must echo back.
type stateClaims struct {
	Flow       Flow   `json:"flow"`
	LinkUserID int64  `json:"link_uid,omitempty"`
	Nonce      string `json:"nonce"`
	// Bind is the hash of a random value the starting browser holds in a
	// cookie. Exchange requires it back, so a callback URL (code + state)
	// captured by an attacker can't be replayed in a victim's browser to log
	// the victim into the attacker's account (login CSRF).
	Bind string `json:"bind"`
	jwt.RegisteredClaims
}

// pkceVerifier derives the PKCE code_verifier from the browser binding cookie
// (known only to the starting browser) keyed with the server secret, so it
// needs no server-side storage and never appears in a URL.
func (m *Manager) pkceVerifier(binding string) string {
	mac := hmac.New(sha256.New, m.jwtSecret)
	mac.Write([]byte("pkce|" + binding))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func bindHash(binding string) string {
	sum := sha256.Sum256([]byte(binding))
	return hex.EncodeToString(sum[:])
}

// Identity is what a verified ID token reduces to: the durable
// (issuer, subject) key plus display hints for auto-provisioning.
type Identity struct {
	Issuer  string
	Subject string
	Email   string
	Name    string
	// EmailVerified is the IdP's email_verified claim; unverified addresses
	// must not be trusted for usernames or account recovery.
	EmailVerified bool
}

// Manager's provider discovery (a network call to the IdP) happens either
// synchronously in New, or - if the IdP isn't reachable yet - in a retrying
// background goroutine, so a briefly-unreachable optional SSO provider can
// never block or crash the rest of the app at startup. mu guards the fields
// that discovery fills in; ready gates every method that needs them.
type Manager struct {
	mu       sync.RWMutex
	ready    bool
	verifier *gooidc.IDTokenVerifier
	provider *gooidc.Provider

	oauth2Config oauth2.Config // Endpoint is zero-value until discovery succeeds
	clientID     string
	jwtSecret    []byte
	issuer       string
}

// Config is the caller-facing setup; New returns (nil, nil) when IssuerURL
// is empty so callers can treat a nil *Manager as "OIDC disabled" without a
// separate feature flag to keep in sync. Auto-create-users is deliberately
// not here - unlike these fields, it's read live from the settings store on
// every login (see api.finishOIDCLogin) rather than fixed at construction.
type Config struct {
	IssuerURL    string
	ClientID     string
	ClientSecret string
	RedirectURL  string
	Scopes       []string // defaults to {"openid", "profile", "email"} if empty
	JWTSecret    []byte
}

// New validates OIDC configuration synchronously (fast, local, no network -
// a mistake here really is fatal and should stop the app at boot) but never
// blocks or fails startup on the IdP discovery call itself: if the issuer
// isn't reachable yet, New logs a warning and keeps retrying discovery in
// the background so a transient IdP outage degrades only SSO login, not the
// whole app (which has zero other dependency on OIDC).
func New(ctx context.Context, cfg Config) (*Manager, error) {
	if cfg.IssuerURL == "" {
		return nil, nil
	}
	if cfg.ClientID == "" || cfg.ClientSecret == "" || cfg.RedirectURL == "" {
		return nil, errors.New("OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, and OIDC_REDIRECT_URL are required when OIDC_ISSUER_URL is set")
	}
	scopes := cfg.Scopes
	if len(scopes) == 0 {
		scopes = []string{gooidc.ScopeOpenID, "profile", "email"}
	}
	m := &Manager{
		oauth2Config: oauth2.Config{
			ClientID:     cfg.ClientID,
			ClientSecret: cfg.ClientSecret,
			RedirectURL:  cfg.RedirectURL,
			Scopes:       scopes,
		},
		clientID:  cfg.ClientID,
		jwtSecret: cfg.JWTSecret,
		issuer:    cfg.IssuerURL,
	}

	discoverCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	err := m.discover(discoverCtx)
	cancel()
	if err != nil {
		slog.Default().Warn("oidc: identity provider unreachable at startup; SSO login is unavailable until it responds, everything else works normally", "issuer", cfg.IssuerURL, "err", err)
		go m.retryDiscoveryLoop()
	}
	return m, nil
}

// discover performs the one network call OIDC needs: fetching the
// provider's metadata document. Safe to call more than once (e.g. from the
// retry loop) - it only takes effect once, since ready latches true.
func (m *Manager) discover(ctx context.Context) error {
	provider, err := gooidc.NewProvider(ctx, m.issuer)
	if err != nil {
		return fmt.Errorf("discover OIDC provider at %s: %w", m.issuer, err)
	}
	m.mu.Lock()
	m.provider = provider
	m.oauth2Config.Endpoint = provider.Endpoint()
	m.verifier = provider.Verifier(&gooidc.Config{ClientID: m.clientID})
	m.ready = true
	m.mu.Unlock()
	return nil
}

// retryDiscoveryLoop keeps trying discovery with capped exponential backoff
// until it succeeds, then exits - so an admin doesn't need to restart the
// server once their IdP comes back up.
func (m *Manager) retryDiscoveryLoop() {
	backoff := 5 * time.Second
	const maxBackoff = 5 * time.Minute
	for {
		time.Sleep(backoff)
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		err := m.discover(ctx)
		cancel()
		if err == nil {
			slog.Default().Info("oidc: identity provider is now reachable; SSO login is available", "issuer", m.issuer)
			return
		}
		if backoff < maxBackoff {
			backoff *= 2
			if backoff > maxBackoff {
				backoff = maxBackoff
			}
		}
	}
}

// Ready reports whether provider discovery has completed - callers use this
// to show a clear "SSO temporarily unavailable" state instead of a generic
// error while the background retry loop is still working.
func (m *Manager) Ready() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.ready
}

func (m *Manager) Issuer() string { return m.issuer }

// AuthURL builds the provider redirect for either flow. linkUserID is only
// meaningful (and only trusted) for FlowLink.
func (m *Manager) AuthURL(flow Flow, linkUserID int64, binding string) (string, error) {
	m.mu.RLock()
	ready, cfg := m.ready, m.oauth2Config
	m.mu.RUnlock()
	if !ready {
		return "", errors.New("oidc: identity provider is not reachable yet; try again in a moment")
	}

	nonce, err := randomHex(16)
	if err != nil {
		return "", err
	}
	claims := &stateClaims{
		Flow:       flow,
		LinkUserID: linkUserID,
		Nonce:      nonce,
		Bind:       bindHash(binding),
		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(10 * time.Minute)),
		},
	}
	state, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(m.jwtSecret)
	if err != nil {
		return "", err
	}
	return cfg.AuthCodeURL(state, gooidc.Nonce(nonce), oauth2.S256ChallengeOption(m.pkceVerifier(binding))), nil
}

// Result is what a successful callback exchange yields: the verified
// identity and which flow/link-target it was for (echoed back from state).
type Result struct {
	Identity   Identity
	Flow       Flow
	LinkUserID int64
}

// Exchange verifies the state token, trades the auth code for tokens, and
// verifies the ID token (signature, issuer, audience, expiry, and nonce —
// all handled by go-oidc, not hand-rolled here).
func (m *Manager) Exchange(ctx context.Context, code, state, binding string) (*Result, error) {
	m.mu.RLock()
	ready, cfg, verifier := m.ready, m.oauth2Config, m.verifier
	m.mu.RUnlock()
	if !ready {
		return nil, errors.New("oidc: identity provider is not reachable yet; try again in a moment")
	}

	var claims stateClaims
	tok, err := jwt.ParseWithClaims(state, &claims, func(t *jwt.Token) (any, error) {
		if t.Method != jwt.SigningMethodHS256 {
			return nil, errors.New("oidc: unexpected state signing method")
		}
		return m.jwtSecret, nil
	})
	if err != nil || !tok.Valid {
		return nil, errors.New("oidc: invalid or expired login attempt, please try again")
	}
	if binding == "" || subtle.ConstantTimeCompare([]byte(claims.Bind), []byte(bindHash(binding))) != 1 {
		return nil, errors.New("oidc: login was not started from this browser")
	}

	oauth2Token, err := cfg.Exchange(ctx, code, oauth2.VerifierOption(m.pkceVerifier(binding)))
	if err != nil {
		return nil, fmt.Errorf("oidc: code exchange failed: %w", err)
	}
	rawIDToken, ok := oauth2Token.Extra("id_token").(string)
	if !ok {
		return nil, errors.New("oidc: provider did not return an id_token")
	}
	idToken, err := verifier.Verify(ctx, rawIDToken)
	if err != nil {
		return nil, fmt.Errorf("oidc: id_token verification failed: %w", err)
	}
	if idToken.Nonce != claims.Nonce {
		return nil, errors.New("oidc: nonce mismatch")
	}

	var std struct {
		Email         string `json:"email"`
		EmailVerified bool   `json:"email_verified"`
		Name          string `json:"name"`
	}
	if err := idToken.Claims(&std); err != nil {
		return nil, fmt.Errorf("oidc: reading claims: %w", err)
	}

	return &Result{
		Identity: Identity{
			Issuer:  idToken.Issuer,
			Subject: idToken.Subject,
			Email:   std.Email,
			Name:    std.Name,
			EmailVerified: std.EmailVerified,
		},
		Flow:       claims.Flow,
		LinkUserID: claims.LinkUserID,
	}, nil
}

func randomHex(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}
