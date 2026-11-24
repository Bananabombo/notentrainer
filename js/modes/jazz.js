// Jazz-Hub: führt zu den jazzspezifischen Übungen
import { h, icon } from '../core/ui.js';
import { go } from '../app.js';

const ITEMS = [
  { title: 'Shell-Voicings', hue: 330, icon: 'chord', desc: 'Grundton, Terz und Septime – das Fundament jedes Jazz-Akkords.', to: '#/chords?voicing=shell&from=jazz' },
  { title: 'Rootless A', hue: 300, icon: 'chord', desc: 'Voicings ohne Grundton mit der Terz unten (3–5–7–9).', to: '#/chords?voicing=rootlessA&from=jazz' },
  { title: 'Rootless B', hue: 270, icon: 'chord', desc: 'Voicings ohne Grundton mit der Septime unten (7–9–3–5).', to: '#/chords?voicing=rootlessB&from=jazz' },
  { title: 'Erweiterte Akkorde', hue: 250, icon: 'sparkle', desc: 'maj9, 13, 7♭9, 7♯9, 6/9 – Farben lesen und greifen.', to: '#/chords?level=5&voicing=any&from=jazz' },
  { title: 'ii – V – I in Dur', hue: 20, icon: 'wave', desc: 'Improvisiere über die wichtigste Kadenz – mit Chord-Scales.', to: '#/improv?style=jazz251&from=jazz' },
  { title: 'ii – V – i in Moll', hue: 5, icon: 'wave', desc: 'Halbvermindert, ♭9-Dominante und Moll-Sext – dunkel und schön.', to: '#/improv?style=jazzMinor&from=jazz' },
  { title: 'Jazz-Blues', hue: 40, icon: 'wave', desc: '12 Takte mit Zwischendominanten und Turnaround.', to: '#/improv?style=jazzBlues&from=jazz' },
  { title: 'Bossa-Feeling', hue: 160, icon: 'wave', desc: 'Leichter brasilianischer Groove zum Mitspielen.', to: '#/improv?style=bossa&from=jazz' },
  { title: 'Jazz-Skalen', hue: 190, icon: 'scale', desc: 'Dorisch, Mixolydisch, Alteriert, Lydisch-Dominant üben.', to: '#/scales?t=dorian&from=jazz' }
];

export default {
  mount(root) {
    root.append(
      h('p', { style: { color: 'var(--muted)', margin: '0 4px 6px', maxWidth: '640px', animation: 'fadeUp .5s var(--ease) both' } },
        'Jazz-Klang entsteht aus Voicings, Leittönen und den passenden Skalen. Fang mit Shell-Voicings an, dann ii–V–I mit der Aufgabe „Leittöne auf die Eins“.'),
      h('div.hub', ITEMS.map((it, i) => {
        const t = h('h3', it.title);
        return h('button.mode-card', { style: { '--hue': it.hue, '--i': i, minHeight: '150px' }, onclick: () => go(it.to, t) },
          h('div.badge-icon', icon(it.icon)), t, h('p', it.desc));
      })));
  }
};
