# Kit

Shared server modules for Potomac Solutions' platforms (Tailgate, CineStack, Outfitter and the rest). Built on [Zubra](https://github.com/journey-to-code-org/zubra): `@zubra/server`, `@zubra/actions`, `@zubra/sync` and Zubra UI.

Private. The name is a placeholder.

## What belongs here

Code that knows what a business is: a tenant, a hold, an order moving through stages, a price rule. None of that belongs in Zubra, which compiles components and knows nothing about bookings.

```
Platforms   apps: pages, components, seed data, one business's rules
Kit         this repository
Zubra UI    components any app would want unchanged
Siblings    @zubra/server · @zubra/actions · @zubra/sync
Core        compiler · runtime
```

Each layer imports only from the layers below it.

## Rules

1. **One job.** A module's job fits in one sentence with no "and". If it needs an "and", it is two modules.
2. **Extracted, never designed ahead.** A module arrives here when a second app needs it unchanged. Until then it lives in the app that wrote it, in its own file, free of that app's nouns (no "seat", "film" or "farm" in a hold module).
3. **Borrow the hard part.** Payments, login, text messages and file storage sit behind a small interface with one reference implementation. The kit does not own the engine.
4. **Nothing leaks downward.** If a module needs Zubra to change, the change must make sense to someone who has never heard of this repository.
5. **A module ships its own admin components.** The app arranges them.

## Modules

None extracted yet.

| Module | Its one job | First home | Extract when |
| --- | --- | --- | --- |
| `tenant` | Say which business a request is for | CineStack | Outfitter starts |
| `hold` | Reserve one contested thing for a window of time | CineStack | Outfitter starts |
| `price` | Turn an item and a context into a price | CineStack | Outfitter starts |
| `pay` | Collect money for an order | CineStack | Outfitter starts |
| `auth` | Say who is asking | Outfitter | Before any contract |
| `stages` | Move a record through named steps | Tailgate | Work Ticket starts |
| `notify` | Tell a person something | Work Ticket | A second app sends a notice |
| `files` | Keep a file and return its address | Work Ticket | Showroom starts |
| `catalog` | List what is for sale | Tailgate | Counter starts |
| `forms` | Turn a form definition into a stored answer | Outfitter | Front Desk starts |

## Layout, once there is something to lay out

```
modules/<name>/
  index.js        the interface, and nothing else exported
  README.md       the one sentence, the interface, what it borrows
  test/
  components/     admin and guest .zb components, if any
```

One package, one version, until a module needs its own.

## Plan

`plan/roadmap-ecosystem.md` and `plan/roadmap-verticals.md` in the Zubra planning project.
