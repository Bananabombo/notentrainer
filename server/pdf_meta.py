"""Metadaten aus der Textebene eines PDFs: Titel, Untertitel, Komponist/Interpret, Tempo.

Viele PDFs (Notensatzprogramme, aber auch per OCR durchsuchbar gemachte Scans) enthalten eine
Textebene. Die ist für Titel und Zahlen deutlich zuverlässiger als die Bilderkennung von Audiveris.
"""
import re

try:
    import pymupdf
except Exception:  # noqa: BLE001
    pymupdf = None

TEMPO_WORDS = re.compile(r"\b(grave|largo|larghetto|lento|adagio|andante|andantino|moderato|allegretto|allegro|vivace|vivo|presto|prestissimo|tempo|swing|ballad|rubato|langsam|mäßig|massig|ruhig|lebhaft|schnell|bewegt)\b", re.I)
NOT_COMPOSER = re.compile(r"(herausgegeben|edited|edition|bearb|arr\.|arranged|copyright|©|\(c\)|all rights|verlag|publisher|imslp|www\.|http|nr\.\s*\d|seite|page)", re.I)
COMPOSER_HINT = re.compile(r"(\bmusic\b|\bmusik\b|\bcomposed\b|\bkomponist|\bby\b|\bvon\b|\(\s*\d{4}|\d{4}\s*[-–]\s*\d{4}|\bop\.?\s*\d)", re.I)
BAD_CHARS = re.compile(r"[?�□]")


def _lines(page):
    out = []
    for b in page.get_text("dict")["blocks"]:
        for l in b.get("lines", []):
            spans = [s for s in l["spans"] if s["text"].strip()]
            if not spans:
                continue
            text = re.sub(r"\s+", " ", " ".join(s["text"] for s in spans)).strip()
            size = max(s["size"] for s in spans)
            out.append({"text": text, "size": size, "x0": l["bbox"][0], "y0": l["bbox"][1], "x1": l["bbox"][2], "y1": l["bbox"][3]})
    # nebeneinanderliegende Stücke derselben Zeile zusammenfassen (OCR zerteilt Wörter)
    out.sort(key=lambda r: (round(r["y0"] / 4), r["x0"]))
    merged = []
    for r in out:
        last = merged[-1] if merged else None
        if last and abs(last["y0"] - r["y0"]) < 4 and abs(last["size"] - r["size"]) < 3 and 0 <= r["x0"] - last["x1"] < 25:
            # „La cand“ + „candeur“ (überlappende OCR-Teile) → „La candeur“
            a, b = last["text"], r["text"]
            k = next((n for n in range(min(len(a), len(b)), 2, -1) if a.endswith(b[:n])), 0)
            last["text"] = a + b[k:] if k else a + " " + b
            last["x1"] = max(last["x1"], r["x1"])
        elif last and abs(last["y0"] - r["y0"]) < 4 and r["x0"] < last["x1"] and abs(last["size"] - r["size"]) < 3:
            a, b = last["text"], r["text"]
            k = next((n for n in range(min(len(a), len(b)), 2, -1) if a.endswith(b[:n])), 0)
            last["text"] = a + b[k:] if k else a
            last["x1"] = max(last["x1"], r["x1"])
        else:
            merged.append(dict(r))
    return merged


def clean(t: str) -> str:
    t = re.sub(r'^[\s"“„\'»«]+|[\s"”“\'»«]+$', "", t or "")
    return re.sub(r"\s+", " ", t).strip()


def clean_composer(t: str) -> str:
    t = clean(t)
    t = re.sub(r"^(music|musik|words and music|text und musik|composed|komponiert)\s*(by|von|:)?\s*", "", t, flags=re.I)
    t = re.sub(r"^(by|von)\s+", "", t, flags=re.I)
    t = re.sub(r"\(?\s*\d{4}\s*[-–]\s*\d{2,4}\s*\)?", "", t)          # Lebensdaten
    t = re.sub(r"\b(op|opus)\.?\s*\d+[a-z]?(\s*(nr|no)\.?\s*\d+)?", "", t, flags=re.I)
    return clean(re.sub(r"[,;]\s*$", "", t))


def looks_like_text(t: str, min_letters=3) -> bool:
    letters = sum(c.isalpha() for c in t)
    return letters >= min_letters and letters >= 0.5 * len(t.replace(" ", ""))


def from_pdf(path) -> dict:
    """{'title', 'subtitle', 'composer', 'tempo'} – Felder fehlen, wenn nichts Verlässliches gefunden wurde."""
    if pymupdf is None:
        return {}
    try:
        doc = pymupdf.open(path)
    except Exception:  # noqa: BLE001
        return {}
    if not doc.page_count:
        return {}
    page = doc[0]
    W, H = page.rect.width, page.rect.height
    lines = [l for l in _lines(page) if l["y0"] < H * 0.32]
    res = {}
    texty = [l for l in lines if looks_like_text(l["text"]) and not BAD_CHARS.search(l["text"]) and len(l["text"]) <= 80]
    # Titel: größte Schrift im oberen Bereich (keine Tempo- oder Verlagsangabe)
    cands = [l for l in texty if not TEMPO_WORDS.search(l["text"]) and not NOT_COMPOSER.search(l["text"]) and l["size"] >= 12]
    if cands:
        t = max(cands, key=lambda l: (round(l["size"]), -l["y0"]))
        res["title"] = clean(t["text"])
        # Untertitel: direkt darunter, kleiner, mittig
        sub = [l for l in texty if l is not t and t["y1"] - 2 <= l["y0"] <= t["y1"] + 40 and l["size"] < t["size"]
               and abs((l["x0"] + l["x1"]) / 2 - W / 2) < W * 0.2 and not COMPOSER_HINT.search(l["text"])]
        if sub:
            res["subtitle"] = clean(" ".join(s["text"] for s in sorted(sub, key=lambda s: s["x0"])))
    # Komponist/Interpret: rechtsbündig oder mit Hinweis („Music by“, Lebensdaten, op.)
    comp = []
    for l in lines:
        tx = l["text"]
        if NOT_COMPOSER.search(tx) or TEMPO_WORDS.search(tx) or tx == res.get("title") or not looks_like_text(tx, 3):
            continue
        score = (3 if COMPOSER_HINT.search(tx) else 0) + (2 if l["x1"] > W * 0.7 and l["x0"] > W * 0.4 else 0)
        if score:
            comp.append((score, -l["y0"], tx))
    if comp:
        name = clean_composer(max(comp)[2])
        if looks_like_text(name, 3):
            res["composer"] = name
            res["composer_raw"] = max(comp)[2]
    # Tempo: Zahl hinter Tempowort / „=“ / Notenzeichen im oberen Bereich
    best = None
    for l in lines:
        for m in re.finditer(r"([=♩♪\.:Jj]?)\s*([0-9oOlI]{2,3})\b", l["text"]):
            prefix, raw = m.group(1), m.group(2)
            clean_digits = raw.isdigit()
            val = int(raw.translate(str.maketrans("oOlI", "0011"))) if re.fullmatch(r"[0-9oOlI]{2,3}", raw) else None
            if not val or not 40 <= val <= 260 or l["x0"] < W * 0.12 and not prefix:
                continue
            near_word = any(TEMPO_WORDS.search(o["text"]) and abs(o["y0"] - l["y0"]) < 18 and -10 < l["x0"] - o["x1"] < 80 for o in lines) \
                or bool(TEMPO_WORDS.search(l["text"][:m.start()]))
            rank = (3 if near_word else 0) + (2 if prefix else 0) + (1 if clean_digits else 0) + (1 if l["size"] < 14 else 0)
            if (near_word or prefix or clean_digits) and (best is None or rank > best[0]):
                best = (rank, val)
    if best and best[0] >= 2:
        res["tempo"] = best[1]
    return res


def credits_from_mxl_texts(texts):
    return [clean(t) for t in texts if t and looks_like_text(t, 3)]


def repair(text: str, alternatives) -> str:
    """Unlesbare Zeichen („Burgm?ller“) mit einer zweiten Lesung (Audiveris: „Burgmiiller“) reparieren."""
    if not text or not BAD_CHARS.search(text):
        return text
    pat = re.escape(text)
    for bad in ("\\?", "�", "□"):
        pat = pat.replace(bad, "(.{1,2}?)")
    umlaut = {"ii": "ü", "li": "ü", "il": "ü", "u": "ü", "ü": "ü", "6": "ö", "o": "ö", "ö": "ö", "a": "ä", "ä": "ä"}
    for alt in alternatives:
        m = re.search(pat, alt or "")
        if m:
            out = text
            for g in m.groups():
                out = BAD_CHARS.sub(umlaut.get(g, g), out, count=1)
            return out
    return BAD_CHARS.sub("", text)
