// notice: the one-line messages a page shows after a form ("Added to your order.", "That time is
// taken."), carried in the address of the page a post redirects to.
//
// Text in an address can be typed by anyone, so a link someone sends could put their own words in
// a real page's alert box ("Your password expired; call …"). The server signs each message when it
// redirects, and a page shows only a message with a good signature: anything else is dropped.
//
//   const notices = createNotices({ secret });
//   res.writeHead(303, { location: notices.sign('/order?problem=That+time+is+taken.') });
//   const { problem, done } = notices.read(url);   // '' for a message that wasn't signed here
//
// The signature covers the messages, not the path: a message the server wrote is safe to show on
// any of its pages. Escape what `read` returns, as with any text.
import { createHmac, timingSafeEqual } from 'node:crypto';

export function createNotices({ secret, keys = ['problem', 'done'], param = 'sig', max = 200 } = {}) {
  if (!secret) throw new TypeError('createNotices needs a secret');
  const mac = (url) =>
    createHmac('sha256', `notice:${secret}`)
      .update(keys.map((key) => `${key}=${url.searchParams.get(key) ?? ''}`).join('\n'))
      .digest('base64url')
      .slice(0, 22);
  const has = (url) => keys.some((key) => url.searchParams.has(key));

  return {
    /** A location with its messages signed. A location with no messages comes back as it was. */
    sign(location) {
      const url = new URL(location, 'http://notice.invalid');
      if (!has(url)) return location;
      // Long messages are cut before signing, so what the page shows is what was signed.
      for (const key of keys) if (url.searchParams.has(key)) url.searchParams.set(key, url.searchParams.get(key).slice(0, max));
      url.searchParams.delete(param);
      url.searchParams.set(param, mac(url));
      const local = `${url.pathname}${url.search}${url.hash}`;
      return url.origin === 'http://notice.invalid' ? local : `${url.origin}${local}`;
    },

    /** The messages on a page's URL, each '' unless the server signed it. */
    read(url) {
      const empty = Object.fromEntries(keys.map((key) => [key, '']));
      if (!has(url)) return empty;
      const given = Buffer.from(url.searchParams.get(param) ?? '');
      const expected = Buffer.from(mac(url));
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return empty;
      return Object.fromEntries(keys.map((key) => [key, (url.searchParams.get(key) ?? '').slice(0, max)]));
    },
  };
}
