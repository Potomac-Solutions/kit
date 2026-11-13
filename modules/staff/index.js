// staff: the people who run a business, signed in.
//
// `auth` says who a guest is with no account. This module is for the staff side: an owner, the
// people they invite, a password each, sessions that can be ended. Everything lives in the
// business's own log (one log per business, `tenancy`), in collections only the server reads:
//
//   accounts/<id>          { email, name, roles, hash, disabled, at }
//   staff-sessions/<hash>  { account, until, ended }      the session id itself is never stored
//   staff-tokens/<hash>    { kind: 'invite' | 'reset', email, name, roles, account, until, used }
//
// On Sync, use the kit's `serverOnly` as `authorize`: it refuses these to pages entirely, reads
// included, whatever a scope says.
//
//   const staff = createStaff({ store, secure: production });
//   staff.session(req)                      → { account, name, email, roles } | null
//   await staff.signIn(email, password)     → { ok, cookie } | { error: 'wrong' | 'locked' }
//   staff.can(who, 'staff')                 → an owner can do everything
//
// The first owner comes from a setup link (`setup()`), which works only while the business has
// no accounts. After that, an owner invites people (`invite`) and resets passwords (`resetLink`).
// Links carry a one-time token; only its hash is stored.
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { SECRET } from '../store/index.js';

/** The collections this module keeps. `serverOnly` refuses them to pages, reads included. */
export const STAFF_COLLECTIONS = SECRET;
export const OWNER = 'owner';

const DAY = 86_400_000;
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const cleanEmail = (email) => String(email ?? '').trim().toLowerCase();
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

function scrypt(password, salt, { N, r, p }) {
  return new Promise((resolve, reject) =>
    scryptCallback(password.normalize('NFKC'), salt, 32, { N, r, p, maxmem: 256 * N * r }, (error, key) => (error ? reject(error) : resolve(key))),
  );
}

/** A password hash: `scrypt$N$r$p$salt$key`, the cost kept with it so it can be raised later. */
export async function hashPassword(password, cost = { N: 2 ** 15, r: 8, p: 1 }) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, cost);
  return `scrypt$${cost.N}$${cost.r}$${cost.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** Whether `password` matches a hash from `hashPassword`, in constant time. */
export async function checkPassword(password, stored) {
  const [kind, N, r, p, salt, key] = String(stored ?? '').split('$');
  if (kind !== 'scrypt' || !key) return false;
  const expected = Buffer.from(key, 'base64url');
  const actual = await scrypt(password, Buffer.from(salt, 'base64url'), { N: Number(N), r: Number(r), p: Number(p) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createStaff({
  store,
  roles = [OWNER, 'staff'],
  name = 'staff',
  secure = false,
  sessionMs = 12 * 3_600_000,
  tokenMs = 7 * DAY,
  setupMs = DAY,
  // Failed sign-ins before an email is locked, and for how long.
  tries = 5,
  lockMs = 15 * 60_000,
  minPassword = 10,
  cost = { N: 2 ** 15, r: 8, p: 1 },
  now = Date.now,
} = {}) {
  if (!store) throw new TypeError('createStaff needs a store');
  if (!roles.includes(OWNER)) throw new TypeError(`createStaff's roles must include "${OWNER}"`);
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new TypeError('The cookie name may hold letters, digits, - and _');
  // `__Host-` binds the cookie to this host, https and path / (browsers enforce it).
  const cookieName = secure ? `__Host-${name}` : name;
  // Unknown emails are checked against this, so they take as long as known ones.
  const decoy = hashPassword(token(), cost);
  const failures = new Map(); // email → { count, until }

  const accounts = () => store.under('accounts');
  const byEmail = (email) => accounts().find((account) => account.email === email) ?? null;
  const owners = () => accounts().filter((account) => !account.disabled && account.roles.includes(OWNER));
  const view = (account) => (account ? { account: account.key, name: account.name, email: account.email, roles: [...account.roles], disabled: Boolean(account.disabled) } : null);
  const validRoles = (list) => Array.isArray(list) && list.length > 0 && list.every((role) => roles.includes(role));

  function passwordProblem(password, email) {
    if (typeof password !== 'string' || password.length < minPassword) return `Use at least ${minPassword} characters.`;
    if (password.length > 200) return 'Use at most 200 characters.';
    if (cleanEmail(password) === email) return 'Don’t use your email as your password.';
    return '';
  }

  const cookie = (id, maxAge) => `${cookieName}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;

  /** A new session for an account: a fresh id every time, so a session can't be planted. */
  async function startSession(account) {
    const id = token();
    await store.write('staff-sessions', sha256(id), { account, until: now() + sessionMs, ended: false, at: now() });
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

  function sessionFor(input) {
    const id = readCookie(input);
    if (!id) return null;
    const key = sha256(id);
    const session = store.get('staff-sessions', key);
    if (!session || session.ended || session.until <= now()) return null;
    const account = store.get('accounts', session.account);
    if (!account || account.disabled) return null;
    return { ...view({ key: session.account, ...account }), session: key };
  }

  /** An unused, unexpired token of a kind, or null. */
  function tokenFor(raw, kind) {
    if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return null;
    const key = sha256(raw);
    const found = store.get('staff-tokens', key);
    return found && found.kind === kind && !found.used && found.until > now() ? { key, ...found } : null;
  }

  async function issue(kind, fields, ms) {
    const raw = token();
    await store.write('staff-tokens', sha256(raw), { kind, ...fields, until: now() + ms, used: false, at: now() });
    return raw;
  }

  const isOwner = (who) => Boolean(who && !who.disabled && who.roles?.includes(OWNER));
  const fresh = (who) => (who?.account ? view({ key: who.account, ...store.get('accounts', who.account) }) : null);

  return {
    cookieName,
    roles: [...roles],

    /** How many emails the lockout is counting failures for (for monitoring a flood). */
    remembered: () => failures.size,

    /** Whether the business has nobody yet: the setup link is offered only then. */
    needsOwner: () => accounts().length === 0,

    /** A one-time link token for the first owner. Null once anyone has an account. */
    async setup() {
      if (accounts().length) return null;
      return issue('invite', { email: '', name: '', roles: [OWNER], account: '' }, setupMs);
    },

    /** The session on a Node request, a fetch Request or a Cookie header: who it is, or null. */
    session: sessionFor,

    /** Whether someone may act as `role`. An owner may act as anyone. */
    can(who, role) {
      return Boolean(who && !who.disabled && (who.roles.includes(OWNER) || who.roles.includes(role)));
    },

    /**
     * Sign in. A wrong password and an unknown email get the same answer, in about the same time.
     * After `tries` failures an email is locked for `lockMs`, right password or not.
     */
    async signIn(email, password) {
      email = cleanEmail(email);
      const failed = failures.get(email);
      if (failed && failed.until > now() && failed.count >= tries) return { error: 'locked', until: failed.until };
      const account = byEmail(email);
      const ok = (await checkPassword(String(password ?? ''), account?.hash ?? (await decoy))) && Boolean(account) && !account.disabled;
      if (!ok) {
        const count = failed && failed.until > now() ? failed.count + 1 : 1;
        // Made-up emails would grow this forever: past a size, forget the ones whose time is up.
        if (failures.size >= 10_000) for (const [key, entry] of failures) if (entry.until <= now()) failures.delete(key);
        failures.set(email, { count, until: now() + lockMs });
        return count >= tries ? { error: 'locked', until: now() + lockMs } : { error: 'wrong' };
      }
      failures.delete(email);
      return { ok: true, account: account.key, cookie: await startSession(account.key) };
    },

    /** End the session a request carries, and the cookie that clears it from the browser. */
    async signOut(input) {
      const id = readCookie(input);
      if (id) {
        const key = sha256(id);
        if (store.get('staff-sessions', key)) await store.write('staff-sessions', key, { ended: true });
      }
      return { ok: true, cookie: cookie('', 0) };
    },

    /** What a link is for, without using it: `{ kind, email, name }`, or null if it's spent or old. */
    peek(raw) {
      const found = tokenFor(raw, 'invite') ?? tokenFor(raw, 'reset');
      if (!found) return null;
      const account = found.account ? store.get('accounts', found.account) : null;
      return { kind: found.kind, email: account?.email ?? found.email, name: account?.name ?? found.name, setup: found.kind === 'invite' && !found.email };
    },

    /**
     * Use a link: an invite makes the account (the setup link also asks for the email), a reset
     * sets a new password. Either way the person is signed in, and every other session of a reset
     * account ends. A link works once.
     */
    async accept(raw, form = {}) {
      const found = tokenFor(raw, 'invite') ?? tokenFor(raw, 'reset');
      if (!found) return { error: 'That link has expired or been used. Ask for a new one.' };
      const existing = found.account ? store.get('accounts', found.account) : null;
      const email = found.kind === 'reset' ? existing?.email : found.email || cleanEmail(form.email);
      const name = found.kind === 'reset' ? existing?.name : String(form.name ?? found.name ?? '').trim().slice(0, 80);
      if (found.kind === 'reset' && (!existing || existing.disabled)) return { error: 'That link has expired or been used. Ask for a new one.' };
      if (found.kind === 'invite') {
        if (!EMAIL.test(email)) return { error: 'Give your email address.' };
        if (!name) return { error: 'Give your name.' };
        if (byEmail(email)) return { error: 'Someone already has an account with that email.' };
        // The setup link is for the first owner only.
        if (!found.email && accounts().length) return { error: 'That link has expired or been used. Ask for a new one.' };
      }
      const problem = passwordProblem(form.password, email);
      if (problem) return { error: problem };
      // Spent before anything is awaited: the same link used twice at once makes one account.
      const spending = store.write('staff-tokens', found.key, { used: true, usedAt: now() });
      const hash = await hashPassword(form.password, cost);
      await spending;
      let account = found.account;
      if (found.kind === 'invite') {
        // Again after hashing, with nothing awaited before the write: two links accepted at once
        // can't make two accounts for one email, or two first owners.
        if (byEmail(email)) return { error: 'Someone already has an account with that email.' };
        if (!found.email && accounts().length) return { error: 'That link has expired or been used. Ask for a new one.' };
        account = `a${now().toString(36)}${randomBytes(6).toString('hex')}`;
        await store.write('accounts', account, { email, name, roles: [...found.roles], hash, disabled: false, at: now() });
      } else {
        await store.write('accounts', account, { hash, changedAt: now() });
        await this.endSessions(account);
      }
      failures.delete(email);
      return { ok: true, account, cookie: await startSession(account) };
    },

    // ---- An owner's tools: each takes `by`, the owner's session -------------------------------

    /** Every account, for the owner's staff page. */
    list: () => accounts().map(view).sort((a, b) => a.name.localeCompare(b.name)),

    /** Invite someone by email, with their roles: a link token to send them. */
    async invite(by, { email, name = '', roles: given = ['staff'] } = {}) {
      if (!isOwner(fresh(by))) return { error: 'Only an owner can invite people.' };
      email = cleanEmail(email);
      if (!EMAIL.test(email)) return { error: 'Give their email address.' };
      if (!validRoles(given)) return { error: 'Choose what they can do.' };
      if (byEmail(email)) return { error: 'Someone already has an account with that email.' };
      return { ok: true, token: await issue('invite', { email, name: String(name).trim().slice(0, 80), roles: [...given], account: '' }, tokenMs) };
    },

    /** A one-time link to set a new password, for an owner to send someone who forgot theirs. */
    async resetLink(by, account) {
      if (!isOwner(fresh(by))) return { error: 'Only an owner can do that.' };
      const found = store.get('accounts', account);
      if (!found || found.disabled) return { error: 'That isn’t one of your staff.' };
      return { ok: true, token: await issue('reset', { email: '', name: '', roles: [], account }, tokenMs) };
    },

    /** Change what someone can do. The last owner stays an owner. */
    async setRoles(by, account, given) {
      if (!isOwner(fresh(by))) return { error: 'Only an owner can do that.' };
      const found = store.get('accounts', account);
      if (!found) return { error: 'That isn’t one of your staff.' };
      if (!validRoles(given)) return { error: 'Choose what they can do.' };
      if (found.roles.includes(OWNER) && !given.includes(OWNER) && !found.disabled && owners().length <= 1) return { error: 'The business needs an owner. Make someone else an owner first.' };
      await store.write('accounts', account, { roles: [...given] });
      return { ok: true };
    },

    /** Turn someone's account off (their sessions end at once), or back on. The last owner stays. */
    async setDisabled(by, account, disabled) {
      if (!isOwner(fresh(by))) return { error: 'Only an owner can do that.' };
      const found = store.get('accounts', account);
      if (!found) return { error: 'That isn’t one of your staff.' };
      if (disabled && found.roles.includes(OWNER) && !found.disabled && owners().length <= 1) return { error: 'The business needs an owner. Make someone else an owner first.' };
      await store.write('accounts', account, { disabled: Boolean(disabled) });
      if (disabled) await this.endSessions(account);
      return { ok: true };
    },

    /** End every session of an account (a lost phone, a password reset). */
    async endSessions(account) {
      const open = store.under('staff-sessions').filter((session) => session.account === account && !session.ended);
      await Promise.all(open.map((session) => store.write('staff-sessions', session.key, { ended: true })));
      return open.length;
    },

    /** A signed-in person changes their own password: needs the current one; ends their other sessions. */
    async changePassword(who, current, next) {
      const account = who?.account && store.get('accounts', who.account);
      if (!account || account.disabled) return { error: 'Sign in again.' };
      if (!(await checkPassword(String(current ?? ''), account.hash))) return { error: 'Your current password isn’t right.' };
      const problem = passwordProblem(next, account.email);
      if (problem) return { error: problem };
      await store.write('accounts', who.account, { hash: await hashPassword(next, cost), changedAt: now() });
      const others = store.under('staff-sessions').filter((session) => session.account === who.account && !session.ended && session.key !== who.session);
      await Promise.all(others.map((session) => store.write('staff-sessions', session.key, { ended: true })));
      return { ok: true };
    },
  };
}
