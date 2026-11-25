# 🎹 Tonika

Web-App zum Klavierlernen am Digitalpiano (entwickelt für das Roland FP-30X) – minimalistisch, animiert, ohne Installation.

**App öffnen:** https://tonika.hohendorff.org (Spiegel: https://bananabombo.github.io/notentrainer/)

## Lernbereiche
| Bereich | Inhalt |
|---|---|
| **Noten lesen** | Zufällige Noten im Violin-, Bass- oder Doppelschlüssel, 3 Stufen, Vorzeichen; Schwachstellen kommen häufiger dran |
| **Akkorde** | 5 Stufen vom Dur-/Moll-Dreiklang bis zu Jazz-Erweiterungen (maj9, 13, 7♭9 …), Umkehrungen oder Grundstellung, Anzeige als Symbol oder in Noten |
| **Quintenzirkel** | Interaktiver, drehender Zirkel mit Vorzeichen, Tonleiter, Paralleltonart, Dominante, leitereigenen Akkorden – plus Quiz |
| **Tonleitern** | Dur, Moll (natürlich/harmonisch/melodisch), Kirchentonarten, Pentatonik, Blues, Jazz-Skalen – Ton für Ton geführt |
| **Improvisation** | Begleitband im Browser (Pop, Moll-Groove, Blues-Shuffle, Jazz ii–V–I, Moll ii–V–i, Jazz-Blues, Bossa) mit Live-Bewertung jedes Tons; Aufgaben „Nur Akkordtöne“ und „Leittöne auf die Eins“ |
| **Jazz** | Shell- und Rootless-Voicings (A/B), Chord-Scales, Jazz-Progressionen |
| **Fortschritt** | XP, Level, Tagesziel, Serie, 20 Abzeichen; Beherrschung je Note/Akkord/Tonleiter, Schwachstellen gezielt üben, Aktivitätskalender |
| **Editor** | Erkannte Stücke korrigieren: Noten antippen, Tonhöhe per Klavier/Tastatur/Knöpfen, Dauer, Pausen, Akkorde, Haltebögen, Takte einfügen/löschen, Schlüssel (Noten bleiben an ihrem Platz), Tonart, Taktart, Wiederholungen, Volten, Segno/Coda; Rhythmusprüfung; Original daneben |
| **Bibliothek** | MusicXML/MXL und MIDI hochladen, als Noten (OpenSheetMusicDisplay) oder Piano-Roll anzeigen, anhören (auch über das Digitalpiano), im Warte-Modus mitspielen (je Hand), als MIDI exportieren |

## Eingabe & Klang
- **Web MIDI** (USB oder Bluetooth) – Akkorde, exakte Tonhöhe, keine Verzögerung
- **Mikrofon** – einstimmige Tonhöhenerkennung (McLeod), z. B. für iPhone/Safari
- **Bildschirm-Klaviatur**
- Vorgespieltes kommt wahlweise aus dem Digitalpiano (MIDI-Out) oder dem Browser

| Gerät | MIDI | Mikrofon |
|---|---|---|
| Android-Tablet/-Handy mit Chrome | ✅ | ✅ |
| Mac/PC mit Chrome, Edge oder Firefox | ✅ | ✅ |
| Safari (Mac, iPhone, iPad) | ❌ | ✅ |
| iPhone/iPad mit „MIDIWeb Browser“ | ✅ | – |

MIDI und Mikrofon brauchen HTTPS oder `localhost`.

## Aufbau
Reines HTML/CSS/JavaScript (ES-Module), kein Build-Schritt – läuft auf GitHub Pages und auf jedem statischen Webserver (z. B. nginx auf dem Raspberry Pi).

```
index.html            App-Shell
css/style.css         Design-System (Hell/Dunkel), Animationen
js/app.js             Router mit View Transitions, Startseite, Einstellungen
js/core/              Musiktheorie, Eingabe (MIDI/Mikrofon), Audio-Engine & Sequencer,
                      Klaviatur, Notensatz (VexFlow), Speicher
js/modes/             Noten, Akkorde, Quintenzirkel, Tonleitern, Improvisation, Jazz, Bibliothek
demo/                 Beispielstück (gemeinfrei)
```
Bibliotheken per CDN: VexFlow 4.2.2, OpenSheetMusicDisplay 1.8.9 und @tonejs/midi 2.0.28 (die letzten beiden werden erst in der Bibliothek geladen).

## Lokal starten
```bash
python3 -m http.server 8765
```
Dann `http://localhost:8765` in Chrome öffnen.

## Konto & Server (Raspberry Pi)
Unter **tonika.hohendorff.org** läuft Tonika mit einem kleinen Server (`server/`, Python/FastAPI + SQLite):

- **Konten mit Login** (Argon2-Passwörter, Sitzungs-Cookie). Neue Konten brauchen einen Einladungscode (`REGISTER_CODE` in `deploy/.env`).
- **Sync**: Fortschritt und Einstellungen pro Konto (neuester Stand gewinnt), Bibliothek liegt auf dem Server – auf jedem Gerät gleich. Stücke aus dem Browser lassen sich ins Konto übernehmen.
- **Notenerkennung**: PDFs und Fotos werden im Hintergrund mit [Audiveris](https://github.com/Audiveris/audiveris) in MusicXML umgewandelt und sind danach spiel- und übbar (Original bleibt abrufbar). Am besten klappen gerade, scharfe Scans (300 dpi).

Ohne Server (z. B. GitHub Pages) funktioniert alles weiter lokal im Browser.

```bash
cd ~/Tonika && git pull                                   # App-Update (sofort live)
cd ~/Tonika/deploy && docker compose up -d --build        # nach Server-Änderungen
```
Daten liegen in `~/Tonika-data` (SQLite + Dateien).
