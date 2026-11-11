// notify: tell a person something.
//
// The kit does not send texts or email. A sender does, behind one function:
//
//   send({ channel: 'sms' | 'email', to, subject, body })  →  { ok: true } | { error: <reason> }
//
// The kit owns the templates: a name, and a function from data to the words.
//
//   templates: { ready: ({ name, what }) => ({ subject: 'Ready for pickup', body: `${name}, your ${what} is ready.` }) }

export function createNotify({ send, templates = {} } = {}) {
  if (typeof send !== 'function') throw new TypeError('createNotify needs a send function');
  return {
    /** Send `template` to a person: `{ sms: '+13015550100' }`, `{ email: 'a@b.example' }`, or both. */
    async notify(to, template, data = {}) {
      const write = templates[template];
      if (!write) throw new TypeError(`No template called ${template}`);
      const channels = ['sms', 'email'].filter((channel) => to?.[channel]);
      if (!channels.length) return { error: 'no-address' };
      const { subject = '', body } = write(data);
      const results = [];
      for (const channel of channels) {
        let result;
        try {
          result = await send({ channel, to: to[channel], subject, body });
        } catch (error) {
          result = { error: 'sender-failed', detail: String(error?.message ?? error) };
        }
        results.push({ channel, ...(result?.ok ? { ok: true } : { error: String(result?.error ?? 'failed') }) });
      }
      return results.some((result) => result.ok) ? { ok: true, results } : { error: 'not-sent', results };
    },
  };
}

/** A sender that keeps what it was asked to send. For tests and prototypes. */
export function outbox() {
  const sent = [];
  return { sent, send: async (message) => (sent.push(message), { ok: true }) };
}
