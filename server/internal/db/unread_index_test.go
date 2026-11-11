// Verifies the new unread index exists after migrations run.
package db

import (
	"testing"
)

func TestUnreadIndexExists(t *testing.T) {
	d, err := Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()

	var name string
	err = d.QueryRow(
		`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_unread_recipient'`,
	).Scan(&name)
	if err != nil {
		t.Fatalf("idx_messages_unread_recipient missing after migrations: %v", err)
	}

	// The query planner must actually use it for the unread-count shape.
	rows, err := d.Query(
		`EXPLAIN QUERY PLAN
		 SELECT sender_id, COUNT(*) FROM messages
		 WHERE recipient_id = ? AND read_at IS NULL GROUP BY sender_id`, 1,
	)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var detail string
	found := false
	for rows.Next() {
		var id, parent, notused int
		if err := rows.Scan(&id, &parent, &notused, &detail); err != nil {
			t.Fatal(err)
		}
		if detail == "SEARCH messages USING INDEX idx_messages_unread_recipient (recipient_id=?)" {
			found = true
		}
	}
	if !found {
		t.Fatalf("unread count query did not use the new index; plan: %q", detail)
	}
}
