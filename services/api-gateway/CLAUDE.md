# API gateway — NestJS

Auth, REST, the only Mongo writer, and the Redis-to-WebSocket relay. The
only service a browser talks to.

The rules, the service table and where a new file goes are in the root
`CLAUDE.md`. Read that first; this file is only what is specific to here.

## Layout

Feature-module layout. One folder per domain area, flat, no nesting by layer.

```
src/
  main.ts                     bootstrap only
  app.module.ts               wires feature modules together
  config/configuration.ts     every env var read here, nowhere else
  common/                     guards, interceptors, pipes, crypto. No domain logic.
  schemas/                    Mongoose models — the single definition of each document
  <feature>/                  auth/ accounts/ backtest/ mt5/ users/
    <feature>.module.ts
    <feature>.controller.ts   validates and delegates. No logic.
    <feature>.service.ts      the logic
    <feature>.client.ts       outbound HTTP to another service
    dto.ts                    request/response shapes for this feature
  health/
```

`schemas/` exists only in `api-gateway` — it is the only Mongo writer. `ai-analysis` has
no `schemas/` and no database connection.

## Conventions

**TypeScript.** Strict mode, no `any`. NestJS modules stay thin — a controller validates and
delegates, a service holds the logic. Shapes crossing a boundary come from
`packages/contracts`; never redeclare one locally. No default exports.

`api-gateway` predates this and still runs with `strictNullChecks: false` and
`noImplicitAny: false`. That is legacy, not the standard — tighten it when you are already
in the file, and do not copy its tsconfig into a new service. `ai-analysis` is the
reference.

