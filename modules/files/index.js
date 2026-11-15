// files: keep a file and return its address.
//
//   put({ type, body })  →  { ok: true, id } | { error: <code> }
//   get(id)              →  { type, body } | null
//
// The id is the file's own hash plus an extension, so the same picture stored twice is one file
// and an id can be cached forever. The kit decides nothing about URLs: the app serves `get(id)`
// from whatever path it likes. Disk here; R2 or S3 are the same two functions.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const IMAGES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/avif': 'avif' };
const ID = /^[0-9a-f]{64}\.[a-z0-9]{1,5}$/;

// What the image types' files start with. A file declared as one of them must be one: an HTML
// page stored as `image/png` and served back could be a page of the attacker's on the site.
const ascii = (bytes, at, text) => [...text].every((char, i) => bytes[at + i] === char.charCodeAt(0));
const SIGNATURES = {
  'image/png': (b) => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, i) => b[i] === byte),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP'),
  'image/avif': (b) => ascii(b, 4, 'ftyp') && (ascii(b, 8, 'avif') || ascii(b, 8, 'avis')),
  'image/gif': (b) => ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a'),
};

function check({ type, body } = {}, { types, maxBytes }) {
  if (!Object.hasOwn(types, type ?? '')) return { error: 'type' };
  if (!(body instanceof Uint8Array) || !body.byteLength) return { error: 'empty' };
  if (body.byteLength > maxBytes) return { error: 'too-big', maxBytes };
  if (SIGNATURES[type] && !SIGNATURES[type](body)) return { error: 'type' };
  return { id: `${createHash('sha256').update(body).digest('hex')}.${types[type]}` };
}
const typeOf = (id, types) => Object.keys(types).find((type) => types[type] === id.slice(id.lastIndexOf('.') + 1));

/** Files in memory. For tests. */
export function memoryFiles({ types = IMAGES, maxBytes = 5 * 1024 * 1024 } = {}) {
  const kept = new Map();
  return {
    async put(file) {
      const { id, ...refused } = check(file, { types, maxBytes });
      if (!id) return refused;
      kept.set(id, Buffer.from(file.body));
      return { ok: true, id };
    },
    get: async (id) => (kept.has(id) ? { type: typeOf(id, types), body: kept.get(id) } : null),
  };
}

/** Files in a folder on disk (a Railway volume, say). */
export function diskFiles(dir, { types = IMAGES, maxBytes = 5 * 1024 * 1024 } = {}) {
  mkdirSync(dir, { recursive: true });
  return {
    async put(file) {
      const { id, ...refused } = check(file, { types, maxBytes });
      if (!id) return refused;
      if (!existsSync(join(dir, id))) writeFileSync(join(dir, id), file.body);
      return { ok: true, id };
    },
    async get(id) {
      // Only ids this module made: no path can be smuggled in.
      if (!ID.test(id ?? '') || !typeOf(id, types) || !existsSync(join(dir, id))) return null;
      return { type: typeOf(id, types), body: readFileSync(join(dir, id)) };
    },
  };
}
