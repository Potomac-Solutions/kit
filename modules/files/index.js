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

function check({ type, body } = {}, { types, maxBytes }) {
  if (!Object.hasOwn(types, type ?? '')) return { error: 'type' };
  if (!(body instanceof Uint8Array) || !body.byteLength) return { error: 'empty' };
  if (body.byteLength > maxBytes) return { error: 'too-big', maxBytes };
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
