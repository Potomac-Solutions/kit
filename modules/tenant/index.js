// tenant: say which business a request is for.
//
// One deployment can serve many businesses. Each is a row the app loads from wherever it keeps
// them:
//
//   { id, name, hosts: ['garrett8.example', ...], theme: { '--primary': '#7a1f1f' }, modules: ['hold', 'pay'] }
//
// The answer comes from the request's host name and nothing else: a business can't be chosen by
// a query string, a cookie or a form field.

const hostOf = (input) => {
  let host = '';
  if (typeof input === 'string') host = input;
  else if (typeof input?.headers?.get === 'function') host = input.headers.get('host') ?? new URL(input.url).host;
  else host = input?.headers?.host ?? '';
  return host.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '').replace(/^www\./, '');
};

export function createTenants({ tenants, fallback = '' } = {}) {
  if (!Array.isArray(tenants) || !tenants.length) throw new TypeError('createTenants needs a list of tenants');
  const byId = new Map();
  const byHost = new Map();
  for (const tenant of tenants) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(tenant.id ?? '')) throw new TypeError(`Tenant id ${JSON.stringify(tenant.id)} must be lower-case letters, digits and hyphens`);
    if (byId.has(tenant.id)) throw new TypeError(`Two tenants are called ${tenant.id}`);
    byId.set(tenant.id, tenant);
    for (const host of tenant.hosts ?? []) {
      const name = hostOf(host);
      if (byHost.has(name)) throw new TypeError(`${name} is listed for both ${byHost.get(name).id} and ${tenant.id}`);
      byHost.set(name, tenant);
    }
  }
  if (fallback && !byId.has(fallback)) throw new TypeError(`The fallback tenant ${fallback} is not in the list`);

  return {
    all: () => [...byId.values()],
    get: (id) => byId.get(id) ?? null,
    /** The business for a host name, a fetch Request or a Node request. Null when nobody answers to it. */
    for: (input) => byHost.get(hostOf(input)) ?? (fallback ? byId.get(fallback) : null),
    /** Whether a business has a module switched on. */
    has: (tenant, module) => (tenant?.modules ?? []).includes(module),
  };
}

const TOKEN = /^--[a-z0-9-]+$/;
// A value may hold what a colour, length or font list holds. Nothing that could close the rule.
const VALUE = /^[^;{}<>\\]*$/;

/** A business's theme as one CSS rule. Token names and values that could break out are refused. */
export function themeCss(tenant, selector = ':root') {
  const lines = [];
  for (const [name, value] of Object.entries(tenant?.theme ?? {})) {
    if (!TOKEN.test(name) || typeof value !== 'string' || !value.trim() || !VALUE.test(value) || /url\s*\(/i.test(value)) {
      throw new TypeError(`Theme token ${JSON.stringify(name)} of ${tenant.id} is not a safe CSS custom property`);
    }
    lines.push(`  ${name}: ${value.trim()};`);
  }
  return lines.length ? `${selector} {\n${lines.join('\n')}\n}\n` : '';
}
