# TalentTrade account server

One small program, `talenttrade_server.py`, that runs on **your own machine** and:

- serves the TalentTrade website (homepage, meetings, join, sign up, log in)
- handles accounts: sign up, log in, log out, email confirmation, forgot/reset password
- can give logged-in people a **meeting pass** for your own Jitsi server, so only account holders can start meetings while guests still join with a link

It only uses what comes with Python (3.8 or newer), so there's nothing to install. Linux Mint already has Python.

## Where accounts are kept

- In one database file: `server/data/talenttrade.db`. Only the user running the server can read it, and it is never sent to GitHub (it's listed in `.gitignore`).
- Passwords are stored **scrambled with scrypt** (salted, slow, one-way). Nobody, including you, can read them back.
- Logins use a secure cookie that page scripts can't read. Sessions last 30 days.
- Too many attempts at log in, sign up or password reset from one address are blocked for 10 minutes.
- Requests from other websites are refused.

## On the internet: set up a cloud server with one command

This lets people anywhere sign up, log in and host meetings, on your own web address with real certificates, so visitors see no security warnings.

**You need:**
1. **A cloud server** running Ubuntu 22.04 or 24.04. For ~250-person calls: about 8 CPU cores, 16 GB memory and a 1 Gbps connection. Smaller is fine for testing. Locations near South Africa: AWS Cape Town, Azure South Africa North, Google Cloud Johannesburg.
2. **A domain** (e.g. `talenttrade.co.za`) with two DNS **A records** pointing at the server's public IP:
   - `talenttrade.co.za`: the website and accounts
   - `meet.talenttrade.co.za`: the video server
3. **Your cloud provider's firewall** (often called a "security group") letting in **22/tcp, 80/tcp, 443/tcp and 10000/udp**.

**Then, on the server** (log in with SSH as the normal sudo user, e.g. `ubuntu`):

```bash
git clone https://github.com/thechmanic-sketch/Around-The-World-.git talenttrade
cd talenttrade
git checkout ccr-1c745246-kv3eni          # until this is merged into main
# optional but recommended: email for sign-up confirmations and password resets
export TT_SMTP_HOST=smtp.gmail.com TT_SMTP_PORT=587 TT_SMTP_USER=you@gmail.com TT_SMTP_PASS='app-password' TT_SMTP_FROM='TalentTrade <you@gmail.com>'
bash server/setup-cloud.sh talenttrade.co.za meet.talenttrade.co.za you@example.com
```

**What it does:**
- checks both names already point at this server
- installs Docker, nginx and Let's Encrypt
- sets the server's firewall to allow only SSH, web and video
- sets up Jitsi, reachable only through nginx, and locked so only account holders start meetings
- sets up the account server, reachable only through nginx, as a service
- gets free HTTPS certificates that renew automatically
- checks both addresses from the internet side

**Afterwards:** open `https://talenttrade.co.za`, sign up, and start a meeting. To update the site later, run `git pull && sudo systemctl restart talenttrade` in the project folder.

You can run it again safely: it keeps the secret, accounts, certificates and email settings.

## Quickest: set up everything on a Linux Mint laptop with one command

`setup-mint.sh` does all of the following for you:

- installs Docker
- sets up your own **Jitsi video server**, so only TalentTrade account holders can start meetings and guests still join with the link
- sets up this **account server** over HTTPS and starts it automatically whenever the laptop starts
- links the two with a secret it generates

From the project folder, as your normal user (not with sudo):

```bash
bash server/setup-mint.sh
```

It asks for your password to install software. The first run downloads a few hundred MB. When it finishes, it prints two addresses:

1. `https://<laptop-ip>:8443` is the video server. Open it once on each device and accept the security warning.
2. `https://<laptop-ip>:8090` is TalentTrade. Accept the warning again, then sign up and start a meeting.

The warnings appear because the certificates are home-made. A real web address with Let's Encrypt removes them (step 6).

Your settings and the meeting-pass secret are in `~/.config/talenttrade/server.env`, and accounts are in `~/.config/talenttrade/talenttrade.db`. You can run the script again safely: it keeps your secret, your accounts and any email settings you added.

The sections below explain each part, if you'd rather set things up by hand.

## 1. Try it on your Mint laptop

From the project folder (the one with `index.html`):

```bash
python3 server/talenttrade_server.py
```

Open <http://localhost:8090>. You'll see the site, and **Sign up** and **Log in** now work.

With no email set up, new accounts are confirmed straight away, and password-reset links are **printed in the terminal** instead of emailed. That's handy for testing.

To try it from your phone on the same Wi-Fi, run it like this instead and open `http://YOUR-LAPTOP-IP:8090` (find the IP with `hostname -I`):

```bash
TT_HOST=0.0.0.0 TT_PUBLIC_URL=http://YOUR-LAPTOP-IP:8090 python3 server/talenttrade_server.py
```

Press **Ctrl+C** to stop it.

## 2. Settings

Settings are environment variables, put in front of the command as above, or in the service file in step 5.

| Setting | Default | What it does |
|---|---|---|
| `TT_PORT` | `8090` | Port the server listens on. |
| `TT_HOST` | `127.0.0.1` | `127.0.0.1` = this computer only. `0.0.0.0` = other devices too. |
| `TT_PUBLIC_URL` | `http://localhost:8090` | The site's address as visitors see it. Used in email links. |
| `TT_DB` | `server/data/talenttrade.db` | Where the accounts database is stored. |
| `TT_REQUIRE_LOGIN_TO_HOST` | `0` | `1` = people must log in to **start** a meeting. Guests can still join with a link. |
| `TT_SESSION_DAYS` | `30` | How long people stay logged in. |
| `TT_TRUST_PROXY` | `0` | Set to `1` when running behind nginx (step 6). |
| `TT_COOKIE_SECURE` | on for `https://` | Only send the login cookie over HTTPS. |
| `TT_TLS_CERT`, `TT_TLS_KEY` | (off) | Certificate and key files, so the server speaks HTTPS itself (no nginx needed). Phones and other computers only allow the camera on HTTPS pages. |
| `TT_JITSI_DOMAIN` | (off) | Your Jitsi server's address, e.g. `192.168.1.50:8443`. The website then uses it for meetings automatically, with no need to edit `meet.html`. |
| `TT_SMTP_HOST`, `TT_SMTP_PORT`, `TT_SMTP_USER`, `TT_SMTP_PASS`, `TT_SMTP_FROM` | (off) | Your email account for sending confirmation and reset emails (step 3). |
| `TT_JITSI_APP_ID`, `TT_JITSI_APP_SECRET` | (off) | Meeting passes for your own Jitsi server (step 4). |
| `TT_JITSI_SUB`, `TT_JITSI_AUD` | `*`, `jitsi` | Meeting-pass details; change only if Jitsi rejects the passes. |

## 3. Turn on emails

Any email account that allows SMTP works: your domain's email, or Gmail with an "App password". Example for Gmail:

```bash
TT_SMTP_HOST=smtp.gmail.com TT_SMTP_PORT=587 \
TT_SMTP_USER=you@gmail.com TT_SMTP_PASS='your-16-letter-app-password' \
TT_SMTP_FROM='TalentTrade <you@gmail.com>' \
python3 server/talenttrade_server.py
```

With email on:

- **New accounts:** must click the link in a "Confirm your TalentTrade account" email before they can log in. The link works for 48 hours.
- **Forgot password:** sends a reset link that works once, for 1 hour. Resetting logs the account out everywhere else.

## 4. Only account holders can start meetings (with your own Jitsi server)

The account server can hand logged-in people a signed **meeting pass** (a JWT) that your Jitsi server checks.

1. Choose an app ID and a long random secret, for example by running `openssl rand -hex 32`.
2. Start the account server with them:
   ```bash
   TT_JITSI_APP_ID=talenttrade TT_JITSI_APP_SECRET=the-long-secret TT_REQUIRE_LOGIN_TO_HOST=1 \
   python3 server/talenttrade_server.py
   ```
3. Tell Jitsi to accept those passes. In docker-jitsi-meet's `.env`, set:
   ```
   ENABLE_AUTH=1
   AUTH_TYPE=jwt
   JWT_APP_ID=talenttrade
   JWT_APP_SECRET=the-long-secret
   ENABLE_GUESTS=1
   ```
   Then run `docker compose down && docker compose up -d`. Check these names against Jitsi's own "JWT authentication" docs for your version.
4. In `meet.html`, set `DOMAIN` to your Jitsi server's address.

**Result:** logged-in people can start meetings, and guests with the link can join once the host is in.

Keep the secret private. Anyone who has it can make passes.

## 5. Keep it running (start automatically with the computer)

Create `/etc/systemd/system/talenttrade.service`, changing the paths and user to yours:

```ini
[Unit]
Description=TalentTrade account server
After=network-online.target

[Service]
User=YOUR-LINUX-USERNAME
WorkingDirectory=/home/YOUR-LINUX-USERNAME/talenttrade
ExecStart=/usr/bin/python3 server/talenttrade_server.py
Environment=TT_PUBLIC_URL=https://talenttrade.co.za
Environment=TT_TRUST_PROXY=1
# Environment=TT_SMTP_HOST=...   (add the rest of your settings like this)
Restart=always

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now talenttrade
sudo systemctl status talenttrade        # is it running?
journalctl -u talenttrade -f             # see its messages
```

## 6. Putting it on the internet (HTTPS)

Run it behind **nginx** with a free Let's Encrypt certificate, and keep `TT_HOST=127.0.0.1`. Example nginx site:

```nginx
server {
    server_name talenttrade.co.za;
    location / {
        proxy_pass http://127.0.0.1:8090;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    listen 443 ssl; # certificate lines added by: sudo certbot --nginx -d talenttrade.co.za
}
```

Set `TT_PUBLIC_URL=https://talenttrade.co.za` and `TT_TRUST_PROXY=1`.

## 7. Backups

Everything is in the one database file. To copy it safely while the server runs:

```bash
sqlite3 server/data/talenttrade.db ".backup 'talenttrade-backup.db'"
```

Keep backups somewhere private: they contain everyone's email address.

## What the server answers (for developers)

| Address | What it does |
|---|---|
| `GET /api/config` | Which features are on. |
| `POST /api/signup` | `{name, email, password, role}` creates an account. |
| `GET /api/confirm?token=` | The email confirmation link. |
| `POST /api/login` | `{email, password}` logs in. |
| `GET /api/me` | The logged-in person. |
| `POST /api/logout` | Logs out. |
| `POST /api/forgot` | `{email}` sends a reset link. |
| `POST /api/reset` | `{token, password}` sets a new password. |
| `GET /api/jitsi-token` | A meeting pass for the logged-in person. |
