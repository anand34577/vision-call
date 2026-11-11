package api

import (
	"testing"

	"visioncall/internal/auth"
)

func mustHash(t *testing.T, password string) string {
	t.Helper()
	h, err := auth.HashPassword(password)
	if err != nil {
		t.Fatal(err)
	}
	return h
}
