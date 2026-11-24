"""Nachbearbeitung der Audiveris-Ergebnisse.

- Mehrere „Sätze“ (score.mvt1.mxl, score.mvt2.mxl …) zu einem Stück zusammenfügen.
  Audiveris beginnt einen neuen Satz z. B. bei einer eingerückten Coda.
- Tempoangaben reparieren: Die Texterkennung liest Ziffern gelegentlich als Buchstaben
  („17o“ statt „170“). Daraus wird dann ein falsches Wiedergabetempo (<sound tempo="17">).
"""
import io
import re
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

# Buchstaben, die die Texterkennung typischerweise statt Ziffern liefert
OCR_DIGITS = str.maketrans({"o": "0", "O": "0", "D": "0", "Q": "0", "l": "1", "I": "1", "i": "1", "|": "1", "!": "1",
                            "Z": "2", "z": "2", "S": "5", "s": "5", "G": "6", "b": "6", "T": "7", "B": "8", "g": "9", "q": "9"})
DOCTYPE = '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">'


def read_mxl(path: Path) -> str:
    with zipfile.ZipFile(path) as z:
        name = None
        if "META-INF/container.xml" in z.namelist():
            m = re.search(r'full-path="([^"]+)"', z.read("META-INF/container.xml").decode("utf-8", "ignore"))
            name = m.group(1) if m else None
        if not name:
            name = next(n for n in z.namelist() if n.endswith((".xml", ".musicxml")) and not n.startswith("META-INF"))
        return z.read(name).decode("utf-8")


def write_mxl(path: Path, xml: str):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(zipfile.ZipInfo("mimetype"), "application/vnd.recordare.musicxml", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml",
                   '<?xml version="1.0" encoding="UTF-8"?>\n<container><rootfiles>'
                   '<rootfile full-path="score.xml" media-type="application/vnd.recordare.musicxml+xml"/>'
                   '</rootfiles></container>')
        z.writestr("score.xml", xml)
    path.write_bytes(buf.getvalue())


def parse_number(text: str):
    """„17o“ → 170, „l20“ → 120; None, wenn es keine Zahl ist."""
    t = (text or "").strip()
    if not t:
        return None
    fixed = t.translate(OCR_DIGITS)
    m = re.fullmatch(r"(\d+)(?:[.,](\d+))?", fixed)
    if not m:
        return None
    return float(m.group(1) + ("." + m.group(2) if m.group(2) else ""))


BEAT_FACTOR = {"whole": 4, "half": 2, "quarter": 1, "eighth": 0.5, "16th": 0.25}


def fix_tempos(root: ET.Element) -> int:
    """Tempo aus der Metronomangabe übernehmen, wenn <sound tempo> fehlt oder nicht dazu passt."""
    fixed = 0
    for direction in root.iter("direction"):
        metro = direction.find("direction-type/metronome")
        if metro is None:
            continue
        pm = metro.find("per-minute")
        if pm is None:
            continue
        bpm = parse_number(pm.text)
        if bpm is None or not 20 <= bpm <= 400:
            continue
        unit = metro.findtext("beat-unit") or "quarter"
        dotted = metro.find("beat-unit-dot") is not None
        quarters = bpm * BEAT_FACTOR.get(unit, 1) * (1.5 if dotted else 1)
        value = f"{quarters:g}"
        if pm.text.strip() != f"{bpm:g}":
            pm.text = f"{bpm:g}"
        sound = direction.find("sound")
        if sound is None:
            sound = ET.SubElement(direction, "sound")
        try:
            current = float(sound.get("tempo", "nan"))
        except ValueError:
            current = float("nan")
        if not (abs(current - quarters) < 0.5):
            sound.set("tempo", value)
            fixed += 1
    return fixed


def merge_movements(roots: list[ET.Element]) -> ET.Element:
    """Takte aller Sätze an den ersten anhängen (Stimmen nach Reihenfolge zugeordnet)."""
    base = roots[0]
    base_parts = base.findall("part")
    for other in roots[1:]:
        parts = other.findall("part")
        if len(parts) != len(base_parts):
            continue  # unpassende Besetzung – lieber weglassen als falsch zusammenfügen
        for bp, op in zip(base_parts, parts):
            for measure in op.findall("measure"):
                bp.append(measure)
    for part in base_parts:
        for i, measure in enumerate(part.findall("measure"), 1):
            if measure.get("implicit") == "yes" and i == 1:
                measure.set("number", "0")
            else:
                measure.set("number", str(i))
    return base


def clean_title(t: str) -> str:
    return re.sub(r'^[\s"“„\'»«]+|[\s"”“\'»«]+$', "", t or "").strip()


# ------------------------------------------------------------------ Aufräumen & Plausibilität
JUNK_WORD = re.compile(r"^[\s\d/|IiLl.,:;'`´^-]{0,12}$")   # Fingersätze („5 3“, „2 5 4“), einzelne Striche/Buchstaben


def remove_junk_text(root: ET.Element) -> int:
    """Fingersatz-Ziffern & Bruchstücke, die als Text erkannt wurden, entfernen."""
    removed = 0
    for credit in list(root.findall("credit")):
        words = " ".join((w.text or "") for w in credit.findall("credit-words")).strip()
        if JUNK_WORD.match(words) or sum(c.isalpha() for c in words) < 2:
            root.remove(credit); removed += 1
    for part in root.findall("part"):
        for measure in part.findall("measure"):
            for d in list(measure.findall("direction")):
                types = d.findall("direction-type")
                words = [w for t in types for w in t.findall("words")]
                if words and len(words) == sum(len(list(t)) for t in types):
                    txt = " ".join((w.text or "") for w in words).strip()
                    if JUNK_WORD.match(txt):
                        measure.remove(d); removed += 1
                    else:
                        for w in words:   # „Allegro moderato J“ → „Allegro moderato“ (J = gelesenes Notensymbol)
                            w.text = re.sub(r"\s+[JjI|]\s*$", "", w.text or "")
    return removed


def _key_alters(fifths: int) -> dict:
    order_sharp, order_flat = "FCGDAEB", "BEADGCF"
    if fifths > 0:
        return {s: 1 for s in order_sharp[:fifths]}
    return {s: -1 for s in order_flat[:-fifths]} if fifths < 0 else {}


def fix_spurious_keys(root: ET.Element) -> int:
    """Tonartwechsel mitten im Stück ohne Doppelstrich davor sind fast immer ein gelesenes Vorzeichen.
    Der Wechsel wird verworfen; die betroffenen Noten der Folgetakte bekommen ihre ursprüngliche Tonhöhe zurück."""
    fixed = 0
    for part in root.findall("part"):
        measures = part.findall("measure")
        current = None
        for i, m in enumerate(measures):
            key = m.find("attributes/key")
            if key is None or key.find("fifths") is None:
                if i == 0:
                    current = 0
                continue
            fifths = int(key.findtext("fifths"))
            if current is None:
                if i == 0:
                    current = fifths; continue
                current = 0   # vorher keine Tonart angegeben = C-Dur/a-Moll
            prev = measures[i - 1] if i else None
            double = prev is not None and any((b.findtext("bar-style") or "") in ("light-light", "light-heavy", "heavy-light")
                                              for b in prev.findall("barline"))
            if double or fifths == current:
                current = fifths; continue
            # verdächtig: Wechsel entfernen und Vorzeichen in den Folgetakten zurücknehmen
            new, old = _key_alters(fifths), _key_alters(current)
            m.find("attributes").remove(key)
            for later in measures[i + 1:]:
                if later.find("attributes/key") is not None:
                    break
                for n in later.iter("note"):
                    pitch = n.find("pitch")
                    if pitch is None or n.find("accidental") is not None:
                        continue
                    step = pitch.findtext("step")
                    alter = pitch.find("alter")
                    if step in new and alter is not None and int(float(alter.text)) == new[step] and step not in old:
                        pitch.remove(alter)
            fixed += 1
    return fixed


def set_tempo(root: ET.Element, bpm: float) -> None:
    """Tempo (Viertel pro Minute) am Anfang setzen bzw. korrigieren."""
    first = root.find("part/measure")
    if first is None:
        return
    for d in root.iter("direction"):
        snd = d.find("sound")
        metro = d.find("direction-type/metronome")
        if metro is not None:
            pm = metro.find("per-minute")
            if pm is not None:
                pm.text = f"{bpm:g}"
            if snd is None:
                snd = ET.SubElement(d, "sound")
            snd.set("tempo", f"{bpm:g}")
            return
    d = ET.Element("direction", {"placement": "above"})
    dt = ET.SubElement(d, "direction-type")
    mt = ET.SubElement(dt, "metronome")
    ET.SubElement(mt, "beat-unit").text = "quarter"
    ET.SubElement(mt, "per-minute").text = f"{bpm:g}"
    ET.SubElement(d, "sound", {"tempo": f"{bpm:g}"})
    idx = next((i for i, c in enumerate(list(first)) if c.tag not in ("attributes", "print")), len(first))
    first.insert(idx, d)


def rhythm_report(root: ET.Element) -> list[int]:
    """Takte, deren Notenwerte nicht zur Taktart passen (Hinweis auf Erkennungsfehler)."""
    bad = set()
    for part in root.findall("part"):
        divisions, beats, beat_type, nstaves = 1, 4, 4, 1
        for m in part.findall("measure"):
            a = m.find("attributes")
            if a is not None:
                divisions = int(a.findtext("divisions") or divisions)
                nstaves = int(a.findtext("staves") or nstaves)
                if a.find("time") is not None:
                    beats = int(re.sub(r"\D.*", "", a.findtext("time/beats") or "4") or 4)
                    beat_type = int(a.findtext("time/beat-type") or 4)
            expected = divisions * 4 * beats / beat_type
            sums = {}
            for n in m.findall("note"):
                if n.find("chord") is not None or n.find("grace") is not None or n.find("cue") is not None:
                    continue
                k = (n.findtext("staff") or "1", n.findtext("voice") or "1")
                sums[k] = sums.get(k, 0) + int(n.findtext("duration") or 0)
            staffs = {}
            for (st, _), v in sums.items():
                staffs.setdefault(st, []).append(v)
            implicit = m.get("implicit") == "yes"
            num = int(re.sub(r"\D", "", m.get("number") or "0") or 0)
            if len(staffs) < nstaves and not implicit:
                bad.add(num)   # ein System ganz leer – da fehlt etwas
            for st, vals in staffs.items():
                if not implicit and not any(abs(v - expected) < 0.5 for v in vals):
                    bad.add(num)
    return sorted(bad)


def postprocess(results: list[Path], target: Path, title: str = "", meta: dict | None = None) -> dict:
    """Sätze zusammenführen, aufräumen, Tempo/Tonart reparieren, Titel/Komponist setzen, als ein MXL speichern."""
    meta = meta or {}
    def order(p: Path):
        m = re.search(r"\.mvt(\d+)$", p.stem)
        return int(m.group(1)) if m else 0
    files = sorted(results, key=order)
    roots = [ET.fromstring(read_mxl(p)) for p in files]
    root = merge_movements(roots) if len(roots) > 1 else roots[0]
    junk = remove_junk_text(root)
    keys = fix_spurious_keys(root)
    tempos = fix_tempos(root)
    if meta.get("tempo"):
        set_tempo(root, meta["tempo"])
    # Titel & Komponist
    mt = root.find("movement-title")
    ocr_title = clean_title(mt.text) if mt is not None and mt.text else ""
    final = clean_title(meta.get("title") or title) or ocr_title
    if final:
        if mt is None:
            mt = ET.Element("movement-title"); root.insert(0, mt)
        mt.text = final
        work = root.find("work")
        if work is not None:
            root.remove(work)
    composer = meta.get("composer")
    ident = root.find("identification")
    if ident is not None:
        for c in list(ident.findall("creator")):
            ident.remove(c)          # Audiveris setzt hier oft den Herausgeber o. Ä.
        if composer:
            el = ET.Element("creator", {"type": "composer"}); el.text = composer
            ident.insert(0, el)
    # Credits (Kopfzeilen auf dem Blatt) nur behalten, wenn sie nicht doppelt zu Titel/Komponist sind
    for credit in list(root.findall("credit")):
        txt = " ".join((w.text or "") for w in credit.findall("credit-words")).strip()
        if txt and (clean_title(txt) == final or (composer and composer.split()[-1] in txt)):
            root.remove(credit)
    bad = rhythm_report(root)
    xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + DOCTYPE + "\n" + ET.tostring(root, encoding="unicode")
    write_mxl(target, xml)
    first_part = root.find("part")
    return {"movements": len(roots), "tempos_fixed": tempos, "keys_fixed": keys, "junk_removed": junk, "title": final,
            "composer": composer or "", "uncertain": bad,
            "measures": len(first_part.findall("measure")) if first_part is not None else 0}
