// tenancy: keep each business's documents apart.
//
// One deployment, many businesses, one Sync log each (a SQLite file, a Durable Object): a
// business's pages, its sync traffic and the kit's features working for it only ever touch its
// own log. Nothing is filtered out of a shared one, so nothing can be filtered wrongly.
//
//   const tenancy = createTenancy({
//     tenants,                                                     // createTenants(...)
//     open: async (tenant) => createSyncServer({ log: await sqliteLog(`data/${tenant.id}.db`) }),
//     setup: ({ store }) => ({ catalog: createCatalog({ store }), holds: createHolds({ store }) }),
//   });
//
//   // Node: before the app's own routes.
//   if (await tenancy.handle(req, res)) return;            // /_zb/sync/* to the business's own log
//   const space = await tenancy.space(req);                // { tenant, sync, store, ...setup's }
//   if (!space) return notFound(res);                      // a host nobody answers to
//
// `open` runs once per business, the first time it's asked for (requests that arrive together
// share the one call), and `setup` once after it. The business comes from the host name only
// (`tenant`'s rule), so a request can't pick another business's log.
//
// On Durable Objects the log is the object: route each business's requests to its own object
// (`idFromName(tenant.id)`) and run the kit inside it (`roadmap-durable-objects.md`); this module
// is for a process that holds several logs.

import { syncStore } from '../store/index.js';

export function createTenancy({ tenants, open, setup = () => ({}), mount = '/_zb/sync' } = {}) {
  if (typeof tenants?.for !== 'function' || typeof tenants.get !== 'function') throw new TypeError('createTenancy needs tenants (createTenants)');
  if (typeof open !== 'function') throw new TypeError('createTenancy needs open(tenant), which returns that business\'s Sync server');
  const base = mount.replace(/\/$/, '');
  const spaces = new Map();

  /** The business's space, opened once. */
  function spaceOf(tenant) {
    if (!spaces.has(tenant.id)) {
      const opening = (async () => {
        const sync = await open(tenant);
        if (typeof sync?.documents !== 'function' || typeof sync.write !== 'function') throw new TypeError(`open(${tenant.id}) must return a Sync server`);
        const store = await syncStore(sync);
        const space = { tenant, sync, store };
        return Object.assign(space, await setup(space));
      })();
      // A failed open isn't kept, so the next request tries again.
      opening.catch(() => spaces.delete(tenant.id));
      spaces.set(tenant.id, opening);
    }
    return spaces.get(tenant.id);
  }

  const isSync = (path) => path === base || path.startsWith(`${base}/`);
  const notYours = () => new Response(JSON.stringify({ error: 'No business here' }), { status: 404, headers: { 'content-type': 'application/json' } });

  return {
    /** The space for a request or host name: `{ tenant, sync, store, ...setup's }`, or null when nobody answers to the host. */
    async space(input) {
      const tenant = tenants.for(input);
      return tenant ? spaceOf(tenant) : null;
    },

    /** The space for a business by id (a job, a webhook), or null. */
    async spaceOf(id) {
      const tenant = tenants.get(id);
      return tenant ? spaceOf(tenant) : null;
    },

    /** The businesses opened so far, by id. */
    opened: () => [...spaces.keys()],

    /** Fetch: a sync request to the business's own log; null for anything else. */
    async fetch(request) {
      if (!isSync(new URL(request.url).pathname)) return null;
      const tenant = tenants.for(request);
      if (!tenant) return notYours();
      return (await spaceOf(tenant)).sync.fetch(request);
    },

    /** Node's http: answers a sync request from the business's own log and resolves true; false for anything else. */
    async handle(req, res) {
      if (!isSync(new URL(req.url, 'http://x').pathname)) return false;
      const tenant = tenants.for(req);
      if (!tenant) {
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'No business here' }));
        return true;
      }
      return (await spaceOf(tenant)).sync.handle(req, res);
    },
  };
}
