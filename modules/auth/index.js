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

/** A secret long enough to sign with: 32 characters (or bytes), as `randomBytes(32)` gives. */
export function checkSecret(secret, who) {
  const size = typeof secret === 'string' ? secret.length : secret?.length ?? 0;
  if (!secret || size < 32) throw new TypeError(`${who} needs a secret of at least 32 characters: one anyone could guess signs nothing (make one with \`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"\`)`);
}

// Secure cookies unless told otherwise in production; plain HTTP in development, where browsers
// would refuse them.
export const PRODUCTION = typeof process !== 'undefined' && process.env?.NODE_ENV === 'production';

export function signedCookie({ secret, name = 'session', maxAge = 30 * 86_400, secure = PRODUCTION, roles = () => [], now = Date.now } = {}) {
  checkSecret(secret, 'signedCookie');
  const mac = (value) => createHmac('sha256', secret).update(value).digest('base64url');
  const pub = (id) => createHmac('sha256', secret).update(`pub:${id}`).digest('hex').slice(0, 12);
  const who = (id) => ({ id, pub: pub(id), roles: roles(id) });

  /** The cookie's id and when it was signed (null: the older form), or null. */
  function check(cookieHeader = '') {
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
    // `<id>.<signed at>.<sig>`: when it was signed is signed too, so a cookie copied off a device
    // stops working after maxAge, whatever the browser was told. `<id>.<sig>` is the older form,
    // with no time: it still names its id (holds and orders hang on it), and `ensure` re-signs it.
    const parts = value.split('.');
    if (parts.length < 2 || parts.length > 3 || !parts[0] || !parts.at(-1)) return null;
    const signed = parts.slice(0, -1).join('.');
    const expected = Buffer.from(mac(signed));
    const given = Buffer.from(parts.at(-1));
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    const at = parts.length === 3 ? Number.parseInt(parts[1], 36) : null;
    if (at !== null && !(at <= now() && now() - at < maxAge * 1000)) return null;
    return { id: parts[0], at };
  }

  function read(cookieHeader = '') {
    const found = check(cookieHeader);
    return found && who(found.id);
  }

  /** The Set-Cookie value that signs `id` in, now. */
  const cookie = (id) => {
    const signed = `${id}.${now().toString(36)}`;
    return `${name}=${encodeURIComponent(`${signed}.${mac(signed)}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  };

  return {
    read,
    cookie,
    /** The session on a fetch-style Request (actions, sync). */
    session: (request) => read(request.headers.get('cookie') ?? ''),
    /** The session on a Node request; a newcomer gets a fresh id and a cookie through `setHeader`. */
    ensure(req, res) {
      const known = check(req.headers.cookie ?? '');
      if (known) {
        // Re-signed past half its life (or in the older form), so a visitor who keeps coming
        // keeps their id, and one who stops is signed out by maxAge.
        if (known.at === null || now() - known.at > (maxAge * 1000) / 2) res.setHeader('set-cookie', cookie(known.id));
        return who(known.id);
      }
      const id = randomBytes(12).toString('base64url');
      res.setHeader('set-cookie', cookie(id));
      return who(id);
    },
  };
}
