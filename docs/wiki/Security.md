# Security

Vision Call is built for private networks: an office LAN, a home network or a VPN. This page explains how it protects accounts, messages and calls, and what you should do as the administrator.

## Accounts and sign-in

- Only admins create accounts; nobody can sign up on their own.
- Passwords are stored with argon2id, a slow, salted hash designed for passwords.
- Repeated wrong passwords are rate-limited: 5 failures in 15 minutes per account and address.
- Sign-ins are kept in `httpOnly`, `SameSite=Lax` cookies that page scripts can't read. A device stays signed in for 30 days after its last use by default (`SESSION_TTL_HOURS`; the timer restarts each time the app is used).
- The same account can be signed in on several devices at once (phone and laptop). **Settings > Status & Security** lists them and can sign any of them out remotely.
- Two-step verification (an authenticator app such as Aegis or Google Authenticator; standard TOTP, no online service involved) can be turned on per account in Settings.
- When an admin creates an account or sets its password, that person must choose their own password at first sign-in.
- Suspending, removing or changing the password of an account signs it out everywhere immediately, even mid-call.
- Single sign-on through OpenID Connect is available, see [Configuration](Configuration#single-sign-on).

## Messages

- In the browser over HTTPS and in the Android app, chat messages are encrypted end to end. Each device has its own key pair, and the server only stores encrypted text and public keys, so it can't read the messages.
- Uploaded files are stored on the server as they are, not encrypted.
- Browsers only allow the encryption over HTTPS, so use the HTTPS address.

## Calls

- All call audio and video is encrypted in transit with DTLS-SRTP, the standard WebRTC encryption.
- One-to-one calls travel directly between the two devices.
- Group calls pass through the server, which forwards the encrypted media without recording or storing it.

## The server

- Every API route requires a signed-in user, except sign-in, the health check and metrics.
- Requests that change data must come from the app's own origin.
- Pages are served with a Content Security Policy and other hardening headers.
- Executable file types are blocked from upload by default.
- Admin actions are written to the audit log.
- The Docker image runs as an unprivileged user, and the Linux service runs as a dedicated `visioncall` account with a read-only view of the system.

## What you should do

1. Change the first admin password right after installing.
2. Keep the server on a private network or VPN. If you must expose it to the internet, put it behind a reverse proxy with a real certificate and consider restricting `/api/metrics`.
3. Prefer HTTPS. Install the certificate on your devices, or use your own certificate, so people aren't trained to click through warnings.
4. Keep backups, and keep them somewhere other than the server itself. The data folder contains the login signing key, so protect backups like passwords.
5. Upgrade when new releases come out.

## Reporting a vulnerability

Please report security problems privately through [GitHub security advisories](https://github.com/anand34577/vision-call/security/advisories/new) rather than in a public issue.
