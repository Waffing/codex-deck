# AGENTS.md — CodexDeck Development Standards

## Architecture & Tech Stack
- Monorepo managed by `pnpm` (`apps/server`, `apps/web`, `packages/shared`, `packages/ops-mcp`).
- Node.js 22+ with strict TypeScript (`"strict": true`, ESM modules).
- Backend: Fastify 5 + WebSocket + Drizzle ORM + `better-sqlite3` + Zod validation.
- Frontend: React 19 + Vite + Tailwind CSS + shadcn/ui + Zustand.
- Tests: Vitest for unit/integration tests. Never mock away the core behavior under test.

## Non-Negotiable Security Invariants
1. **API Key Isolation**: Real third-party API keys must NEVER be logged, returned in API responses, written to `config.toml`, or passed into Codex child process environment variables. Store encrypted with AES-256-GCM in SQLite and inject only inside `apps/server/src/gateway`.
2. **Path Traversal Protection**: Every file operation must resolve symlinks with `fs.realpath` and verify the resolved path stays strictly inside the workspace root directory.
3. **Secret Masking**: Pass all stdout/stderr/event payloads through `SecretMasker` before persisting to `thread_events` or streaming to clients.
4. **Control Plane Safety**: Never allocate or touch system ports (22, 80, 443) or CodexDeck's own listening port in deployment/probe logic.

## Engineering Discipline
- Follow a **Plan-First** workflow: inspect existing files, outline changes briefly, implement cleanly, then run typecheck + unit/integration tests before reporting completion.
- Keep modules cohesive and strongly typed; shared DTOs and Zod schemas belong in `packages/shared`.
- Every SQLite schema change requires an idempotent migration runnable on startup.
- Do not fabricate passing tests or leave `TODO` stubs in core request paths.