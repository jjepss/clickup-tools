# AGENTS.md

Conventions for anyone (human or agent) working in this repo.

> **Note:** this is a personal repo. These conventions reflect the owner's workflow (solo development, personal accounts) and are documented mainly so AI coding assistants follow them. External contributors are welcome, but expect the repo to be run personal-project style.

## Repo shape

Monorepo of ClickUp tools and integrations. Each tool lives in its own top-level directory with its own README. Add a row to the tools table in the root `README.md` when adding a tool.

## Documentation style

READMEs are for **users**, always: friendly, task-oriented, jargon-light, with a quickstart that works end-to-end. Conventions, architecture rationale, and contributor rules go here in AGENTS.md, not in READMEs.

## Public repo — sanitization rules

This repo is public. Never commit:

- API tokens, webhook secrets, read tokens (they live in your local env file and wrangler secrets — never in files)
- Real workspace/team IDs, user IDs, names, or emails — use `<team_id>`-style placeholders in docs and examples
- `.env`, `.dev.vars`, `.wrangler/` (already in `.gitignore` — keep it that way)

Before pushing, run the secret scan:

```sh
grep -rniE 'pk_[a-z0-9]|[0-9]{9,}' . ; echo "exit $? (review any hits)"
```

## Git workflow

- Solo phase: commit directly to `main`. No PR ceremony.
- When CI deploys get added (one GitHub Actions workflow per tool, path-filtered to its directory, `wrangler deploy` on push to main), every push to main becomes a live deploy — at that point switch to `<tool>/<change>` branches + PRs so merging is the deliberate ship step.

## Tool conventions

- **clickup-logger** — Cloudflare Worker + D1. Keep it a dumb pipe (receive → verify → store → serve); no opinionated logic about what events mean. Consumers (skills, reports, alerts) live elsewhere and read via `/events`. Storage is event-generic; widening subscriptions is a webhook config change, not a code change. Validate Worker changes with `node --check src/index.js` before committing.
- **Webhook auth is a URL token, not an HMAC signature — this is deliberate.** ClickUp generates a per-webhook signing secret but never exposes it via the API (masked in every response), so `X-Signature` verification cannot be configured against ClickUp. Deliveries are authenticated by an unguessable path token (`POST /webhook/<token>`, secret `WEBHOOK_PATH_TOKENS`, comma-separated for multiple workspaces). Do not "simplify" this back to signature-only auth; the HMAC code path remains for senders that do share secrets.
