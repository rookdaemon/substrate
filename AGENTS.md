# Substrate Agent Notes

This repository is an AI agent orchestration shell with a TypeScript server and React client.

## Start Here

- Read `CLAUDE.md` for the full project guidance and infrastructure reference.
- `GEMINI.md` contains the short shared way-of-working summary.
- Check `git status --short` before editing. The worktree may contain user changes.

## Commands

- Install dependencies: `npm install`
- Build all workspaces: `npm run build`
- Test all workspaces: `npm run test`
- Lint all workspaces: `npm run lint`
- Server dev loop: `npm run server:dev`
- Client dev loop: `npm run client:dev`

Workspace-specific commands:

- Server: `npm run build --workspace=server`, `npm run test --workspace=server`, `npm run lint --workspace=server`
- Client: `npm run build --workspace=client`, `npm run test --workspace=client`, `npm run lint --workspace=client`

## Engineering Rules

- Prefer small, test-backed changes.
- Keep CLI handlers, HTTP servers, workers, and subprocess launchers thin.
- Put business logic in services behind interfaces.
- Abstract filesystem, process, time, and environment access behind injectable interfaces.
- Do not use raw `Date.now()` or `new Date()` in business logic; inject time instead.
- Prefer service-level unit tests. Keep real process and port tests minimal and explicitly integration-only.
- Source changes under `server/src` require `npm run build --workspace=server` before they affect `server/dist`.

## Versioning

Before committing significant changes, update the relevant `package.json` version at least by patch and verify build, lint, and tests.
