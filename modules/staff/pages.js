// staff/pages: the pages and routes every platform's staff side needs, on `createStaff`.
//
//   const pages = staffPages({ staff, home: '/kitchen', business: 'Hickory Hollow Bakehouse', render });
//   // in the request handler, before the app's own staff routes:
//   if (await pages.handle(req, res, url, form)) return;   // form: the POST body (URLSearchParams), or null for a GET
//   const who = staff.session(req);
//   if (!staff.can(who, 'staff')) return render(res, 'Sign in', pages.signIn(url));
//   … the app's page, with pages.bar(who) at the top
//
// Routes (all under /staff): sign-in, sign-out, accept (a link), password, people and its posts
// (invite, reset, role, off, on). `render(res, title, body)` is the app's own page around a body;
// the HTML uses the class names the platforms' layouts share (panel, notice, ok, hint, button).
// Every form posts to the app's own origin; refuse cross-site posts before calling `handle`.

const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function staffPages({ staff, home = '/staff', business = 'the business', render, secure = false, base = '/staff' }) {
  if (typeof render !== 'function') throw new TypeError('staffPages needs render(res, title, body)');
  const at = (path) => `${base}${path}`;
  const back = (res, location) => (res.writeHead(303, { location }), res.end());
  const withWord = (path, key, words) => `${path}${path.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(words)}`;
  const note = (url) => {
    const problem = (url.searchParams.get('problem') ?? '').slice(0, 200);
    const done = (url.searchParams.get('done') ?? '').slice(0, 200);
    return `${problem ? `<p class="notice" role="alert">${escape(problem)}</p>` : ''}${done ? `<p class="ok" role="status">${escape(done)}</p>` : ''}`;
  };
  const noStore = (res) => {
    res.setHeader('cache-control', 'no-store');
    // A link token in the address must not leave in a Referer header.
    res.setHeader('referrer-policy', 'no-referrer');
  };
  const linkTo = (req, raw) => `${secure ? 'https' : 'http'}://${req.headers.host}${at('/accept')}?token=${raw}`;

  function signIn(url) {
    return `<section><h1>Staff sign-in</h1><p class="lede">For ${escape(business)}’s staff.</p></section>
${note(url)}
${staff.needsOwner() ? '<p class="bulletin">Nobody has an account here yet. The first owner’s setup link is in the server’s log.</p>' : ''}
<form class="panel" method="post" action="${at('/sign-in')}">
  <label for="f-email">Email<input id="f-email" type="email" name="email" autocomplete="username" required></label>
  <label for="f-password">Password<input id="f-password" type="password" name="password" autocomplete="current-password" required></label>
  <button type="submit">Sign in</button>
</form>
<p class="hint">Forgot your password? Ask an owner for a reset link.</p>`;
  }

  function accept(raw, problem = '') {
    const link = staff.peek(raw);
    if (!link) return `<section><h1>That link has expired</h1><p class="lede">Links work once, for a week. Ask an owner for a new one.</p></section>`;
    const reset = link.kind === 'reset';
    const heading = reset ? 'Choose a new password' : link.setup ? `Set up ${escape(business)}` : `Join ${escape(business)}`;
    const lede = link.setup ? 'You’ll be the owner: you can invite the rest of the staff.' : `For ${escape(link.email)}.`;
    return `<section><h1>${heading}</h1><p class="lede">${lede}</p></section>
${problem ? `<p class="notice" role="alert">${escape(problem)}</p>` : ''}
<form class="panel" method="post" action="${at('/accept')}">
  <input type="hidden" name="token" value="${escape(raw)}">
  ${link.setup ? '<label for="f-email">Your email<input id="f-email" type="email" name="email" autocomplete="username" required></label>' : ''}
  ${reset ? '' : `<label for="f-name">Your name<input id="f-name" name="name" value="${escape(link.name)}" autocomplete="name" maxlength="80" required></label>`}
  <label for="f-password">${reset ? 'New password' : 'Choose a password'}<span class="hint">At least 10 characters.</span><input id="f-password" type="password" name="password" autocomplete="new-password" minlength="10" required></label>
  <button type="submit">${reset ? 'Set it and sign in' : 'Make my account'}</button>
</form>`;
  }

  function people(url, who, shown = null) {
    const everyone = staff.list();
    const action = (one, path, label, extra = '') => `<form method="post" action="${at(`/people/${path}`)}"><input type="hidden" name="account" value="${escape(one.account)}">${extra}<button class="button light" type="submit">${label}</button></form>`;
    return `<section><h1>People</h1><p class="lede">Who can sign in to ${escape(business)}’s staff pages.</p></section>
${note(url)}
${shown ? `<section class="panel" role="status"><h2>${escape(shown.title)}</h2><p>Send this link to ${escape(shown.to)}. It works once, within a week.</p><p><input readonly value="${escape(shown.link)}" aria-label="The link" style="width:100%"></p></section>` : ''}
<section class="panel"><h2>Everyone</h2><table><tbody>${everyone
      .map((one) => {
        const owner = one.roles.includes('owner');
        return `<tr${one.disabled ? ' class="done"' : ''}><td><strong>${escape(one.name)}</strong>${one.account === who.account ? ' (you)' : ''}<br><small>${escape(one.email)}</small></td><td>${one.disabled ? 'Turned off' : owner ? 'Owner' : 'Staff'}</td><td class="row">${action(one, 'role', owner ? 'Make staff' : 'Make owner', `<input type="hidden" name="role" value="${owner ? 'staff' : 'owner'}">`)}${action(one, one.disabled ? 'on' : 'off', one.disabled ? 'Turn on' : 'Turn off')}${one.disabled ? '' : action(one, 'reset', 'Reset link')}</td></tr>`;
      })
      .join('')}</tbody></table></section>
<form class="panel" method="post" action="${at('/people/invite')}"><h2>Invite someone</h2>
  <label for="f-email">Their email<input id="f-email" type="email" name="email" required></label>
  <label for="f-name">Their name<input id="f-name" name="name" maxlength="80"></label>
  <label for="f-role">What they can do<select id="f-role" name="role"><option value="staff">Staff</option><option value="owner">Owner: everything, and people</option></select></label>
  <button type="submit">Make an invite link</button>
</form>`;
  }

  const password = (url) => `<section><h1>Your password</h1></section>
${note(url)}
<form class="panel" method="post" action="${at('/password')}">
  <label for="f-current">Current password<input id="f-current" type="password" name="current" autocomplete="current-password" required></label>
  <label for="f-next">New password<span class="hint">At least 10 characters. Your other devices are signed out.</span><input id="f-next" type="password" name="next" autocomplete="new-password" minlength="10" required></label>
  <button type="submit">Change it</button>
</form>`;

  /** The line at the top of a staff page: who's signed in, and their links. */
  const bar = (who) =>
    // A <div>, not a <p>: a form inside a paragraph ends it, and the sign-out button lands on a line of its own.
    `<div class="hint">Signed in as ${escape(who.name)}${staff.can(who, 'owner') ? ` · <a href="${at('/people')}">People</a>` : ''} · <a href="${at('/password')}">Your password</a> · <form class="inline" method="post" action="${at('/sign-out')}"><button class="button light" type="submit">Sign out</button></form></div>`;

  /**
   * Answer the staff account routes. True when it answered; false for anything else (the app's
   * own pages). `form` is the POST body, already read, or null for a GET.
   */
  async function handle(req, res, url, form) {
    const path = url.pathname;
    if (path !== base && !path.startsWith(`${base}/`)) return false;
    const who = staff.session(req);
    const owner = staff.can(who, 'owner');
    if (req.method === 'POST') {
      if (!form) return false;
      if (path === at('/sign-in')) {
        const done = await staff.signIn(form.get('email'), form.get('password'));
        if (done.error) return back(res, withWord(home, 'problem', done.error === 'locked' ? 'Too many tries. Wait 15 minutes, or ask an owner for a reset link.' : 'That email and password don’t match.')), true;
        res.setHeader('set-cookie', done.cookie);
        return back(res, home), true;
      }
      if (path === at('/accept')) {
        noStore(res);
        const raw = String(form.get('token') ?? '');
        const done = await staff.accept(raw, { email: form.get('email'), name: form.get('name'), password: form.get('password') });
        if (done.error) return render(res, 'Your account', accept(raw, done.error)), true;
        res.setHeader('set-cookie', done.cookie);
        return back(res, withWord(home, 'done', 'You’re signed in.')), true;
      }
      if (path === at('/sign-out')) {
        const done = await staff.signOut(req);
        res.setHeader('set-cookie', done.cookie);
        return back(res, withWord(home, 'done', 'Signed out.')), true;
      }
      if (path === at('/password')) {
        if (!who) return back(res, home), true;
        const done = await staff.changePassword(who, form.get('current'), form.get('next'));
        return back(res, done.ok ? withWord(home, 'done', 'Password changed. Your other devices are signed out.') : withWord(at('/password'), 'problem', done.error)), true;
      }
      if (path.startsWith(at('/people/'))) {
        if (!owner) return back(res, home), true;
        noStore(res);
        const account = String(form.get('account') ?? '');
        const role = form.get('role') === 'owner' ? ['owner'] : ['staff'];
        if (path === at('/people/invite')) {
          const email = String(form.get('email') ?? '');
          const done = await staff.invite(who, { email, name: form.get('name') ?? '', roles: role });
          if (done.error) return back(res, withWord(at('/people'), 'problem', done.error)), true;
          return render(res, 'People', people(url, who, { title: 'Invite link', to: email.trim(), link: linkTo(req, done.token) })), true;
        }
        if (path === at('/people/reset')) {
          const done = await staff.resetLink(who, account);
          if (done.error) return back(res, withWord(at('/people'), 'problem', done.error)), true;
          const person = staff.list().find((one) => one.account === account);
          return render(res, 'People', people(url, who, { title: 'Reset link', to: person.name, link: linkTo(req, done.token) })), true;
        }
        const done =
          path === at('/people/role') ? await staff.setRoles(who, account, role) : path === at('/people/off') ? await staff.setDisabled(who, account, true) : path === at('/people/on') ? await staff.setDisabled(who, account, false) : null;
        if (!done) return false;
        return back(res, done.ok ? withWord(at('/people'), 'done', 'Done.') : withWord(at('/people'), 'problem', done.error)), true;
      }
      return false;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    if (path === at('/accept')) {
      noStore(res);
      return render(res, 'Your account', accept(url.searchParams.get('token') ?? '')), true;
    }
    if (path === at('/password')) {
      if (!who) return back(res, home), true;
      noStore(res);
      return render(res, 'Your password', password(url)), true;
    }
    if (path === at('/people')) {
      if (!owner) return back(res, home), true;
      noStore(res);
      return render(res, 'People', people(url, who)), true;
    }
    if (path === base && home !== base) return back(res, home), true;
    return false;
  }

  return { handle, signIn, bar, noStore };
}
