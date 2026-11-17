# Contributing to wafio-cp-frontend

Thank you for looking at the code. This file says what a change needs before it can be merged.

## Before you start

- For anything larger than a small fix, open an issue first and say what you want to change. It saves you work if the change does not fit.
- A security problem does not go into an issue: see `SECURITY.md`.

## Build and test

The requirements are in the README. Bun is the only runtime; Node.js is not used. The full gate runs on Linux:

```bash
scripts/ci-local.sh
```

## Rules of this repository

- Look at a change to the interface in a browser, in the light and the dark theme and at a phone width, before you send it.
- Text keeps the contrast the gate checks, and every control works with the keyboard.
- The README section "Conventions" lists the code rules.
- A value that mirrors the control plane is tested against `tests/fixtures/backend/`; the README section "Test" says how those files are updated.
- A new dependency must be maintained and have a licence that GPL-3.0 allows.

## Pull requests

- One topic per pull request, with tests for what it changes.
- Say what the change does and how you checked it.
- Commit messages and comments are plain English.
- Do not commit secrets, local configuration, certificates or keys.
- Do not add instruction files for coding assistants, or planning notes, to the repository. The gate refuses them.

## Licence of your contribution

The project is under the GNU General Public License, version 3 only (`LICENSE`). Before a contribution can be merged you must agree to the Wafio Contributor Licence Agreement in `CLA.md`. You keep your copyright; the agreement gives Wafio the right to publish your contribution in this project and in the products built from it. Section 5 of `CLA.md` says how to agree.

If part of a change comes from another project, say so in the pull request: the project, the copyright holder and the licence. Such code needs an entry in the third-party notices.
