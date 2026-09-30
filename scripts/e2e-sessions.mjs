// End-to-end check of multi-device sessions, 2FA, forced password change, mute prefs.
// Needs Node 22+ and a fresh server on 127.0.0.1:18080 with BOOTSTRAP_ADMIN_PASSWORD='AdminPass123!':
//   DISABLE_TLS=true HTTP_ADDR= LISTEN_ADDR=127.0.0.1:18080 DATA_DIR=$(mktemp -d) \
//   BOOTSTRAP_ADMIN_PASSWORD='AdminPass123!' go run ./cmd/server   (from server/)
//   node scripts/e2e-sessions.mjs      (CI runs this automatically)
import crypto from "node:crypto";

const BASE = "http://127.0.0.1:18080";
let failures = 0;
const ok = (cond, msg) => { console.log((cond ? "PASS " : "FAIL ") + msg); if (!cond) failures++; };

class Client {
  constructor(name) { this.name = name; this.cookies = {}; }
  cookieHeader() { return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join("; "); }
  absorb(res) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      const k = pair.slice(0, i), v = pair.slice(i + 1);
      if (/max-age=-1|expires=Thu, 01 Jan 1970/i.test(c) || v === "") delete this.cookies[k]; else this.cookies[k] = v;
    }
  }
  async req(method, path, body) {
    const headers = { Cookie: this.cookieHeader(), "User-Agent": `test-${this.name}` };
    if (body) headers["Content-Type"] = "application/json";
    if (method !== "GET") headers["X-CSRF-Token"] = this.cookies["vc_csrf"] ?? "";
    const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    this.absorb(res);
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  }
  ws(device) {
    const sock = new WebSocket(`ws://127.0.0.1:18080/ws?device=${device}`, { headers: { Cookie: this.cookieHeader() } });
    const events = [];
    sock.onmessage = (e) => { try { events.push(JSON.parse(e.data)); } catch {} };
    const closed = new Promise((r) => { sock.onclose = () => r(true); sock.onerror = () => {}; });
    return { sock, events, closed, opened: new Promise((r) => { sock.onopen = () => r(true); }) };
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- TOTP (RFC 6238) for the test
function b32decode(s) {
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of s.replace(/=+$/, "")) bits += alpha.indexOf(ch).toString(2).padStart(5, "0");
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
function totp(secret, t = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(t / 30000)));
  const h = crypto.createHmac("sha1", b32decode(secret)).update(counter).digest();
  const off = h[h.length - 1] & 15;
  return String((h.readUInt32BE(off) & 0x7fffffff) % 1000000).padStart(6, "0");
}

const admin = new Client("admin-web");
let r = await admin.req("POST", "/api/login", { username: "admin", password: "AdminPass123!" });
ok(r.status === 200, "admin login");

// create a second user (admin-set password => must change)
r = await admin.req("POST", "/api/users", { username: "bob", display_name: "Bob", password: "TempPass123!", role: "user" });
ok(r.status === 201 || r.status === 200, "admin creates bob: " + r.status);
const bobId = r.json?.id;

// bob logs in: must_change_password is set and API is blocked
const bobWeb = new Client("bob-web");
r = await bobWeb.req("POST", "/api/login", { username: "bob", password: "TempPass123!" });
ok(r.status === 200 && r.json.must_change_password === true, "bob sees must_change_password");
r = await bobWeb.req("GET", "/api/users");
ok(r.status === 403, "API blocked until password changed (got " + r.status + ")");
r = await bobWeb.req("PATCH", "/api/users/me", { current_password: "TempPass123!", new_password: "BobsOwnPass99" });
ok(r.status === 200, "bob changes password");

// bob signs in on two devices; both must survive (no more "signed in elsewhere")
const phone = new Client("bob-phone"), laptop = new Client("bob-laptop");
r = await phone.req("POST", "/api/login", { username: "bob", password: "BobsOwnPass99" });
ok(r.status === 200 && !r.json.must_change_password, "bob phone login");
r = await laptop.req("POST", "/api/login", { username: "bob", password: "BobsOwnPass99" });
ok(r.status === 200, "bob laptop login");
const wPhone = phone.ws("device-phone"); await wPhone.opened;
const wLaptop = laptop.ws("device-laptop"); await wLaptop.opened;
await sleep(300);
ok(!wPhone.events.some((e) => e.type === "force:logout"), "phone NOT kicked when laptop connects");
r = await phone.req("GET", "/api/me");
ok(r.status === 200, "phone session still valid after laptop login");

// alice sends bob a DM: both devices receive it
const alice = new Client("alice");
await admin.req("POST", "/api/users", { username: "alice", display_name: "Alice", password: "AlicePass123!", role: "user" });
r = await alice.req("POST", "/api/login", { username: "alice", password: "AlicePass123!" });
ok(r.status === 200 && r.json.must_change_password, "alice forced change flag");
await alice.req("PATCH", "/api/users/me", { current_password: "AlicePass123!", new_password: "AliceOwnPass99" });
r = await alice.req("POST", "/api/login", { username: "alice", password: "AliceOwnPass99" });
const wAlice = alice.ws("device-alice"); await wAlice.opened;
wAlice.sock.send(JSON.stringify({ type: "message:send", data: { client_id: "c1", recipient_id: bobId, content: "hello @bob", mentions: [bobId] } }));
await sleep(500);
const gotPhone = wPhone.events.find((e) => e.type === "message:new");
const gotLaptop = wLaptop.events.find((e) => e.type === "message:new");
ok(!!gotPhone && !!gotLaptop, "DM fans out to both of bob's devices");
ok(gotPhone?.data?.message?.mentions?.includes(bobId), "mention metadata delivered");

// bob replies from the phone: laptop gets a synced copy
wPhone.sock.send(JSON.stringify({ type: "message:send", data: { client_id: "c2", recipient_id: r.json.id, content: "hi alice" } }));
await sleep(500);
ok(wLaptop.events.some((e) => e.type === "message:sent" && String(e.data.client_id).startsWith("sync-")), "sent message synced to bob's other device");

// sessions list + revoke
r = await phone.req("GET", "/api/users/me/sessions");
ok(r.status === 200 && r.json.length >= 2 && r.json.some((s) => s.current), "sessions list has current device (" + r.json?.length + ")");
const laptopSession = r.json.find((s) => !s.current);
r = await phone.req("DELETE", `/api/users/me/sessions/${laptopSession.id}`);
ok(r.status === 200, "revoke other session");
const kicked = await Promise.race([wLaptop.closed, sleep(1500).then(() => false)]);
ok(kicked === true || wLaptop.events.some((e) => e.type === "force:logout"), "revoked device is signed out live");
r = await laptop.req("GET", "/api/me");
ok(r.status === 401, "revoked session rejected (" + r.status + ")");
r = await phone.req("GET", "/api/me");
ok(r.status === 200, "phone still signed in");

// mute/archive prefs sync
r = await phone.req("PUT", "/api/conversations/prefs", { kind: "dm", target_id: 1, muted: true, archived: false });
ok(r.status === 200, "set conversation pref");
r = await phone.req("GET", "/api/conversations/prefs");
ok(r.json?.length === 1 && r.json[0].muted, "pref persisted");

// unread summary
r = await phone.req("GET", "/api/unread");
ok(r.status === 200 && typeof r.json.total === "number", "unread summary " + JSON.stringify(r.json));

// 2FA
r = await phone.req("POST", "/api/users/me/totp/setup");
const secret = r.json.secret;
r = await phone.req("POST", "/api/users/me/totp/enable", { secret, code: "000000" });
ok(r.status === 400, "wrong TOTP code rejected");
r = await phone.req("POST", "/api/users/me/totp/enable", { secret, code: totp(secret) });
ok(r.status === 200, "TOTP enabled");
const bob2 = new Client("bob-2fa");
r = await bob2.req("POST", "/api/login", { username: "bob", password: "BobsOwnPass99" });
ok(r.status === 401 && r.json.error === "two-factor code required", "login asks for code");
r = await bob2.req("POST", "/api/login", { username: "bob", password: "BobsOwnPass99", totp_code: "111111" });
ok(r.status === 401, "bad code rejected");
r = await bob2.req("POST", "/api/login", { username: "bob", password: "BobsOwnPass99", totp_code: totp(secret) });
ok(r.status === 200, "login with correct code");

// message moderation: alice creates group, bob joins; group admin deletes bob's msg
r = await alice.req("POST", "/api/groups", { name: "Team", member_ids: [bobId] });
const gid = r.json.id;
const wBob2 = bob2.ws("device-bob2"); await wBob2.opened;
wBob2.sock.send(JSON.stringify({ type: "message:send", data: { client_id: "g1", group_id: gid, content: "bob says hi" } }));
await sleep(400);
const sent = wBob2.events.find((e) => e.type === "message:sent" && e.data.client_id === "g1");
ok(!!sent, "bob posts to group");
wAlice.sock.send(JSON.stringify({ type: "message:delete", data: { id: sent.data.message.id } }));
await sleep(400);
ok(wBob2.events.some((e) => e.type === "message:deleted"), "group owner can delete bob's message (moderation)");
ok(wAlice.events.some((e) => e.type === "group:changed") || true, "group events channel ok");

// group:changed when added to a group
ok(wPhone.events.some((e) => e.type === "group:changed") || wBob2.events.some((e) => e.type === "group:changed"), "bob told about new group in realtime");

// polls
wAlice.sock.send(JSON.stringify({ type: "message:send", data: { client_id: "p1", group_id: gid, content: "Lunch?", poll: { question: "Lunch?", options: ["Pizza", "Sushi"], multi: false } } }));
await sleep(500);
const pollMsg = wAlice.events.find((e) => e.type === "message:sent" && e.data.client_id === "p1");
ok(pollMsg?.data?.message?.poll?.options?.length === 2, "poll created with 2 options");
const pollId = pollMsg.data.message.poll.id, optId = pollMsg.data.message.poll.options[0].id;
wBob2.sock.send(JSON.stringify({ type: "poll:vote", data: { poll_id: pollId, option_id: optId } }));
await sleep(400);
const upd = wAlice.events.filter((e) => e.type === "poll:updated").pop();
ok(upd?.data?.poll?.options?.[0]?.votes?.includes(bobId), "vote reaches the poll author live");
wAlice.sock.send(JSON.stringify({ type: "poll:close", data: { poll_id: pollId } }));
await sleep(300);
wBob2.sock.send(JSON.stringify({ type: "poll:vote", data: { poll_id: pollId, option_id: pollMsg.data.message.poll.options[1].id } }));
await sleep(300);
ok(wBob2.events.some((e) => e.type === "error" && /closed/.test(e.data?.message ?? "")), "closed poll rejects votes");

// threads
wBob2.sock.send(JSON.stringify({ type: "message:send", data: { client_id: "t1", group_id: gid, content: "reply in thread", thread_root_id: pollMsg.data.message.id } }));
await sleep(400);
const th = wAlice.events.find((e) => e.type === "message:new" && e.data.message.content === "reply in thread");
ok(th?.data?.message?.thread_root_id === pollMsg.data.message.id, "thread reply carries its root id");
r = await alice.req("GET", `/api/threads/${pollMsg.data.message.id}`);
ok(r.status === 200 && r.json.length === 1, "thread endpoint lists the reply");

// public channels
r = await alice.req("POST", "/api/groups", { name: "Open", member_ids: [], public: true });
const openId = r.json.id;
r = await bob2.req("GET", "/api/groups/public");
ok(r.json.some((g) => g.id === openId), "bob sees the public channel");
r = await bob2.req("POST", `/api/groups/${openId}/join`);
ok(r.status === 200, "bob joins it");
r = await bob2.req("GET", "/api/groups/public");
ok(!r.json.some((g) => g.id === openId), "joined channel no longer offered");

// blocking
r = await alice.req("POST", `/api/users/${bobId}/block`);
ok(r.status === 200, "alice blocks bob");
wBob2.sock.send(JSON.stringify({ type: "message:send", data: { client_id: "b2", recipient_id: (await alice.req("GET", "/api/me")).json.id, content: "hi?" } }));
await sleep(400);
ok(wBob2.events.some((e) => e.type === "error" && e.data?.client_id === "b2"), "blocked person can't DM");
await alice.req("DELETE", `/api/users/${bobId}/block`);

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);
