// customers: a business's customers, with accounts of their own.
//
// `auth` says who a guest is with no account, and `staff` is for the people who run the business.
// This module is for customers who want one: an email, a name, a password, and sessions that end.
// They sign themselves up. Everything lives in the business's own log, in collections no page
// can read or write (`serverOnly` refuses them, reads included):
//
//   customers/<id>             { email, name, hash, disabled, at }
//   customer-sessions/<hash>   { customer, until, ended }     the session id itself is never stored
//   customer-tokens/<hash>     { customer, until, used }      one-time password reset links
//
//   const customers = createCustomers({ store, secure: production });
//   await customers.signUp({ email, name, password })   → { ok, customer, cookie } | { error }
//   await customers.signIn(email, password, { client }) → { ok, customer, cookie } | { error: 'wrong' | 'locked' }
//   customers.session(req)                              → { customer, name, email } | null
//
// A customer's own records (orders, bookings) stay in the app's collections, keyed by `customer`.
import { PRODUCTION } from '../auth/index.js';
import { createHash, randomBytes } from 'node:crypto';
import { checkPassword, hashPassword } from '../staff/index.js';

export const CUSTOMER_COLLECTIONS = Object.freeze(['customers', 'customer-sessions', 'customer-tokens']);

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const cleanEmail = (email) => String(email ?? '').trim().toLowerCase();
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

export function createCustomers({
  store,
  name = 'account',
  secure = PRODUCTION,
  sessionMs = 30 * 86_400_000,
  tokenMs = 3_600_000,
  tries = 5,
  emailTries = 100,
  lockMs = 15 * 60_000,
  minPassword = 10,
  cost = { N: 2 ** 15, r: 8, p: 1 },
  now = Date.now,
} = {}) {
  if (!store) throw new TypeError('createCustomers needs a store');
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new TypeError('The cookie name may hold letters, digits, - and _');
  const cookieName = secure ? `__Host-${name}` : name;
  const decoy = hashPassword(token(), cost);
  const failures = new Map();
  const byEmailFailures = new Map();
  const live = (entry) => (entry && entry.until > now() ? entry : null);
  function count(map, key) {
    const counted = (live(map.get(key))?.count ?? 0) + 1;
    if (map.size >= 10_000) for (const [k, entry] of map) if (entry.until <= now()) map.delete(k);
    map.set(key, { count: counted, until: now() + lockMs });
    return counted;
  }

  const all = () => store.under('customers');
  const byEmail = (email) => all().find((one) => one.email === email) ?? null;
  const view = (one) => (one ? { customer: one.key, name: one.name, email: one.email, disabled: Boolean(one.disabled), at: one.at } : null);

  function passwordProblem(password, email) {
    if (typeof password !== 'string' || password.length < minPassword) return `Use at least ${minPassword} characters.`;
    if (password.length > 200) return 'Use at most 200 characters.';
    if (cleanEmail(password) === email) return 'Don’t use your email as your password.';
    return '';
  }

  const cookie = (id, maxAge) => `${cookieName}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;

  async function startSession(customer) {
    const id = token();
    await store.write('customer-sessions', sha256(id), { customer, until: now() + sessionMs, ended: false, at: now() });
    return cookie(id, Math.floor(sessionMs / 1000));
  }

  function readCookie(input) {
    const header = typeof input === 'string' ? input : typeof input?.headers?.get === 'function' ? (input.headers.get('cookie') ?? '') : (input?.headers?.cookie ?? '');
    const raw = header
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
    return raw && /^[A-Za-z0-9_-]{43}$/.test(raw) ? raw : null;
  }

  async function endSessions(customer) {
    let ended = 0;
    for (const session of store.under('customer-sessions')) {
      if (session.customer === customer && !session.ended && session.until > now()) {
        await store.write('customer-sessions', session.key, { ended: true });
        ended++;
      }
    }
    return ended;
  }

  return {
    cookieName,

    /** The session on a Node request, a fetch Request or a Cookie header: who it is, or null. */
    session(input) {
      const id = readCookie(input);
      if (!id) return null;
      const session = store.get('customer-sessions', sha256(id));
      if (!session || session.ended || session.until <= now()) return null;
      const one = store.get('customers', session.customer);
      if (!one || one.disabled) return null;
      return view({ key: session.customer, ...one });
    },

    /** A new account, signed in. One account per email. */
    async signUp({ email, name: given, password } = {}) {
      email = cleanEmail(email);
      const name = String(given ?? '').trim().slice(0, 80);
      if (!EMAIL.test(email)) return { error: 'Give your email address.' };
      if (!name) return { error: 'Give your name.' };
      const problem = passwordProblem(password, email);
      if (problem) return { error: problem };
      if (byEmail(email)) return { error: 'There’s already an account with that email. Sign in, or reset its password.' };
      const hash = await hashPassword(password, cost);
      if (byEmail(email)) return { error: 'There’s already an account with that email. Sign in, or reset its password.' };
      const customer = `c${now().toString(36)}${randomBytes(6).toString('hex')}`;
      await store.write('customers', customer, { email, name, hash, disabled: false, at: now() });
      return { ok: true, customer, cookie: await startSession(customer) };
    },

    /**
     * Sign in. A wrong password and an unknown email get the same answer, in about the same time.
     * After `tries` failures from one client the email is locked for that client for `lockMs`;
     * after `emailTries` from anywhere, for everyone.
     */
    async signIn(email, password, { client = '' } = {}) {
      email = cleanEmail(email);
      const pair = `${email} ${String(client).slice(0, 100)}`;
      const mine = live(failures.get(pair));
      const every = live(byEmailFailures.get(email));
      if ((mine && mine.count >= tries) || (every && every.count >= emailTries)) return { error: 'locked' };
      const one = byEmail(email);
      const ok = (await checkPassword(String(password ?? ''), one?.hash ?? (await decoy))) && Boolean(one) && !one.disabled;
      if (!ok) {
        const fromHere = count(failures, pair);
        const everywhere = count(byEmailFailures, email);
        return fromHere >= tries || everywhere >= emailTries ? { error: 'locked' } : { error: 'wrong' };
      }
      failures.delete(pair);
      return { ok: true, customer: one.key, cookie: await startSession(one.key) };
    },

    /** End the session a request carries, and the cookie that clears it. */
    async signOut(input) {
      const id = readCookie(input);
      if (id) {
        const key = sha256(id);
        if (store.get('customer-sessions', key)) await store.write('customer-sessions', key, { ended: true });
      }
      return { ok: true, cookie: cookie('', 0) };
    },

    /**
     * A one-time token for a password reset link, for the app to email. Null for an unknown or
     * turned-off email: the app should answer the same either way.
     */
    async resetToken(email) {
      const one = byEmail(cleanEmail(email));
      if (!one || one.disabled) return null;
      const raw = token();
      await store.write('customer-tokens', sha256(raw), { customer: one.key, until: now() + tokenMs, used: false, at: now() });
      return raw;
    },

    /** Whether a reset link still works, without using it. */
    peek(raw) {
      if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return false;
      const found = store.get('customer-tokens', sha256(raw));
      return Boolean(found && !found.used && found.until > now());
    },

    /** Use a reset link: a new password, every other session ended, signed in. Works once. */
    async reset(raw, password) {
      if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return { error: 'That link has expired or been used. Ask for a new one.' };
      const key = sha256(raw);
      const found = store.get('customer-tokens', key);
      const one = found ? store.get('customers', found.customer) : null;
      if (!found || found.used || found.until <= now() || !one || one.disabled) return { error: 'That link has expired or been used. Ask for a new one.' };
      const problem = passwordProblem(password, one.email);
      if (problem) return { error: problem };
      const spending = store.write('customer-tokens', key, { used: true, usedAt: now() });
      const hash = await hashPassword(password, cost);
      await spending;
      await store.write('customers', found.customer, { hash, changedAt: now() });
      await endSessions(found.customer);
      byEmailFailures.delete(one.email);
      for (const k of failures.keys()) if (k.startsWith(`${one.email} `)) failures.delete(k);
      return { ok: true, customer: found.customer, cookie: await startSession(found.customer) };
    },

    /** A customer's own name, changed by them. */
    async rename(customer, given) {
      const name = String(given ?? '').trim().slice(0, 80);
      if (!name) return { error: 'Give your name.' };
      if (!store.get('customers', customer)) return { error: 'No such customer.' };
      await store.write('customers', customer, { name });
      return { ok: true };
    },

    /** One customer, or null. */
    get: (customer) => view(store.get('customers', customer) ? { key: customer, ...store.get('customers', customer) } : null),

    /** Every customer, newest first, for the business's admin pages. */
    list: () => all().map(view).sort((a, b) => b.at - a.at),

    /** Turn an account off (or back on). Off ends its sessions; it can't sign in or reset. */
    async setDisabled(customer, disabled) {
      if (!store.get('customers', customer)) return { error: 'No such customer.' };
      await store.write('customers', customer, { disabled: Boolean(disabled) });
      if (disabled) await endSessions(customer);
      return { ok: true };
    },

    endSessions,
  };
}
