"""Tonika-Server: liefert die App aus und stellt eine kleine API bereit.

- Konten mit Login (Argon2-Passwörter, Sitzungs-Cookie)
- Speicher pro Konto: Einstellungen/Fortschritt (JSON) und Bibliothek (Dateien)
- Notenerkennung (OMR): PDF/Fotos werden im Hintergrund mit Audiveris in MusicXML umgewandelt
"""
import json
import os
import queue
import re
import secrets
import shutil
import sqlite3
import subprocess
import threading
import time
import zipfile
from pathlib import Path

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from musicxml_fix import clean_title, postprocess, read_mxl, write_mxl, rhythm_report
import xml.etree.ElementTree as ET
import pdf_meta

DATA = Path(os.environ.get("DATA_DIR", "./data"))
STATIC = Path(os.environ.get("STATIC_DIR", ".."))
AUDIVERIS = os.environ.get("AUDIVERIS", "/opt/audiveris/bin/Audiveris")
REGISTER_CODE = os.environ.get("REGISTER_CODE", "")
MAX_UPLOAD = 60 * 1024 * 1024
SESSION_DAYS = 180
COOKIE = "tonika_session"

DATA.mkdir(parents=True, exist_ok=True)
(DATA / "songs").mkdir(exist_ok=True)
ph = PasswordHasher()

# ---------------------------------------------------------------- Datenbank
db = sqlite3.connect(DATA / "tonika.db", check_same_thread=False, isolation_level=None)
db.row_factory = sqlite3.Row
db.execute("PRAGMA journal_mode=WAL")
db.execute("PRAGMA foreign_keys=ON")
lock = threading.RLock()
db.executescript("""
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE NOT NULL,
  pw TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS state (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, key TEXT NOT NULL,
  value TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (user_id, key));
CREATE TABLE IF NOT EXISTS songs (
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT, meta TEXT, type TEXT, file_name TEXT, size INTEGER, added INTEGER,
  status TEXT, orig_type TEXT, error TEXT, updated INTEGER);
""")
if "composer" not in [r[1] for r in db.execute("PRAGMA table_info(songs)")]:
    db.execute("ALTER TABLE songs ADD COLUMN composer TEXT")


def q(sql, *args):
    with lock:
        return db.execute(sql, args).fetchall()


def q1(sql, *args):
    rows = q(sql, *args)
    return rows[0] if rows else None


now = lambda: int(time.time() * 1000)

# ---------------------------------------------------------------- App
app = FastAPI(title="Tonika", docs_url=None, redoc_url=None, openapi_url=None)

BLOCKED = re.compile(r"^/(\.git|\.github|server|deploy)(/|$)")


@app.middleware("http")
async def guard(request: Request, call_next):
    path = request.url.path
    if BLOCKED.match(path):
        return Response(status_code=404)
    resp = await call_next(request)
    if not path.startswith("/api/"):
        if re.search(r"\.(png|svg|woff2?)$", path):
            resp.headers["Cache-Control"] = "public, max-age=604800"
        else:
            resp.headers["Cache-Control"] = "no-cache"
    else:
        resp.headers["Cache-Control"] = "no-store"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "same-origin"
    return resp


# ---------------------------------------------------------------- Login
_attempts: dict[str, list[float]] = {}


def throttle(request: Request):
    ip = request.headers.get("cf-connecting-ip") or (request.client.host if request.client else "?")
    t = time.time()
    hits = [x for x in _attempts.get(ip, []) if t - x < 600]
    if len(hits) >= 20:
        raise HTTPException(429, "Zu viele Versuche – bitte in ein paar Minuten nochmal.")
    hits.append(t)
    _attempts[ip] = hits


def current_user(request: Request):
    token = request.cookies.get(COOKIE)
    if not token:
        raise HTTPException(401, "Nicht angemeldet")
    row = q1("SELECT u.id, u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?", token, now())
    if not row:
        raise HTTPException(401, "Nicht angemeldet")
    return row


def start_session(resp: Response, user_id: int):
    token = secrets.token_urlsafe(32)
    q("INSERT INTO sessions VALUES (?,?,?,?)", token, user_id, now(), now() + SESSION_DAYS * 86400_000)
    resp.set_cookie(COOKIE, token, max_age=SESSION_DAYS * 86400, httponly=True, secure=True, samesite="lax", path="/")


@app.get("/api/config")
def config():
    return {"registration": "code" if REGISTER_CODE else "open", "omr": Path(AUDIVERIS).exists()}


@app.get("/api/me")
def me(user=Depends(current_user)):
    return {"username": user["username"]}


@app.post("/api/register")
async def register(request: Request, response: Response):
    throttle(request)
    body = await request.json()
    username = str(body.get("username", "")).strip()
    password = str(body.get("password", ""))
    if REGISTER_CODE and not secrets.compare_digest(str(body.get("code", "")).strip(), REGISTER_CODE):
        raise HTTPException(403, "Der Einladungscode stimmt nicht.")
    if not re.fullmatch(r"[\wäöüÄÖÜß.\- ]{2,32}", username):
        raise HTTPException(400, "Benutzername: 2–32 Zeichen (Buchstaben, Zahlen, . - _).")
    if len(password) < 8:
        raise HTTPException(400, "Das Passwort braucht mindestens 8 Zeichen.")
    if q1("SELECT 1 FROM users WHERE username=?", username):
        raise HTTPException(409, "Diesen Namen gibt es schon.")
    q("INSERT INTO users (username, pw, created) VALUES (?,?,?)", username, ph.hash(password), now())
    uid = q1("SELECT id FROM users WHERE username=?", username)["id"]
    start_session(response, uid)
    return {"username": username}


@app.post("/api/login")
async def login(request: Request, response: Response):
    throttle(request)
    body = await request.json()
    row = q1("SELECT id, username, pw FROM users WHERE username=?", str(body.get("username", "")).strip())
    try:
        if not row:
            raise VerifyMismatchError()
        ph.verify(row["pw"], str(body.get("password", "")))
    except VerifyMismatchError:
        raise HTTPException(401, "Name oder Passwort falsch.")
    if ph.check_needs_rehash(row["pw"]):
        q("UPDATE users SET pw=? WHERE id=?", ph.hash(str(body.get("password"))), row["id"])
    start_session(response, row["id"])
    return {"username": row["username"]}


@app.post("/api/logout")
def logout(request: Request, response: Response):
    token = request.cookies.get(COOKIE)
    if token:
        q("DELETE FROM sessions WHERE token=?", token)
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@app.post("/api/password")
async def change_password(request: Request, user=Depends(current_user)):
    throttle(request)
    body = await request.json()
    row = q1("SELECT pw FROM users WHERE id=?", user["id"])
    try:
        ph.verify(row["pw"], str(body.get("old", "")))
    except VerifyMismatchError:
        raise HTTPException(401, "Das bisherige Passwort stimmt nicht.")
    if len(str(body.get("new", ""))) < 8:
        raise HTTPException(400, "Das neue Passwort braucht mindestens 8 Zeichen.")
    q("UPDATE users SET pw=? WHERE id=?", ph.hash(str(body["new"])), user["id"])
    return {"ok": True}


# ---------------------------------------------------------------- Einstellungen & Fortschritt
STATE_KEYS = re.compile(r"^[\w.\-]{1,64}$")


@app.get("/api/state")
def get_state(user=Depends(current_user)):
    return {r["key"]: {"value": json.loads(r["value"]), "updated": r["updated"]}
            for r in q("SELECT key, value, updated FROM state WHERE user_id=?", user["id"])}


@app.put("/api/state/{key}")
async def put_state(key: str, request: Request, user=Depends(current_user)):
    if not STATE_KEYS.match(key):
        raise HTTPException(400, "Ungültiger Schlüssel")
    raw = await request.body()
    if len(raw) > 512 * 1024:
        raise HTTPException(413, "Zu groß")
    value = json.loads(raw)
    q("INSERT INTO state VALUES (?,?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value, updated=excluded.updated",
      user["id"], key, json.dumps(value), now())
    return {"ok": True}


# ---------------------------------------------------------------- Bibliothek
EXT = {"midi": ".mid", "mxl": ".mxl", "musicxml": ".musicxml", "pdf": ".pdf", "image": ".img"}
ID_RE = re.compile(r"^[\w\-.]{4,64}$")


def song_dir(uid: int, sid: str) -> Path:
    return DATA / "songs" / str(uid) / sid


def song_json(r):
    return {"id": r["id"], "title": r["title"], "meta": r["meta"], "type": r["type"], "fileName": r["file_name"],
            "size": r["size"], "added": r["added"], "status": r["status"], "origType": r["orig_type"],
            "error": r["error"], "updated": r["updated"], "composer": r["composer"] or ""}


def get_song(uid: int, sid: str):
    r = q1("SELECT * FROM songs WHERE id=? AND user_id=?", sid, uid)
    if not r:
        raise HTTPException(404, "Stück nicht gefunden")
    return r


@app.get("/api/songs")
def list_songs(user=Depends(current_user)):
    return [song_json(r) for r in q("SELECT * FROM songs WHERE user_id=? ORDER BY added DESC", user["id"])]


@app.get("/api/songs/{sid}")
def song_meta(sid: str, user=Depends(current_user)):
    out = song_json(get_song(user["id"], sid))
    rep = song_dir(user["id"], sid) / "omr-report.json"
    if rep.exists():
        try:
            out["report"] = json.loads(rep.read_text())
        except Exception:  # noqa: BLE001
            pass
    return out


@app.post("/api/songs")
async def upload_song(file: UploadFile = File(...), meta: str = Form(...), user=Depends(current_user)):
    m = json.loads(meta)
    sid = str(m.get("id") or secrets.token_hex(8))
    if not ID_RE.match(sid):
        raise HTTPException(400, "Ungültige ID")
    typ = m.get("type")
    if typ not in EXT:
        raise HTTPException(400, "Unbekanntes Format")
    existing = q1("SELECT user_id FROM songs WHERE id=?", sid)
    if existing and existing["user_id"] != user["id"]:
        raise HTTPException(409, "ID vergeben")
    d = song_dir(user["id"], sid)
    d.mkdir(parents=True, exist_ok=True)
    target = d / ("original" + EXT[typ])
    size = 0
    with open(target, "wb") as f:
        while chunk := await file.read(1 << 20):
            size += len(chunk)
            if size > MAX_UPLOAD:
                f.close(); shutil.rmtree(d, ignore_errors=True)
                raise HTTPException(413, "Datei ist größer als 60 MB.")
            f.write(chunk)
    needs_omr = typ in ("pdf", "image")
    status = "omr-queued" if needs_omr and Path(AUDIVERIS).exists() else ("omr-pending" if needs_omr else "ready")
    q("INSERT OR REPLACE INTO songs (id, user_id, title, meta, type, file_name, size, added, status, orig_type, error, updated, composer) "
      "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", sid, user["id"], str(m.get("title") or file.filename)[:200],
      str(m.get("meta") or "")[:200], typ, file.filename, size, int(m.get("added") or now()), status, typ, None, now(),
      str(m.get("composer") or "")[:200])
    if status == "omr-queued":
        jobs.put((user["id"], sid))
    return song_json(get_song(user["id"], sid))


def current_file(uid: int, r) -> Path:
    d = song_dir(uid, r["id"])
    if (d / "score.mxl").exists():
        return d / "score.mxl"
    return d / ("original" + EXT[r["orig_type"]])


@app.get("/api/songs/{sid}/file")
def song_file(sid: str, orig: int = 0, user=Depends(current_user)):
    r = get_song(user["id"], sid)
    p = song_dir(user["id"], sid) / ("original" + EXT[r["orig_type"]]) if orig else current_file(user["id"], r)
    if not p.exists():
        raise HTTPException(404, "Datei fehlt")
    return FileResponse(p, media_type="application/octet-stream")


@app.put("/api/songs/{sid}/score")
async def put_score(sid: str, request: Request, user=Depends(current_user)):
    """Im Editor korrigierte Noten speichern (MusicXML). Die vorige Fassung wandert in den Verlauf."""
    r = get_song(user["id"], sid)
    raw = await request.body()
    if len(raw) > 20 * 1024 * 1024:
        raise HTTPException(413, "Zu groß")
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        raise HTTPException(400, "Kein gültiges MusicXML")
    if root.tag != "score-partwise":
        raise HTTPException(400, "Nur MusicXML (partwise) wird unterstützt")
    d = song_dir(user["id"], sid)
    d.mkdir(parents=True, exist_ok=True)
    hist = d / "history"
    if (d / "score.mxl").exists():
        hist.mkdir(exist_ok=True)
        shutil.copy(d / "score.mxl", hist / f"score-{now()}.mxl")
        for old in sorted(hist.glob("score-*.mxl"))[:-20]:
            old.unlink()
    xml = raw.decode("utf-8")
    write_mxl(d / "score.mxl", xml)
    title = (root.findtext("movement-title") or root.findtext("work/work-title") or r["title"] or "").strip()
    composer = (root.findtext("identification/creator[@type='composer']") or r["composer"] or "").strip()
    bad = rhythm_report(root)
    rep_path = d / "omr-report.json"
    rep = {}
    if rep_path.exists():
        try:
            rep = json.loads(rep_path.read_text())
        except Exception:  # noqa: BLE001
            rep = {}
    rep.update({"uncertain": bad, "edited": now(), "measures": len(root.find("part").findall("measure")) if root.find("part") is not None else 0})
    rep_path.write_text(json.dumps(rep))
    base = re.sub(r"( · \d+ unsicher| · bearbeitet)", "", r["meta"] or "")
    base = re.sub(r"\d+ Takte", f"{rep['measures']} Takte", base)
    meta = (base + " · bearbeitet" + (f" · {len(bad)} unsicher" if bad else "")).strip(" ·")
    q("UPDATE songs SET type='mxl', title=?, composer=?, meta=?, updated=? WHERE id=?", title[:200], composer[:200], meta[:200], now(), sid)
    return song_json(get_song(user["id"], sid))


@app.patch("/api/songs/{sid}")
async def edit_song(sid: str, request: Request, user=Depends(current_user)):
    get_song(user["id"], sid)
    body = await request.json()
    if "title" in body:
        q("UPDATE songs SET title=?, updated=? WHERE id=?", str(body["title"])[:200], now(), sid)
    if "composer" in body:
        q("UPDATE songs SET composer=?, updated=? WHERE id=?", str(body["composer"])[:200], now(), sid)
    return song_json(get_song(user["id"], sid))


@app.delete("/api/songs/{sid}")
def delete_song(sid: str, user=Depends(current_user)):
    get_song(user["id"], sid)
    q("DELETE FROM songs WHERE id=?", sid)
    shutil.rmtree(song_dir(user["id"], sid), ignore_errors=True)
    return {"ok": True}


@app.post("/api/songs/{sid}/omr")
def retry_omr(sid: str, user=Depends(current_user)):
    r = get_song(user["id"], sid)
    if r["orig_type"] not in ("pdf", "image"):
        raise HTTPException(400, "Nur für PDF und Fotos")
    if not Path(AUDIVERIS).exists():
        raise HTTPException(503, "Notenerkennung ist auf diesem Server nicht installiert")
    q("UPDATE songs SET status='omr-queued', error=NULL, updated=? WHERE id=?", now(), sid)
    jobs.put((user["id"], sid))
    return song_json(get_song(user["id"], sid))


# ---------------------------------------------------------------- Notenerkennung (Audiveris)
jobs: "queue.Queue[tuple[int, str]]" = queue.Queue()


def run_omr(uid: int, sid: str):
    r = q1("SELECT * FROM songs WHERE id=? AND user_id=?", sid, uid)
    if not r or r["status"] not in ("omr-queued", "omr-running"):
        return
    d = song_dir(uid, sid)
    src = d / ("original" + EXT[r["orig_type"]])
    work = d / "omr"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir()
    # Audiveris erkennt das Format an der Endung
    if r["orig_type"] == "image":
        head = src.read_bytes()[:12]
        ext = ".png" if head.startswith(b"\x89PNG") else ".tif" if head[:2] in (b"II", b"MM") else ".jpg"
    else:
        ext = ".pdf"
    inp = work / ("score" + ext)
    shutil.copy(src, inp)
    q("UPDATE songs SET status='omr-running', updated=? WHERE id=?", now(), sid)
    env = dict(os.environ, JAVA_OPTS=os.environ.get("OMR_JAVA_OPTS", "-Xmx2g"))
    meta = pdf_meta.from_pdf(src) if r["orig_type"] == "pdf" else {}
    try:
        p = subprocess.run(["nice", "-n", "10", AUDIVERIS, "-batch", "-export", "-output", str(work), *audiveris_options(src, r["orig_type"]), "--", str(inp)],
                           capture_output=True, text=True, timeout=int(os.environ.get("OMR_TIMEOUT", "1200")), env=env)
        (work / "audiveris.log").write_text((p.stdout or "") + "\n" + (p.stderr or ""))
        results = sorted(work.rglob("*.mxl"))
        if not results:
            raise RuntimeError("Keine Noten erkannt – am besten klappt ein gerader, scharfer Scan (300 dpi).")
        # Titel/Komponist: Textebene des PDFs, unleserliche Zeichen mit der Lesung von Audiveris reparieren
        credits = []
        for res in results:
            try:
                credits += re.findall(r"<(?:credit-words|movement-title|creator)[^>]*>([^<]+)<", read_mxl(res))
            except Exception:  # noqa: BLE001
                pass
        for k in ("title", "composer"):
            if meta.get(k):
                meta[k] = pdf_meta.repair(meta[k], credits + [meta.get("composer_raw", "")])
        if meta.get("composer"):
            meta["composer"] = pdf_meta.clean_composer(meta["composer"])
        file_stem = Path(r["file_name"] or "").stem
        title = clean_title(r["title"])
        # Dateiname nur behalten, wenn er „sprechend“ ist – sonst den Titel vom Notenblatt
        if meta.get("title") and (not title or title == clean_title(file_stem) or looks_technical(title)):
            title = meta["title"]
        meta["title"] = title
        try:
            info = postprocess(results, d / "score.mxl", title, meta)
        except Exception as e:  # noqa: BLE001 – Nachbearbeitung darf die Erkennung nicht verhindern
            (work / "postprocess.log").write_text(repr(e))
            shutil.copy(merge_or_first(results), d / "score.mxl")
            info = {}
        if not title:
            title = xml_title(d / "score.mxl") or "Unbenannt"
        unsure = info.get("uncertain") or []
        meta_txt = f"Erkannt aus {'PDF' if r['orig_type'] == 'pdf' else 'Foto'}" + (f" · {info['measures']} Takte" if info.get("measures") else "") \
            + (f" · {len(unsure)} unsicher" if unsure else "")
        (d / "omr-report.json").write_text(json.dumps(info))
        composer = info.get("composer") or r["composer"] or ""
        q("UPDATE songs SET type='mxl', status='ready', title=?, meta=?, composer=?, error=NULL, updated=? WHERE id=?",
          title, meta_txt, composer, now(), sid)
    except subprocess.TimeoutExpired:
        q("UPDATE songs SET status='omr-failed', error=?, updated=? WHERE id=?", "Zeitüberschreitung bei der Erkennung", now(), sid)
    except Exception as e:  # noqa: BLE001
        q("UPDATE songs SET status='omr-failed', error=?, updated=? WHERE id=?", str(e)[:300], now(), sid)


def looks_technical(name: str) -> bool:
    """Dateinamen wie „IMSLP57501-PMLP07983-Burgmueller_25_…“ oder „scan_0001“ sind keine guten Titel."""
    n = name or ""
    return bool(re.search(r"(imslp|pmlp|scan|img|dsc|^\d+$|\d{4,})", n, re.I)) or n.count("_") >= 2 or len(n) > 60


def audiveris_options(src: Path, orig_type: str) -> list[str]:
    opts = ["-option", "org.audiveris.omr.text.Language.defaultSpecification=deu+eng",
            "-option", "org.audiveris.omr.sheet.ProcessingSwitches.fingerings=true"]
    if orig_type == "pdf":
        # 400 dpi statt 300: deutlich weniger Fehler bei kleinen Zeichen (Vorzeichen, Schlüssel, Fingersätze),
        # begrenzt auf ~19 Mio. Pixel pro Seite (Grenze von Audiveris)
        dpi = 400
        try:
            if pdf_meta.pymupdf:
                doc = pdf_meta.pymupdf.open(src)
                area = max(pg.rect.width * pg.rect.height for pg in doc) / (72 * 72)
                dpi = max(300, min(400, int((19_000_000 / area) ** 0.5)))
        except Exception:  # noqa: BLE001
            pass
        opts += ["-option", f"org.audiveris.omr.image.ImageLoading.pdfResolution={dpi}"]
    return opts


def merge_or_first(results):
    # Mehrere Sätze (mvt1, mvt2 …): der erste ist meist das ganze Stück; Audiveris exportiert sonst „score.mxl“
    exact = [p for p in results if p.stem == "score"]
    return exact[0] if exact else results[0]


def xml_title(mxl: Path):
    try:
        with zipfile.ZipFile(mxl) as z:
            name = next(n for n in z.namelist() if n.endswith((".xml", ".musicxml")) and not n.startswith("META-INF"))
            txt = z.read(name).decode("utf-8", "ignore")[:20000]
        m = re.search(r"<work-title>([^<]+)</work-title>", txt) or re.search(r"<movement-title>([^<]+)</movement-title>", txt)
        t = clean_title(m.group(1)) if m else ""
        return t if t and t.lower() not in ("score", "title") else ""
    except Exception:  # noqa: BLE001
        return ""


def worker():
    while True:
        uid, sid = jobs.get()
        try:
            run_omr(uid, sid)
        finally:
            jobs.task_done()


for r in q("SELECT id, user_id FROM songs WHERE status IN ('omr-queued','omr-running')"):
    q("UPDATE songs SET status='omr-queued' WHERE id=?", r["id"])
    jobs.put((r["user_id"], r["id"]))
threading.Thread(target=worker, daemon=True).start()


@app.exception_handler(HTTPException)
async def http_error(request: Request, exc: HTTPException):
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)


# ---------------------------------------------------------------- App ausliefern (zuletzt)
app.mount("/", StaticFiles(directory=STATIC, html=True), name="site")
