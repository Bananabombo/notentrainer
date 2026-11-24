# 🎹 Notentrainer

Kleine Web-App zum Üben des Notenlesens am Digitalpiano (entwickelt für das Roland FP-30X).

**App öffnen:** https://bananabombo.github.io/notentrainer/

## Funktionen
- Zufällige Noten im Violin-, Bass- oder Doppelschlüssel, drei Schwierigkeitsstufen, optional mit Vorzeichen
- Eingabe per **Web MIDI** (USB oder Bluetooth), per **Mikrofon** (Tonhöhenerkennung) oder über die Bildschirm-Klaviatur
- Sofortige Rückmeldung; die falsch gespielte Note wird im Notensystem angezeigt
- Statistik mit Trefferquote, Serie und Reaktionszeit; Noten, die oft falsch gespielt werden, kommen häufiger dran
- Als App installierbar (Vollbild), Bildschirm bleibt beim Üben an

## Unterstützte Geräte
| Gerät | MIDI | Mikrofon |
|---|---|---|
| Android-Tablet/-Handy mit Chrome | ✅ | ✅ |
| Mac/PC mit Chrome, Edge oder Firefox | ✅ | ✅ |
| Safari (Mac, iPhone, iPad) | ❌ | ✅ |
| iPhone/iPad mit „MIDIWeb Browser“ | ✅ | – |

MIDI und Mikrofon brauchen HTTPS oder `localhost`.

## Lokal starten
```bash
python3 -m http.server 8765
```
Dann `http://localhost:8765` in Chrome öffnen.
