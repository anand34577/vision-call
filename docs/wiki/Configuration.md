# Configuration

Vision Call runs without any configuration. Change settings only when you need something different.

## Three ways to change a setting

1. **In the app**: **Admin > Server Settings**. Most settings change immediately, no restart. This is the easiest option.
2. **In the `.env` file** next to the program. Remove the `#` in front of a line, change the value, save and restart. Every setting is listed with an explanation in [.env.example](https://github.com/anand34577/vision-call/blob/main/.env.example).
3. **As an environment variable**, for example `-e MAX_FILE_MB=100` with `docker run`.

| Installed with | `.env` file | Restart with |
|---|---|---|
| Linux installer | `/opt/visioncall/.env` | `sudo systemctl restart visioncall` |
| Windows installer | `C:\ProgramData\VisionCall\.env` | `Restart-Service VisionCall` |
| Docker Compose | `.env` next to `docker-compose.yml` | `docker compose up -d` |
| Docker run | use `-e NAME=value` | recreate the container |

If a setting is set in more than one place, an environment variable wins over `.env`, and `.env` wins over the Settings screen. Anything set in the environment or `.env` shows a lock icon in the Settings screen and can only be changed there.

## Settings

"Restart" means the setting is read when the server starts. "Live" means changing it in the Settings screen takes effect straight away.

### First admin account

| Setting | Default | What it does |
|---|---|---|
| `BOOTSTRAP_ADMIN_USER` | `admin` | Username of the first admin account. Only used when the database is empty. |
| `BOOTSTRAP_ADMIN_PASSWORD` | random | Password for that account. When unset, a random one is printed in the logs on first start. |

### Network (restart)

| Setting | Default | What it does |
|---|---|---|
| `LISTEN_ADDR` | `:8443` | Main port. HTTPS, unless TLS is disabled or a proxy is trusted. |
| `HTTP_ADDR` | `:8080` | Plain HTTP port that also serves the app while HTTPS is on. |
| `WEBRTC_UDP_PORT` | `7882` | UDP port for group-call media. `0` uses random ports. |
| `EXTERNAL_IP` | automatic | Address group-call media is sent to. See [Networking and Firewall](Networking-and-Firewall#how-group-calls-find-the-server). |
| `HTTPS_REDIRECT` | `false` | Make the HTTP port redirect to HTTPS instead of serving the app. |
| `DISABLE_TLS` | `false` | Plain HTTP only, no certificate. |
| `TLS_CERT`, `TLS_KEY` | automatic | Your own certificate and key. Unset means a self-signed certificate is made for you. |
| `TRUST_PROXY` | `false` | Running behind a reverse proxy. Also editable live. |
| `PROXY_TLS` | `false` | The proxy always serves HTTPS. Also editable live. |

See [HTTPS and Certificates](HTTPS-and-Certificates) for how these fit together.

### Storage (restart)

| Setting | Default | What it does |
|---|---|---|
| `DATA_DIR` | `./data` (`/data` in Docker) | Folder for the database, uploads, certificate and session key. |
| `DATABASE_URL` | built-in SQLite | Use Postgres (`postgres://user:pass@host:5432/db?sslmode=disable`) or MySQL (`mysql://user:pass@host:3306/db`) instead. Tables are created automatically. |
| `JWT_SECRET` | automatic | Key that signs logins. When unset, a random key is created in `DATA_DIR` and reused. Changing it signs everyone out. |

### Calls (live)

| Setting | Default | What it does |
|---|---|---|
| `MAX_CALL_PARTICIPANTS` | `8` | Most people in one group call. Needs a restart. |
| `TURN_HOST` | none | TURN relay address, like `192.168.1.50:3478`. |
| `TURN_SECRET` | none | Shared secret configured in the TURN relay. |

### Files (live)

| Setting | Default | What it does |
|---|---|---|
| `MAX_FILE_MB` | `50` | Largest single upload, in MB. |
| `MAX_USER_STORAGE_MB` | `2048` | Upload space per person, in MB. `0` for unlimited. |
| `BLOCKED_FILE_EXTENSIONS` | executables and scripts | Comma-separated extensions to reject, like `.exe,.bat`. `none` allows everything. |

The default block list is `.exe .bat .cmd .com .scr .msi .msp .ps1 .psm1 .vbs .vbe .js .jse .wsf .wsh .jar .app .dll .sh .bin .cpl .gadget .hta .lnk .pif .reg .vb .ws .apk`. Documents, images, archives and media are all allowed.

### Sessions and logging (live)

| Setting | Default | What it does |
|---|---|---|
| `SESSION_TTL_HOURS` | `720` | How long a device stays signed in **without being used**. The timer restarts on use, so people who use the app regularly stay signed in. |
| `MESSAGE_RETENTION_DAYS` | `0` | Permanently delete chat messages older than this many days (pinned messages are kept). `0` keeps everything. Runs once a day. |
| `METRICS_TOKEN` | empty | If set, `/metrics` needs `Authorization: Bearer <token>`. If empty, only the server itself and private networks can read it. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |

### Password reset by email (live)

Set these to let people reset a forgotten password themselves. Without them, an admin resets passwords from **Admin > Users**.

| Setting | Default | What it does |
|---|---|---|
| `SMTP_HOST` | none | Mail server, like `smtp.example.com`. |
| `SMTP_PORT` | `587` | Mail server port. |
| `SMTP_USER`, `SMTP_PASS` | none | Mail server login. |
| `SMTP_FROM` | `SMTP_USER` | Sender address. |
| `PUBLIC_BASE_URL` | none | The address people open, like `https://192.168.1.50:8443`. Required, because reset links are built from it. |
| `PASSWORD_RESET_ENABLED` | `true` | Turn the feature off without removing the mail settings. |

### Single sign-on

Let people sign in with an OpenID Connect provider such as Keycloak, Authentik, Microsoft Entra ID, Okta or Google Workspace. Nothing changes until `OIDC_ISSUER_URL` is set, and if the provider is down, normal passwords still work.

| Setting | Default | What it does |
|---|---|---|
| `OIDC_ISSUER_URL` | none | Your provider's issuer URL. Restart. |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | none | The client you registered with the provider. Restart. |
| `OIDC_REDIRECT_URL` | from `PUBLIC_BASE_URL` | Callback URL to register with the provider: `<PUBLIC_BASE_URL>/api/oidc/callback`. Restart. |
| `OIDC_AUTO_CREATE_USERS` | `false` | Create an account the first time someone signs in. Otherwise an admin creates it first. Live. |
| `OIDC_BUTTON_LABEL` | `Sign in with SSO` | Text on the sign-in button. Live. |
| `OIDC_ENABLED` | `true` | Turn SSO off without removing its settings. Live. |
