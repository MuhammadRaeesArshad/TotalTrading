# Meridian — React + Vite

The UI. It talks to the gateway and to nothing else.

The rules, the service table and where a new file goes are in the root
`CLAUDE.md`. Read that first; this file is only what is specific to here.

## Layout

```
src/
  main.tsx                    entry
  App.tsx                     router
  features/<feature>/         one folder per domain area
    components/               UI used only by this feature
    hooks/                    useBacktests.ts
    api.ts                    calls the gateway, typed from @totaltrading/contracts
    store.ts                  state local to this feature
  components/                 shared and dumb — no feature knowledge
    charts/                   EquityCurve, RMultipleHistogram, Sparkline, Heatmap
    ui/                       Button, Modal, PageHeader
  pages/                      route-level. Composes features, holds no logic and fetches nothing.
  lib/                        cross-cutting: api client, auth, ws, format
  stores/                     global state only — auth, connection status
  styles/
```

A component used by one feature lives in that feature; promote it to `components/` on its
second consumer, not in anticipation of one. Global state is React context in `stores/`;
there is no state library, and adding one is a decision to bring to me.

## Conventions

**TypeScript.** Strict mode, no `any`. NestJS modules stay thin — a controller validates and
delegates, a service holds the logic. Shapes crossing a boundary come from
`packages/contracts`; never redeclare one locally. No default exports.

`api-gateway` predates this and still runs with `strictNullChecks: false` and
`noImplicitAny: false`. That is legacy, not the standard — tighten it when you are already
in the file, and do not copy its tsconfig into a new service. `ai-analysis` is the
reference.


The web app has no test framework. Its pure logic (`features/*/stats.ts`) is written in
erasable TypeScript with no imports beyond types, and checked by `apps/web/checks/*.check.ts`
under plain `node` (22.6+ strips types). Keep it that way rather than adding a framework.
