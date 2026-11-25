// Minimaler ZIP-Leser für komprimierte MusicXML-Dateien (.mxl) – nutzt DecompressionStream des Browsers.
const td = new TextDecoder();

async function inflate(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Alle Dateien eines ZIPs als { name: Uint8Array } */
export async function unzip(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  // Ende des zentralen Verzeichnisses suchen
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Keine gültige ZIP-Datei');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = {};
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = td.decode(u8.subarray(p + 46, p + 46 + nameLen));
    const lName = dv.getUint16(local + 26, true), lExtra = dv.getUint16(local + 28, true);
    const start = local + 30 + lName + lExtra;
    const data = u8.subarray(start, start + csize);
    out[name] = method === 0 ? data.slice() : method === 8 ? await inflate(data) : null;
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** MusicXML-Text aus .mxl (oder unverändert aus .musicxml) */
export async function musicXmlText(buf, type) {
  if (type !== 'mxl') return td.decode(buf);
  const files = await unzip(buf);
  let name = null;
  if (files['META-INF/container.xml']) {
    const m = td.decode(files['META-INF/container.xml']).match(/full-path="([^"]+)"/);
    if (m) name = m[1];
  }
  if (!name || !files[name]) name = Object.keys(files).find(n => /\.(xml|musicxml)$/i.test(n) && !n.startsWith('META-INF'));
  if (!name) throw new Error('Keine MusicXML-Datei im Archiv');
  return td.decode(files[name]);
}
