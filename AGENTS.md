# AGENTS.md

Instructions for coding assistants that work on wafio-cp-frontend. The rules for every contribution are in
`CONTRIBUTING.md`; this file is the short form.

## What this is

The Wafio dashboard: a SvelteKit app built to static files that the control plane serves. It runs on Bun;
Node.js is not used. The fixture check needs wafio-cp-backend next to this repository.

## Commands

    bun install --frozen-lockfile
    bun run check        # svelte-check: types and Svelte diagnostics
    bun run test         # the unit tests in tests/
    bun run build        # output: dist/
    scripts/ci-local.sh  # the gate: must pass before a pull request

The gate runs the secret scan, the fixture comparison, the advisory check and the four steps above. Fix what
it reports; do not disable a check.

## Rules

- Use the components, tokens and spacing the app already has. README, "Conventions", lists the code rules.
- A change to the interface is looked at in a browser by a person, in the light and the dark theme and at a
  phone width. Say in the pull request that this was done; an assistant cannot do it for them.
- Text keeps the contrast the gate checks, and every control works with the keyboard.
- A value that mirrors the control plane is tested against `tests/fixtures/backend/`.
- A change comes with a test.
- A new dependency must be maintained and have a licence GPL-3.0 allows. `bun.lock` is the only lockfile.

## Do not edit

- `tests/fixtures/backend/`: copies of files in wafio-cp-backend. Change them there; the README says how the
  copies are updated.
- `LICENSE`, `CLA.md`, `scripts/advisories.allow`.

## Writing

Comments, commit messages and documents are plain English. One topic per pull request.

## Security

Do not put a vulnerability in an issue, a pull request or a commit message. `SECURITY.md` says how to report it.

## The person, not the assistant

The person who opens the pull request has read the change, understands it and answers for it, and agrees to
`CLA.md`. A security
report must be reproduced before it is sent. `CONTRIBUTING.md`, "Work done with a coding assistant", says the same.
