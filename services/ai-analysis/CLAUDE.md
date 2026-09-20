# AI analysis — NestJS

An Ollama client. Structured figures in, prose out. Stateless, and optional
by rule 9 — nothing in the critical path may call it, wait on it, or fail
because it is absent.

The rules, the service table and where a new file goes are in the root
`CLAUDE.md`. Read that first; this file is only what is specific to here.

## Layout

The same feature-module layout as the gateway (`services/api-gateway/CLAUDE.md`),
minus `schemas/`: this service has no database connection and never gains one.

## Conventions

Strict mode, no `any`, no default exports. This service is the TypeScript
reference — the gateway's looser tsconfig is legacy, do not copy it here.

It receives already-computed scalars and never sees a bar (rule 7). Keeping the
input flat is what makes that structural rather than a promise.
