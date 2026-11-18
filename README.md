# wafio-cp-frontend
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/16871/badge)](https://www.bestpractices.dev/projects/16871) [![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/Wafio/wafio-cp-frontend/badge)](https://scorecard.dev/viewer/?uri=github.com/Wafio/wafio-cp-frontend)

The Wafio control plane dashboard: projects, applications, WAF agents and policies, hosts (firewall and runtime security), credentials, members, audit log and system administration.

It is a static single-page app (SvelteKit 3, Svelte 5 with runes, TypeScript 6, Vite 8, `adapter-static`). It runs in the browser; the control plane serves the built files from its `server.frontend_path` directory and answers the app's API calls.

## Place in the platform

| Repo | Contents |
|---|---|
| wafio-cp-backend | Go control plane, migrations, `shared/` module |
| **wafio-cp-frontend (this repo)** | SvelteKit dashboard |
| wafio-agent-waf | Rust WAF agent |
| wafio-agent-host | Go host agent, BPF C |
| wafio-portal | wafio.cloud site and blog (SvelteKit), portal API (Go) (private) |
| uddin-lang-rs | Rust uddin interpreter |
| wafio-release | installers, release bundle layout, release and publish scripts (private) |
| wafio-docs | internal notes (private) |

The dashboard uses only the control plane's HTTP API and its server-sent event streams. The API is described in `api/openapi.yaml` of wafio-cp-backend (OpenAPI 3.1). The agent gRPC protocol is not used here.

## Requirements

- [Bun](https://bun.sh). Hosted CI pins 1.4.4 (`.github/workflows/ci.yml`). `bun.lock` is the only lockfile.
- Bun 1.4 or newer (`engines` in `package.json`). Node.js is not needed: `bunfig.toml` makes every script run on Bun.
- `gitleaks` 8.30.1 for the gate (`scripts/ci-local.sh`).
- Linux for the gate (`scripts/ci-local.sh`).

## Build

```bash
bun install --frozen-lockfile
bun run build     # output: dist/
```

`bun run build` is the definitive check of the app.

To serve the build with a control plane, copy `dist/` into the directory named by `server.frontend_path` in the control plane's `config.yaml` (default `frontend`, relative to its working directory).

## Test

```bash
scripts/ci-local.sh
```

`scripts/ci-local.sh` runs on Linux and checks the working tree. The fixture check needs `../wafio-cp-backend/test/frontend-fixtures` next to this repo.

It runs, in order:

1. the agent-material check: no `AGENTS.md`, `CLAUDE.md`, `.claude/` or similar files, and no tracker, finding or planning IDs in code or strings (Markdown files are excluded);
2. the secret scan, `gitleaks git` with `.gitleaks.toml`;
3. the fixture copies: `tests/fixtures/backend/*.json` are copies of `test/frontend-fixtures/` in wafio-cp-backend (`correlation.json`: the correlation fields, operators and destination scopes; `defaults.json`: the default policy rules). The check compares them with `cmp` when wafio-cp-backend sits next to this repo (`WAFIO_BACKEND_DIR` overrides) and prints a note instead when it is not there. A Go test in wafio-cp-backend keeps its files equal to the code; after a backend change, rewrite them there with `WAFIO_UPDATE_FRONTEND_FIXTURES=1` and copy them here;
4. `bun install --frozen-lockfile`;
5. `bun run check`: `svelte-kit sync` and `svelte-check` (types and Svelte diagnostics);
6. `bun run test`: the unit tests in `tests/` (`bun test tests`), including the colour contrast gate;
7. `bun run build`.

Hosted CI (`.github/workflows/ci.yml`) runs the same script on pull requests.

## Run locally

```bash
bun install
bun run dev          # http://localhost:5173
```

The dev server needs a control plane. The control plane listens on `:9087` (HTTP) and `:9090` (agent gRPC); the dashboard only talks to `:9087`.

- **Your own control plane.** Start it as described in the README of wafio-cp-backend (database, `config.yaml` with `jwt.secret` and `totp.enc_key`, then `serve`). With the default settings the dev server proxies `/api` and `/health` to `http://127.0.0.1:9087`.
- **The demo control plane.** No backend on your machine is needed:

  ```bash
  VITE_API_BASE_URL= WAFIO_API_TARGET=https://demo-cp.wafio.cloud bun run dev
  ```

  The demo is a live system: saving in the dashboard changes it for real (firewall rules, kill policies, host revocation, members), so work in your own project. Use your own account, created from an invitation: the app keeps the session token in `localStorage`, so do not sign in with an administrator account in a build you or someone else modified. The demo runs the latest release, so endpoints that exist only in newer backend code are missing there. Repeated failed sign-ins lock the account for a while.

When you start the dev server in the background, give it `/dev/null` as stdin, or Vite crashes with `EIO`:

```bash
bun run dev < /dev/null >> dev-server.log 2>&1 &
```

Other scripts: `bun run preview` serves the production build locally.

## Configuration

`src/lib/api.ts` sends every request to `VITE_API_BASE_URL`, or to the page's own origin when that variable is empty.

| Variable | Read by | Default | Purpose |
|---|---|---|---|
| `VITE_API_BASE_URL` | the app in the browser (build time) | empty = same origin | Where the browser sends API requests |
| `WAFIO_API_TARGET` | `vite.config.js` (dev server only) | `http://127.0.0.1:9087` | Where the dev server proxies `/api` and `/health` |
| `BASE_PATH` | `vite.config.js` (build time) | empty | Serve the app under a sub-path |

- **Empty `VITE_API_BASE_URL` (recommended).** The browser calls `localhost:5173/api/...` and the dev server proxies it, so the browser stays same-origin and the control plane needs no CORS settings. Server-sent event streams pass through the proxy unbuffered. When the control plane serves the build itself, the app is same-origin as well.
- **`VITE_API_BASE_URL` set to a URL.** The browser calls that control plane directly, which must then allow your origin (`server.cors_enabled` and `server.cors_allow_origins` in its `config.yaml`). Otherwise every request fails with "Unable to reach the server. Please retry."

Variables set in the shell override the `.env` files: `VITE_API_BASE_URL= bun run dev` runs with an empty base URL even when `.env` sets one. `WAFIO_API_TARGET` is read from the shell only. Copy `.env.example` to `.env` to keep local settings; `.env` is not committed.

## Release

```bash
scripts/release.sh v2.0.0               # builds build/wafio-frontend-v2.0.0.tar.gz
scripts/release.sh v2.0.0 --publish     # also creates the GitHub release with that archive
```

The version must match `vX.Y.Z` with an optional `-suffix`.

The archive holds the contents of `dist/` under one top directory, `wafio-frontend-<version>/`. The app is built with the base path placeholder `/__WAFIO_BASE__` (for `BASE_PATH` and `VITE_API_BASE_URL`), so one archive serves at the root or under any path; the control plane installer replaces the placeholder with the path chosen at install time. The control plane release downloads the archive with `gh release download` and puts its contents into the bundle's `frontend/` directory, so this release comes first in the order of a platform release.

`--publish` needs a clean tree, `HEAD` tagged with the version and pushed, and an authenticated `gh`.

The `Dockerfile.bun` image builds the app with Bun and serves `dist/` with nginx on `:5173` (`--build-arg VITE_API_BASE_URL=...`).

## Layout

```
src/
├── app.css            design tokens (colours, spacing, system fonts) for the dark and light themes
├── app.html           HTML shell
├── lib/
│   ├── api.ts         the API client; every request goes through it
│   ├── sse.ts         server-sent event streams (single-use stream tickets)
│   ├── components/    shared components; ui/ holds the primitives (Modal, DataTable, Tabs, ...)
│   ├── format.ts      dates (UTC from the API, shown in local time), numbers, bytes, durations
│   ├── validation.ts  IP/CIDR, ports, URLs and other field checks
│   └── ...            page logic kept out of components (host scope, polling, dirty tracking, ...)
└── routes/            pages (SvelteKit file routing); project pages under projects/[id]/
static/                favicon and logo files
tests/                 unit tests, including the colour contrast gate; fixtures/backend/ holds the copies of the backend fixtures
scripts/               ci-local.sh (all gates), release.sh (release archive)
.github/workflows/     ci.yml
Dockerfile.bun         image that builds the app and serves it with nginx
```

## Conventions

- Svelte 5 runes only. No `$:` reactivity.
- Every API call goes through `src/lib/api.ts`. Never call `fetch()` in a component.
- Live updates use `src/lib/sse.ts` with a stream ticket. Never put the token in a URL.
- Colours come only from the tokens in `src/app.css`, as `var(--token)`. No hex values elsewhere. `tests/contrast.test.ts` checks text and control contrast in both themes.
- Show dates with `formatDateTime` or `<DateTime>`.
- Use the shared components in `src/lib/components/ui` before writing page-local ones. Import from `src/lib` as `#lib/<file>.js` (the `imports` field of `package.json`); a `.ts` file is imported with its `.js` name.
- Sidebar labels and page titles follow `PROJECT_NAV` in `src/lib/shell-nav.ts`.

### Branding

| What | Where |
|---|---|
| Logo mark and wordmark | `src/lib/components/BrandLogo.svelte` (the mark is `static/logo-only.png`, the same file as the portal's; the wordmark is text) |
| Accent colour | `--accent` and related tokens in `src/app.css` |
| Fonts | System font stacks in the `--font-*` tokens of `src/app.css`; the dashboard calls no font host |
| Favicon and logo images | `static/favicon.ico`, `static/favicon.svg`, `static/logo-only.png` |
| Browser tab title suffix | `src/routes/+layout.svelte` |

After changing colours, run `bun run test` so the contrast gate checks the new palette. Invitation and password-reset email links, the agent install commands and the agent service names come from the backend and the installer, and keep their names.

## License

Copyright (C) 2026 Wafio. This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License, version 3 only, as published by the Free Software Foundation. It comes without any warranty. The full text is in `LICENSE` (SPDX: `GPL-3.0-only`).
