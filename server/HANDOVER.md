# TalentTrade: handover notes

Context for anyone (or any Claude session) continuing this work. Written 7 November 2026.

## What TalentTrade is
TalentTrade ("Limited funds, big dreams, problem solved"), a Techmanic brand, is a browser-based video meeting app for pitches and presentations. Contact: WhatsApp 063 353 1662.

- **Brand:** orange `#f19e5f` and teal `#028392` / `#066a6c`, navy outlines `#00001e`, Inter font. Logo files are `assets/tt-*.png`.
- **The repo name is a leftover:** the repository is still called "Around-The-World-" from an old photo booth site. That site has been fully replaced.

## Where things are
- **Repo:** https://github.com/thechmanic-sketch/Around-The-World- (owner: thechmanic-sketch).
- **`main`** is **live on GitHub Pages:** https://thechmanic-sketch.github.io/Around-The-World-/ (PR #1, merged). On Pages there is no account server, so sign-up and log-in say "accounts aren't switched on yet". Meetings use meet.jit.si.
- **Branch `ccr-1c745246-kv3eni`** has everything on `main` **plus newer work not yet merged:**
  - the server can tell the website which video server to use (`TT_JITSI_DOMAIN`)
  - the server can serve HTTPS itself (`TT_TLS_CERT` / `TT_TLS_KEY`)
  - `server/setup-mint.sh`: laptop setup
  - `server/setup-cloud.sh`: cloud setup
  - updated `server/README.md`

  Use this branch for any server setup. Merge it into `main` (with a pull request) once the laptop test works.

## What's built
| Part | Files |
|---|---|
| Homepage (landing page, join bar, features, timer, sponsors, FAQ) | `index.html`, `assets/style.css` |
| Meeting app: join screen with camera preview, then a Zoom-style call on Jitsi with TalentTrade's own toolbar | `meet.html` |
| Presentation timer: 1 to 7 minutes, synced to everyone, amber in the last minute, red in the last 15 seconds, beeps, overtime | `assets/present-timer.js` |
| Sponsor video ads: before the call, join screen, muted corner pop-up, full-screen ad break (host only; waits for the timer) | `assets/ads.js`, `ads/ads.json`, no-code manager `ads/admin.html` |
| Join, sign-up and log-in screens | `join.html`, `signup.html`, `login.html`, `assets/auth.js`, `assets/auth-ui.js` |
| Account server: Python standard library only, SQLite, scrypt passwords, sessions, email confirm/reset, rate limits, Jitsi JWT meeting passes, serves the site | `server/talenttrade_server.py`, guide `server/README.md` |
| Installable web app (manifest, icons, service worker, offline page, Install button) | `manifest.webmanifest`, `sw.js`, `assets/pwa.js`, `offline.html` |
| Large calls: each person receives video from the 25 most recent speakers; everyone after the first 10 joins muted | `meet.html` |
| GitHub Pages publishing (website files only) | `.github/workflows/pages.yml` |

## Decisions made with the owner
- **Accounts run on the owner's own server, not Supabase or another hosted service.** The Supabase organisation "techmanic" (projects LwaziConnect and Ekoquick Main) is for other businesses; don't use it for TalentTrade.
- **Laptop vs cloud:**
  - The **Linux Mint laptop ("techmanic") is for testing** and for small meetings on home Wi-Fi.
  - It **can't host 250 people.** Every participant's video passes through the server, which needs very roughly 250–500 Mbps of upload plus serious CPU.
  - **250-person calls need a cloud server** (about 8 cores, 16 GB memory, 1 Gbps; ideally in South Africa: AWS Cape Town, Azure South Africa North or Google Cloud Johannesburg) and a domain such as `talenttrade.co.za` plus `meet.talenttrade.co.za`.
- **People outside the owner's network signing up and hosting** is the goal. That's what `setup-cloud.sh` is for. The owner hasn't bought a domain or created a cloud server yet.

## Status of the laptop setup
The owner started `server/setup-mint.sh` on the laptop in a separate chat. **Whether it finished successfully is unknown.** Check with:

```bash
systemctl status talenttrade --no-pager
journalctl -u talenttrade -n 30 --no-pager
cd ~/talenttrade-jitsi && sudo docker compose ps
curl -k https://127.0.0.1:8090/api/config          # expect "jitsiTokens": true and "jitsiDomain"
curl -k -o /dev/null -w '%{http_code}\n' https://127.0.0.1:8443/external_api.js   # expect 200
```

Where things live after setup:

| What | Where |
|---|---|
| Project | `~/talenttrade` |
| Jitsi | `~/talenttrade-jitsi` |
| Settings and secret (private) | `~/.config/talenttrade/server.env` |
| Accounts database | `~/.config/talenttrade/talenttrade.db` |

Addresses on home Wi-Fi:
- `https://<laptop-ip>:8443` is the video server. Accept the warning once per device.
- `https://<laptop-ip>:8090` is TalentTrade. Accept the warning, sign up, start a meeting.

## What has and hasn't been tested
- **Tested in an automated browser,** with a stand-in for Jitsi: every page, the toolbar, timer sync between several people, all four ad spots, the ads manager, phone layouts, and install/offline behaviour.
- **Tested for real:** the account server, including email on/off, behind nginx and over HTTPS. The Jitsi settings edits were checked against Jitsi's real `env.example` (release stable-11248-3). `docker compose config` and `nginx -t` accepted the generated configuration.
- **Not yet tested:**
  - a real call through a real Jitsi server
  - Jitsi actually accepting the JWT meeting passes
  - real emails reaching an inbox
  - a full run of either setup script on real hardware

## Next steps
1. Confirm the laptop setup works and do a real test call: laptop plus a phone on the same Wi-Fi. Check video, audio, the timer, the host-only Ad break button, and that guests can join by link.
2. Fix anything that fails. Re-running the setup script is safe: it keeps accounts, the secret and email settings.
3. Turn on email: add the `TT_SMTP_*` settings to `server.env`, then `sudo systemctl restart talenttrade`.
4. Merge `ccr-1c745246-kv3eni` into `main` with a pull request.
5. When ready for the public: buy the domain, create the cloud server, add the DNS A records for both names, open ports 22/80/443 TCP and 10000 UDP, then run `server/setup-cloud.sh`.
6. Smaller to-dos:
   - meeting codes still start with `atw-` (change to `tt-`)
   - replace the two demo sponsor ads
   - connect ad reporting (`trackUrl` in `ads/ads.json`)
   - update the PDF guide with the account screens, the server and the web app
   - get a vector version of the logo
   - optionally rename the repo

## Rules the owner set
- Never commit secrets: `server.env`, `.db` files, certificates and keys, `~/talenttrade-jitsi/.env`.
- Ask before deleting anything, stopping services that aren't part of TalentTrade, or putting anything on the internet.
- Don't create a pull request unless asked. Explain changes in plain language.
