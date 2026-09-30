package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"visioncall/internal/db"
)

const CookieName = "vc_session"

// TokenLifetime is how long the signed token and its cookie stay valid. The
// real, shorter-lived limit is the session row's expires_at, which slides
// forward while the user is active (see ValidateSession) — so the token never
// needs re-issuing and parallel requests can't invalidate each other.
const TokenLifetime = 365 * 24 * time.Hour

type Claims struct {
	UserID    int64  `json:"uid"`
	SessionID string `json:"sid"`
	Role      string `json:"role"`
	jwt.RegisteredClaims
}

// MintToken creates a signed session token bound to a server-side session row.
func MintToken(secret []byte, userID int64, sessionID, role string, ttl time.Duration) (string, error) {
	claims := &Claims{
		UserID:    userID,
		SessionID: sessionID,
		Role:      role,
		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(ttl)),
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(secret)
}

func ParseToken(secret []byte, raw string) (*Claims, error) {
	token, err := jwt.ParseWithClaims(raw, &Claims{}, func(t *jwt.Token) (any, error) {
		if t.Method != jwt.SigningMethodHS256 {
			return nil, errors.New("auth: unexpected signing method")
		}
		return secret, nil
	})
	if err != nil {
		return nil, err
	}
	claims, ok := token.Claims.(*Claims)
	if !ok || !token.Valid {
		return nil, errors.New("auth: invalid token")
	}
	return claims, nil
}

// MintSession generates a fresh session id and a signed token bound to it.
func MintSession(secret []byte, userID int64, role string) (sessionID, token string, err error) {
	buf := make([]byte, 16)
	if _, err = rand.Read(buf); err != nil {
		return "", "", err
	}
	sessionID = hex.EncodeToString(buf)
	token, err = MintToken(secret, userID, sessionID, role, TokenLifetime)
	return sessionID, token, err
}

func HashToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

// ValidateSession checks a raw token against its stored session row and returns
// the owning user. Used by both HTTP middleware and the WebSocket upgrade.
// slide is the inactivity timeout: while a session is used, its expiry is
// pushed out to now+slide (at most every ten minutes). 0 disables sliding.
func ValidateSession(dbh *db.DB, secret []byte, rawToken string, slide time.Duration) (*db.User, error) {
	claims, err := ParseToken(secret, rawToken)
	if err != nil {
		return nil, err
	}
	tokenHash, expires, sessionUserID, err := dbh.GetSession(claims.SessionID)
	if err != nil {
		return nil, err
	}
	if time.Now().After(expires) {
		dbh.DeleteSession(claims.SessionID)
		return nil, errors.New("auth: session expired")
	}
	if sessionUserID != claims.UserID {
		return nil, errors.New("auth: session user mismatch")
	}
	if subtle.ConstantTimeCompare([]byte(tokenHash), []byte(HashToken(rawToken))) != 1 {
		return nil, errors.New("auth: token does not match session")
	}
	user, err := dbh.GetUserByID(claims.UserID)
	if err != nil {
		return nil, err
	}
	if user.Disabled {
		return nil, errors.New("auth: user disabled")
	}
	if slide > 0 && time.Until(expires) < slide-10*time.Minute {
		_ = dbh.ExtendSession(claims.SessionID, time.Now().Add(slide))
	}
	return user, nil
}
