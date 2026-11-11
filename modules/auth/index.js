// auth: say who is asking.
//
// The interface the rest of an app depends on is one function:
//
//   session(request)  →  { id, pub, roles } | null
//
// `id` is private to the server. `pub` is a one-way name for it that is safe to show other people
// (it is what `hold` records as the holder). Real accounts come from a login provider behind this
// same function.
//
// `signedCookie` is the reference: a random id in a signed cookie, no account. Both Tailgate
// (src/session.js, fc0f6ae) and CineStack (src/session.js, 1c17019) had their own copy.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function signedCookie({ secret, name = 'session', maxAge = 30 * 86_400, secure = false, roles = () => [] } = {}) {
  if (!secret) throw new TypeError('signedCookie needs a secret');
  const mac = (value) => createHmac('sha256', secret).update(value).digest('base64url');
  const pub = (id) => createHmac('sha256', secret).update(`pub:${id}`).digest('hex').slice(0, 12);
  const who = (id) => ({ id, pub: pub(id), roles: roles(id) });

  function read(cookieHeader = '') {
    const raw = cookieHeader
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${name}=`))
      ?.slice(name.length + 1);
    if (!raw) return null;
    let value;
    try {
      value = decodeURIComponent(raw);
    } catch {
      return null;
    }
    const dot = value.lastIndexOf('.');
    const id = value.slice(0, dot);
    const sig = value.slice(dot + 1);
    if (dot < 1 || !sig) return null;
    const expected = Buffer.from(mac(id));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    return who(id);
  }

  /** The Set-Cookie value that signs `id` in. */
  const cookie = (id) => `${name}=${encodeURIComponent(`${id}.${mac(id)}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;

  return {
    read,
    cookie,
    /** The session on a fetch-style Request (actions, sync). */
    session: (request) => read(request.headers.get('cookie') ?? ''),
    /** The session on a Node request; a newcomer gets a fresh id and a cookie through `setHeader`. */
    ensure(req, res) {
      const known = read(req.headers.cookie ?? '');
      if (known) return known;
      const id = randomBytes(12).toString('base64url');
      res.setHeader('set-cookie', cookie(id));
      return who(id);
    },
  };
}
