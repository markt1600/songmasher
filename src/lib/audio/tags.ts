/**
 * Title and artist from a file's own metadata: ID3v2 (MP3), ID3v1, FLAC Vorbis comments and MP4/M4A
 * atoms. Enough for the advisor to recognise a song; anything else is ignored.
 */
export interface AudioTags {
  title?: string;
  artist?: string;
  album?: string;
}

const clean = (s: string | undefined): string | undefined => {
  const t = s?.replace(/\0+$/g, "").trim();
  return t ? t.slice(0, 200) : undefined;
};

function decodeText(bytes: Uint8Array, encoding: number): string {
  try {
    if (encoding === 1) {
      // UTF-16 with BOM
      const bom = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-16le";
      return new TextDecoder(bom).decode(bytes.subarray(bytes.length >= 2 && (bytes[0] === 0xff || bytes[0] === 0xfe) ? 2 : 0));
    }
    if (encoding === 2) return new TextDecoder("utf-16be").decode(bytes);
    if (encoding === 3) return new TextDecoder("utf-8").decode(bytes);
    return new TextDecoder("latin1").decode(bytes);
  } catch {
    return "";
  }
}

function syncsafe(b: Uint8Array, i: number): number {
  return ((b[i] & 0x7f) << 21) | ((b[i + 1] & 0x7f) << 14) | ((b[i + 2] & 0x7f) << 7) | (b[i + 3] & 0x7f);
}

function id3v2(b: Uint8Array): AudioTags | null {
  if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return null;
  const major = b[3];
  const flags = b[5];
  const size = syncsafe(b, 6);
  let p = 10;
  if (flags & 0x40) p += major >= 4 ? syncsafe(b, 10) : ((b[10] << 24) | (b[11] << 16) | (b[12] << 8) | b[13]) + 4; // extended header
  const end = Math.min(b.length, 10 + size);
  const out: AudioTags = {};
  const want: Record<string, keyof AudioTags> = { TIT2: "title", TPE1: "artist", TALB: "album", TT2: "title", TP1: "artist", TAL: "album" };
  while (p + (major >= 3 ? 10 : 6) <= end) {
    let id: string;
    let len: number;
    let hdr: number;
    if (major >= 3) {
      id = String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
      len = major >= 4 ? syncsafe(b, p + 4) : (b[p + 4] << 24) | (b[p + 5] << 16) | (b[p + 6] << 8) | b[p + 7];
      hdr = 10;
    } else {
      id = String.fromCharCode(b[p], b[p + 1], b[p + 2]);
      len = (b[p + 3] << 16) | (b[p + 4] << 8) | b[p + 5];
      hdr = 6;
    }
    if (!/^[A-Z0-9]{3,4}$/.test(id) || len <= 0 || p + hdr + len > end) break;
    const key = want[id];
    if (key && !out[key]) {
      const body = b.subarray(p + hdr, p + hdr + len);
      out[key] = clean(decodeText(body.subarray(1), body[0]));
    }
    p += hdr + len;
    if (out.title && out.artist && out.album) break;
  }
  return out.title || out.artist ? out : null;
}

function id3v1(b: Uint8Array): AudioTags | null {
  if (b.length < 128) return null;
  const t = b.subarray(b.length - 128);
  if (t[0] !== 0x54 || t[1] !== 0x41 || t[2] !== 0x47) return null;
  const s = (a: number, n: number) => clean(new TextDecoder("latin1").decode(t.subarray(a, a + n)));
  const out = { title: s(3, 30), artist: s(33, 30), album: s(63, 30) };
  return out.title || out.artist ? out : null;
}

function flac(b: Uint8Array): AudioTags | null {
  if (b.length < 8 || b[0] !== 0x66 || b[1] !== 0x4c || b[2] !== 0x61 || b[3] !== 0x43) return null;
  let p = 4;
  const out: AudioTags = {};
  for (let guard = 0; guard < 64 && p + 4 <= b.length; guard++) {
    const last = (b[p] & 0x80) !== 0;
    const type = b[p] & 0x7f;
    const len = (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
    p += 4;
    if (type === 4 && p + len <= b.length) {
      const v = b.subarray(p, p + len);
      const dv = new DataView(v.buffer, v.byteOffset, v.byteLength);
      let q = 0;
      const vendorLen = dv.getUint32(q, true);
      q += 4 + vendorLen;
      const count = dv.getUint32(q, true);
      q += 4;
      for (let i = 0; i < count && q + 4 <= v.length; i++) {
        const l = dv.getUint32(q, true);
        q += 4;
        const entry = new TextDecoder("utf-8").decode(v.subarray(q, q + l));
        q += l;
        const eq = entry.indexOf("=");
        if (eq < 0) continue;
        const k = entry.slice(0, eq).toUpperCase();
        const val = clean(entry.slice(eq + 1));
        if (k === "TITLE" && !out.title) out.title = val;
        else if (k === "ARTIST" && !out.artist) out.artist = val;
        else if (k === "ALBUM" && !out.album) out.album = val;
      }
      break;
    }
    p += len;
    if (last) break;
  }
  return out.title || out.artist ? out : null;
}

function mp4(b: Uint8Array): AudioTags | null {
  // Loose scan of the leading bytes for the iTunes-style atoms ©nam / ©ART / ©alb followed by a `data` box.
  if (b.length < 12 || String.fromCharCode(b[4], b[5], b[6], b[7]) !== "ftyp") return null;
  const out: AudioTags = {};
  const names: [string, keyof AudioTags][] = [
    ["\xa9nam", "title"],
    ["\xa9ART", "artist"],
    ["\xa9alb", "album"],
  ];
  const limit = Math.min(b.length, 4 * 1024 * 1024);
  for (let i = 4; i + 8 < limit; i++) {
    for (const [atom, key] of names) {
      if (out[key]) continue;
      if (b[i] === 0xa9 && b[i + 1] === atom.charCodeAt(1) && b[i + 2] === atom.charCodeAt(2) && b[i + 3] === atom.charCodeAt(3)) {
        // the child `data` box: size(4) 'data'(4) type(4) locale(4) payload
        const d = i + 4;
        if (String.fromCharCode(b[d + 4], b[d + 5], b[d + 6], b[d + 7]) === "data") {
          const size = (b[d] << 24) | (b[d + 1] << 16) | (b[d + 2] << 8) | b[d + 3];
          const payload = b.subarray(d + 16, d + size);
          out[key] = clean(new TextDecoder("utf-8").decode(payload));
        }
      }
    }
    if (out.title && out.artist && out.album) break;
  }
  return out.title || out.artist ? out : null;
}

/** Title/artist/album from the file bytes, or null when the file carries none. */
export function readAudioTags(data: ArrayBuffer): AudioTags | null {
  const b = new Uint8Array(data);
  try {
    return id3v2(b) ?? flac(b) ?? mp4(b) ?? id3v1(b);
  } catch {
    return null;
  }
}

/** A sensible title/artist guess from a file name alone: "03 - Artist - Title (Official Video)" and friends. */
export function guessFromName(name: string): AudioTags {
  let s = name
    .replace(/\.[a-z0-9]{2,5}$/i, "") // a real extension only ("01. 7 Years" keeps its title)
    .replace(/[_]+/g, " ")
    .replace(/^\s*(\d{1,2}\s*[.\-–]\s*|\d{2}\s+(?:[-–]\s*)?)+/, "") // track numbers: "01 ", "3. ", "03 - " (a title like "7 Years" survives)
    .replace(/\s*[([{](official|lyric|audio|video|hd|hq|4k|remaster(ed)?|explicit|clean|mv|visualizer|music video)[^)\]}]*[)\]}]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  s = s.replace(/\s*[-–—]\s*(official|lyric|audio|video)\s*(video|audio)?$/i, "").trim();
  const parts = s.split(/\s+[-–—]\s+/);
  if (parts.length >= 2 && parts[0].length <= 60) return { artist: clean(parts[0]), title: clean(parts.slice(1).join(" - ")) };
  return { title: clean(s) };
}
