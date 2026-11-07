#!/usr/bin/env python3
"""
TalentTrade account server.

One small program that runs on your own machine (Linux Mint laptop, or a cloud server):
  * serves the TalentTrade website (index.html, meet.html, login.html, ...)
  * handles accounts: sign up, log in, log out, confirm email, forgot / reset password
  * optionally issues meeting passes (JWT tokens) for your own Jitsi server, so only
    logged-in people can start meetings while guests still join with a link

Only the Python standard library is used (Python 3.8+), so nothing needs installing.
Accounts are stored in an SQLite database file. Passwords are stored with scrypt
(salted, slow, one-way), so they can't be read back by anyone.

Run it from the project folder:
    python3 server/talenttrade_server.py
then open http://localhost:8090

All settings are environment variables (see server/README.md):
    TT_PORT=8090  TT_HOST=127.0.0.1  TT_PUBLIC_URL=http://localhost:8090
    TT_DB=server/data/talenttrade.db  TT_REQUIRE_LOGIN_TO_HOST=0
    TT_SMTP_HOST / TT_SMTP_PORT / TT_SMTP_USER / TT_SMTP_PASS / TT_SMTP_FROM
    TT_JITSI_APP_ID / TT_JITSI_APP_SECRET / TT_JITSI_SUB / TT_JITSI_AUD / TT_JITSI_DOMAIN
    TT_TLS_CERT / TT_TLS_KEY (serve HTTPS directly)
"""
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import smtplib
import sqlite3
import ssl
import sys
import threading
import time
from email.message import EmailMessage
from http import cookies
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

# ---------------------------------------------------------------- settings
HERE = os.path.dirname(os.path.abspath(__file__))
SITE_DIR = os.environ.get("TT_SITE_DIR", os.path.dirname(HERE))
PORT = int(os.environ.get("TT_PORT", "8090"))
HOST = os.environ.get("TT_HOST", "127.0.0.1")
PUBLIC_URL = os.environ.get("TT_PUBLIC_URL", "http://localhost:%d" % PORT).rstrip("/")
DB_PATH = os.environ.get("TT_DB", os.path.join(HERE, "data", "talenttrade.db"))
SESSION_DAYS = int(os.environ.get("TT_SESSION_DAYS", "30"))
REQUIRE_LOGIN_TO_HOST = os.environ.get("TT_REQUIRE_LOGIN_TO_HOST", "0") == "1"
TRUST_PROXY = os.environ.get("TT_TRUST_PROXY", "0") == "1"  # set to 1 behind nginx
COOKIE_SECURE = os.environ.get("TT_COOKIE_SECURE", "1" if PUBLIC_URL.startswith("https://") else "0") == "1"

SMTP_HOST = os.environ.get("TT_SMTP_HOST", "")
SMTP_PORT = int(os.environ.get("TT_SMTP_PORT", "587"))
SMTP_USER = os.environ.get("TT_SMTP_USER", "")
SMTP_PASS = os.environ.get("TT_SMTP_PASS", "")
SMTP_FROM = os.environ.get("TT_SMTP_FROM", SMTP_USER or "no-reply@localhost")
EMAIL_ON = bool(SMTP_HOST)  # without email, accounts are confirmed straight away and links are printed to the log

JITSI_APP_ID = os.environ.get("TT_JITSI_APP_ID", "")
JITSI_APP_SECRET = os.environ.get("TT_JITSI_APP_SECRET", "")
JITSI_SUB = os.environ.get("TT_JITSI_SUB", "*")
JITSI_AUD = os.environ.get("TT_JITSI_AUD", "jitsi")
JITSI_ON = bool(JITSI_APP_ID and JITSI_APP_SECRET)
TLS_CERT = os.environ.get("TT_TLS_CERT", "")  # serve HTTPS directly (e.g. on a home network, without nginx)
TLS_KEY = os.environ.get("TT_TLS_KEY", "")
JITSI_DOMAIN = os.environ.get("TT_JITSI_DOMAIN", "")  # e.g. 192.168.1.50:8443 or meet.example.co.za; the website uses it for meetings

ROLES = {"", "presenter", "organiser", "judge", "sponsor", "viewer"}
EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]{2,}$")
COOKIE = "tt_session"

# ---------------------------------------------------------------- database
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
_db = sqlite3.connect(DB_PATH, check_same_thread=False, isolation_level=None)
_db.row_factory = sqlite3.Row
_lock = threading.Lock()
with _lock:
    _db.executescript(
        """
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS users(
          id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT '', pw TEXT NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0,
          created INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions(
          id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS tokens(
          id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          kind TEXT NOT NULL, expires INTEGER NOT NULL);
        """
    )
try:
    os.chmod(DB_PATH, 0o600)  # only the account running the server can read the database
except OSError:
    pass


def q(sql, args=(), one=False):
    with _lock:
        cur = _db.execute(sql, args)
        rows = cur.fetchall()
    return (rows[0] if rows else None) if one else rows


def sha(s):
    return hashlib.sha256(s.encode()).hexdigest()  # tokens are stored hashed, never as given out


# ---------------------------------------------------------------- passwords
def hash_pw(pw):
    salt = os.urandom(16)
    h = hashlib.scrypt(pw.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
    return "scrypt$16384$8$1$%s$%s" % (base64.b64encode(salt).decode(), base64.b64encode(h).decode())


def check_pw(pw, stored):
    try:
        _, n, r, p, salt, h = stored.split("$")
        got = hashlib.scrypt(pw.encode(), salt=base64.b64decode(salt), n=int(n), r=int(r), p=int(p), dklen=32)
        return hmac.compare_digest(got, base64.b64decode(h))
    except Exception:
        return False


_DUMMY = hash_pw(secrets.token_hex(8))  # used so a wrong email takes as long as a wrong password


# ---------------------------------------------------------------- tokens, sessions
def new_token(user_id, kind, seconds):
    t = secrets.token_urlsafe(32)
    q("INSERT INTO tokens(id,user_id,kind,expires) VALUES(?,?,?,?)", (sha(t), user_id, kind, int(time.time()) + seconds))
    return t


def use_token(t, kind):
    row = q("SELECT * FROM tokens WHERE id=? AND kind=?", (sha(t or ""), kind), one=True)
    if not row:
        return None
    q("DELETE FROM tokens WHERE id=?", (row["id"],))
    return row["user_id"] if row["expires"] > time.time() else None


def new_session(user_id):
    t = secrets.token_urlsafe(32)
    q("INSERT INTO sessions(id,user_id,expires) VALUES(?,?,?)", (sha(t), user_id, int(time.time()) + SESSION_DAYS * 86400))
    return t


def public_user(u):
    return {"id": u["id"], "email": u["email"], "name": u["name"], "role": u["role"]}


def cleanup():
    now = int(time.time())
    q("DELETE FROM sessions WHERE expires<?", (now,))
    q("DELETE FROM tokens WHERE expires<?", (now,))


# ---------------------------------------------------------------- email
def send_email(to, subject, body):
    if not EMAIL_ON:
        print("[email not set up] To %s: %s\n%s\n" % (to, subject, body), flush=True)
        return
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = SMTP_FROM, to, subject
    msg.set_content(body)

    def go():
        try:
            if SMTP_PORT == 465:
                s = smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=ssl.create_default_context(), timeout=20)
            else:
                s = smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=20)
                s.ehlo()
                if s.has_extn("starttls"):
                    s.starttls(context=ssl.create_default_context())
                    s.ehlo()
            if SMTP_USER:
                s.login(SMTP_USER, SMTP_PASS)
            s.send_message(msg)
            s.quit()
        except Exception as e:  # never crash a request because email failed
            print("[email failed] %s: %s" % (to, e), file=sys.stderr, flush=True)

    threading.Thread(target=go, daemon=True).start()


# ---------------------------------------------------------------- meeting passes for Jitsi (JWT, HS256)
def b64url(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def jitsi_token(u):
    now = int(time.time())
    header = {"alg": "HS256", "typ": "JWT"}
    payload = {
        "aud": JITSI_AUD, "iss": JITSI_APP_ID, "sub": JITSI_SUB, "room": "*",
        "iat": now, "nbf": now - 10, "exp": now + 6 * 3600,
        "context": {"user": {"id": str(u["id"]), "name": u["name"], "email": u["email"]}},
    }
    signing = b64url(json.dumps(header, separators=(",", ":")).encode()) + "." + b64url(json.dumps(payload, separators=(",", ":")).encode())
    sig = hmac.new(JITSI_APP_SECRET.encode(), signing.encode(), hashlib.sha256).digest()
    return signing + "." + b64url(sig)


# ---------------------------------------------------------------- simple rate limits
_hits = {}
_hits_lock = threading.Lock()
LIMITS = {"login": (10, 600), "signup": (5, 600), "forgot": (5, 600), "reset": (10, 600)}


def limited(ip, bucket):
    n, window = LIMITS[bucket]
    now = time.time()
    with _hits_lock:
        k = (ip, bucket)
        hits = [t for t in _hits.get(k, []) if now - t < window]
        if len(hits) >= n:
            _hits[k] = hits
            return True
        hits.append(now)
        _hits[k] = hits
    return False


# ---------------------------------------------------------------- web server
class ApiError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


BLOCKED = re.compile(r"^/(server|\.git|\.github)(/|$)|/\.|\.db($|-)")


class Handler(SimpleHTTPRequestHandler):
    server_version = "TalentTrade"
    sys_version = ""

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=SITE_DIR, **kw)

    def log_message(self, fmt, *args):
        if self.path.startswith("/api/"):
            sys.stderr.write("%s %s\n" % (self.client_ip(), fmt % args))

    # --- helpers
    def client_ip(self):
        if TRUST_PROXY and self.headers.get("X-Forwarded-For"):
            return self.headers["X-Forwarded-For"].split(",")[0].strip()
        return self.client_address[0]

    def session_token(self):
        c = cookies.SimpleCookie(self.headers.get("Cookie", ""))
        return c[COOKIE].value if COOKIE in c else ""

    def current_user(self):
        t = self.session_token()
        if not t:
            return None
        return q("SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.expires>?",
                 (sha(t), int(time.time())), one=True)

    def cookie_header(self, token, max_age):
        parts = ["%s=%s" % (COOKIE, token), "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=%d" % max_age]
        if COOKIE_SECURE:
            parts.append("Secure")
        return "; ".join(parts)

    def send_json(self, status, data, cookie=None):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def redirect(self, location, cookie=None):
        self.send_response(303)
        self.send_header("Location", location)
        self.send_header("Cache-Control", "no-store")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()

    def read_json(self):
        # Only accept JSON from our own pages: blocks other websites submitting forms on a visitor's behalf.
        if "application/json" not in self.headers.get("Content-Type", ""):
            raise ApiError(415, "bad-request", "Expected JSON.")
        origin = self.headers.get("Origin")
        if origin and urlparse(origin).netloc != self.headers.get("Host", ""):
            raise ApiError(403, "bad-origin", "Request came from another website.")
        n = int(self.headers.get("Content-Length") or 0)
        if n > 10000:
            raise ApiError(413, "bad-request", "Request too large.")
        try:
            data = json.loads(self.rfile.read(n) or b"{}")
            return data if isinstance(data, dict) else {}
        except ValueError:
            raise ApiError(400, "bad-request", "Invalid JSON.")

    # --- routing
    def do_GET(self):
        u = urlparse(self.path)
        if u.path.startswith("/api/"):
            return self.api("GET", u)
        if BLOCKED.search(u.path):
            return self.send_error(404)
        return super().do_GET()

    def do_HEAD(self):
        if self.path.startswith("/api/") or BLOCKED.search(urlparse(self.path).path):
            return self.send_error(404)
        return super().do_HEAD()

    def do_POST(self):
        u = urlparse(self.path)
        if u.path.startswith("/api/"):
            return self.api("POST", u)
        self.send_error(405)

    def api(self, method, u):
        try:
            route = getattr(self, "%s_%s" % (method.lower(), u.path[5:].replace("-", "_")), None)
            if not route:
                raise ApiError(404, "not-found", "Unknown address.")
            route(u)
        except ApiError as e:
            self.send_json(e.status, {"error": e.code, "message": e.message})
        except Exception as e:  # keep the server running, but say something went wrong
            print("[error] %r" % e, file=sys.stderr, flush=True)
            self.send_json(500, {"error": "server", "message": "Something went wrong on the server."})

    # --- endpoints
    def get_config(self, u):
        self.send_json(200, {"accounts": True, "requireLoginToHost": REQUIRE_LOGIN_TO_HOST,
                             "emailConfirm": EMAIL_ON, "jitsiTokens": JITSI_ON, "jitsiDomain": JITSI_DOMAIN})

    def get_me(self, u):
        user = self.current_user()
        if not user:
            raise ApiError(401, "logged-out", "Not logged in.")
        self.send_json(200, {"user": public_user(user)})

    def post_signup(self, u):
        if limited(self.client_ip(), "signup"):
            raise ApiError(429, "rate-limited", "Too many attempts.")
        d = self.read_json()
        name = str(d.get("name", "")).strip()[:60]
        email = str(d.get("email", "")).strip().lower()[:254]
        pw = str(d.get("password", ""))
        role = str(d.get("role", ""))
        if not name:
            raise ApiError(400, "missing-name", "Please enter your name.")
        if not EMAIL_RE.match(email):
            raise ApiError(400, "invalid-email", "Please enter a valid email address.")
        if len(pw) < 8 or len(pw) > 200:
            raise ApiError(400, "weak-password", "Password must be at least 8 characters.")
        if role not in ROLES:
            role = ""
        if q("SELECT id FROM users WHERE email=?", (email,), one=True):
            raise ApiError(409, "exists", "There's already an account with that email.")
        with _lock:
            cur = _db.execute("INSERT INTO users(email,name,role,pw,confirmed,created) VALUES(?,?,?,?,?,?)",
                              (email, name, role, hash_pw(pw), 0 if EMAIL_ON else 1, int(time.time())))
            uid = cur.lastrowid
        if EMAIL_ON:
            t = new_token(uid, "confirm", 2 * 86400)
            send_email(email, "Confirm your TalentTrade account",
                       "Hi %s,\n\nWelcome to TalentTrade. Confirm your email to finish creating your account:\n\n%s/api/confirm?token=%s\n\n"
                       "The link works for 48 hours. If you didn't sign up, ignore this email.\n\nTalentTrade\n\"Limited funds, big dreams, problem solved\"\n"
                       % (name, PUBLIC_URL, t))
            return self.send_json(200, {"needsConfirm": True})
        user = q("SELECT * FROM users WHERE id=?", (uid,), one=True)
        self.send_json(200, {"needsConfirm": False, "user": public_user(user)},
                       cookie=self.cookie_header(new_session(uid), SESSION_DAYS * 86400))

    def get_confirm(self, u):
        t = (parse_qs(u.query).get("token") or [""])[0]
        uid = use_token(t, "confirm")
        if not uid:
            return self.redirect("/login.html?badlink=1")
        q("UPDATE users SET confirmed=1 WHERE id=?", (uid,))
        self.redirect("/login.html?confirmed=1", cookie=self.cookie_header(new_session(uid), SESSION_DAYS * 86400))

    def post_login(self, u):
        if limited(self.client_ip(), "login"):
            raise ApiError(429, "rate-limited", "Too many attempts.")
        d = self.read_json()
        email = str(d.get("email", "")).strip().lower()
        pw = str(d.get("password", ""))
        user = q("SELECT * FROM users WHERE email=?", (email,), one=True)
        if not check_pw(pw, user["pw"] if user else _DUMMY) or not user:
            raise ApiError(401, "invalid-login", "That email and password don't match an account.")
        if not user["confirmed"]:
            raise ApiError(403, "not-confirmed", "Please confirm your email first.")
        cleanup()
        self.send_json(200, {"user": public_user(user)}, cookie=self.cookie_header(new_session(user["id"]), SESSION_DAYS * 86400))

    def post_logout(self, u):
        t = self.session_token()
        if t:
            q("DELETE FROM sessions WHERE id=?", (sha(t),))
        self.send_json(200, {"ok": True}, cookie=self.cookie_header("", 0))

    def post_forgot(self, u):
        if limited(self.client_ip(), "forgot"):
            raise ApiError(429, "rate-limited", "Too many attempts.")
        d = self.read_json()
        email = str(d.get("email", "")).strip().lower()
        user = q("SELECT * FROM users WHERE email=?", (email,), one=True)
        if user:  # same answer either way, so this can't be used to find out who has an account
            t = new_token(user["id"], "reset", 3600)
            send_email(user["email"], "Reset your TalentTrade password",
                       "Hi %s,\n\nSomeone (hopefully you) asked to reset your TalentTrade password. Choose a new one here:\n\n%s/login.html?reset=%s\n\n"
                       "The link works for 1 hour. If you didn't ask for this, ignore this email; your password stays the same.\n\nTalentTrade\n"
                       % (user["name"], PUBLIC_URL, t))
        self.send_json(200, {"ok": True})

    def post_reset(self, u):
        if limited(self.client_ip(), "reset"):
            raise ApiError(429, "rate-limited", "Too many attempts.")
        d = self.read_json()
        pw = str(d.get("password", ""))
        if len(pw) < 8 or len(pw) > 200:
            raise ApiError(400, "weak-password", "Password must be at least 8 characters.")
        uid = use_token(str(d.get("token", "")), "reset")
        if not uid:
            raise ApiError(400, "bad-token", "This reset link has expired or was already used.")
        q("UPDATE users SET pw=?, confirmed=1 WHERE id=?", (hash_pw(pw), uid))
        q("DELETE FROM sessions WHERE user_id=?", (uid,))  # log out everywhere else
        user = q("SELECT * FROM users WHERE id=?", (uid,), one=True)
        self.send_json(200, {"user": public_user(user)}, cookie=self.cookie_header(new_session(uid), SESSION_DAYS * 86400))

    def get_jitsi_token(self, u):
        if not JITSI_ON:
            raise ApiError(404, "not-configured", "Meeting passes are not set up.")
        user = self.current_user()
        if not user:
            raise ApiError(401, "logged-out", "Not logged in.")
        self.send_json(200, {"token": jitsi_token(user)})


def main():
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    scheme = "http"
    if TLS_CERT and TLS_KEY:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.load_cert_chain(TLS_CERT, TLS_KEY)
        # handshake happens in each request's own thread, so one slow visitor can't hold up others
        srv.socket = ctx.wrap_socket(srv.socket, server_side=True, do_handshake_on_connect=False)
        scheme = "https"
    print("TalentTrade server running on %s://%s:%d" % (scheme, HOST, PORT))
    print("  site folder : %s" % SITE_DIR)
    print("  database    : %s" % DB_PATH)
    print("  email       : %s" % ("on (%s)" % SMTP_HOST if EMAIL_ON else "off - new accounts are confirmed straight away; reset links are printed here"))
    print("  meeting passes for Jitsi: %s" % ("on" if JITSI_ON else "off"))
    print("  video server: %s" % (JITSI_DOMAIN or "the one set in meet.html (meet.jit.si)"))
    print("  login needed to start meetings: %s" % ("yes" if REQUIRE_LOGIN_TO_HOST else "no"), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
