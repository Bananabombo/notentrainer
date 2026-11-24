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


def postprocess(results: list[Path], target: Path, title: str = "") -> dict:
    """Alle Sätze zusammenführen, Tempi reparieren und als ein MXL speichern."""
    def order(p: Path):
        m = re.search(r"\.mvt(\d+)$", p.stem)
        return int(m.group(1)) if m else 0
    files = sorted(results, key=order)
    roots = [ET.fromstring(read_mxl(p)) for p in files]
    root = merge_movements(roots) if len(roots) > 1 else roots[0]
    tempos = fix_tempos(root)
    # Titel: der erkannte ist oft unzuverlässig (z. B. Untertitel statt Titel) – der Name des Stücks hat Vorrang
    mt = root.find("movement-title")
    ocr_title = clean_title(mt.text) if mt is not None and mt.text else ""
    final = clean_title(title) or ocr_title
    if final:
        if mt is None:
            mt = ET.Element("movement-title")
            root.insert(0, mt)
        mt.text = final
        work = root.find("work")
        if work is not None:
            root.remove(work)
    xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + DOCTYPE + "\n" + ET.tostring(root, encoding="unicode")
    write_mxl(target, xml)
    return {"movements": len(roots), "tempos_fixed": tempos, "title": final,
            "measures": len(root.find("part").findall("measure")) if root.find("part") is not None else 0}
