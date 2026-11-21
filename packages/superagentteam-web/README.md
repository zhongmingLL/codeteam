# @superagentteam/web

F020 W7b thin Hub M0. The primary UI for local A2A chat; it consumes the daemon
headless API and never imports daemon stores or reads SQLite.

## Development

From the repo root:

```bash
NODE_ENV=development npm install --ignore-scripts
npm run dev --workspace @superagentteam/web
```

The Vite dev server runs on `http://localhost:3000` and proxies `/api` and
`/auth/console` to the daemon at `http://127.0.0.1:3011` by default. Override the
daemon origin with `SUPERAGENTTEAM_DAEMON_ORIGIN`. Start the daemon with
`SUPERAGENTTEAM_HUB_ORIGIN=http://localhost:3000`, then use
`superagentteam auth console-link` and open the printed URL.

## Build / test

```bash
npm run typecheck --workspace @superagentteam/web
npm test --workspace @superagentteam/web
npm run build --workspace @superagentteam/web
```

## Boundaries

- Only `@superagentteam/shared` types and the M1 HTTP API.
- No Socket.IO in M0; polling only.
- No rich cards, approvals, workspace, artifacts, or classic-Hub state surfaces.
- M0 renders plain text; never `dangerouslySetInnerHTML`.
