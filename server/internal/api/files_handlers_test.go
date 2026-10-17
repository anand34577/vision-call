package api

import "testing"

func TestBlockedSegment(t *testing.T) {
	blocked := map[string]bool{".exe": true, ".ps1": true}
	for name, want := range map[string]string{
		"a.exe": ".exe", "A.PS1": ".ps1", "x.exe.txt": ".exe", "notes.txt": "", "noext": "",
	} {
		if got := blockedSegment(name, blocked); got != want {
			t.Errorf("%q: got %q want %q", name, got, want)
		}
	}
	if blockedSegment("a.exe", nil) != "" {
		t.Error("empty block-list must block nothing")
	}
}
