# Contributing

Keep changes focused and follow the development standards and security invariants in [AGENTS.md](AGENTS.md). Use English or Simplified Chinese in issues and pull requests.

## Local development

Install Node.js 22+, the pnpm version pinned in `package.json`, and Git. Install the Codex CLI if you plan to run real Codex tasks.

```sh
git clone https://github.com/Waffing/codex-deck.git
cd codex-deck
pnpm install --frozen-lockfile
pnpm dev:server
```

Run `pnpm dev:web` in a second terminal and open the Vite URL it prints. Use test workspaces and synthetic provider credentials during development.

## Checks before opening a pull request

Keep shared schemas in `packages/shared`, add startup migrations for schema changes, and cover behavior changes with focused tests. Keep production databases and credentials out of commits, fixtures, and screenshots.

Run the applicable checks from the repository root.

```sh
pnpm typecheck
pnpm build
pnpm test
```

For changes to the web console, install Playwright Chromium and run the browser checks.

```sh
pnpm --filter @codexdeck/web exec playwright-core install chromium
pnpm e2e
```

For deployment changes, check the scripts with `bash -n` and ShellCheck, then validate Compose with `docker compose --env-file deploy/.env.example -f deploy/docker-compose.yml config --quiet`. Include `--profile https` for Caddy changes. Record any checks that require a different environment.

## Pull requests

1. Open an issue first for changes that affect public APIs, deployment defaults, or the data model.
2. Fork the repository and create a branch from `main`. Use a focused Conventional Commit title, such as `fix(gateway): preserve tool-call order`.
3. Open a pull request against `main`, link the issue, and document user-visible changes, actual verification results, and any migration or permission impacts.

## Security-sensitive changes

For changes to authentication, credentials, filesystem access, preview networking, Docker privileges, or release workflows, explain the affected boundary and how the tests cover it. Report security vulnerabilities through the private process in [SECURITY.md](SECURITY.md).

