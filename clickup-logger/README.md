# clickup-logger

**Your own ClickUp activity log, in ~15 minutes.**

ClickUp can tell you what changed in your workspace — but only through audit logs, which require an Enterprise plan. This little Cloudflare Worker gives you the same superpower for free: ClickUp pushes every change to your Worker the moment it happens, and it stores each event in a database you own.

Out of the box it logs **task status changes** ("who moved what, from what, to what, when"). Want more — comments, assignees, due dates? That's a one-line config change, no code.

```
someone moves a card in ClickUp
        │
        ▼  ClickUp delivers a signed webhook event
clickup-logger (Cloudflare Worker)
        │  checks it's authorized, then stores the event
        ▼
Your D1 database — query it anytime via a simple HTTP endpoint
```

## What you need

- A free [Cloudflare](https://cloudflare.com) account
- A ClickUp personal API token (ClickUp → **Settings → Apps → API Token**)
- Node.js installed (for `npx wrangler`)

Everything here runs on free tiers.

## Setup

From this directory:

**1. Log in to Cloudflare** (opens your browser):
```sh
npx wrangler login
```

**2. Create your database:**
```sh
npx wrangler d1 create clickup-events
```
It prints a `database_id` — paste it into `wrangler.toml`, replacing `REPLACE_ME`.

**3. Create the events table:**
```sh
npx wrangler d1 execute clickup-events --remote --file=schema.sql
```

**4. Deploy** — this creates the Worker. (Secrets can only be attached to a Worker that already exists, so deploy comes first.)
```sh
npx wrangler deploy
```
Note your URL: `https://clickup-logger.<you>.workers.dev`

**5. Choose a read token** — this protects your data when you query it later. Generate a good one:
```sh
openssl rand -hex 32
npx wrangler secret put READ_TOKEN   # paste the generated value
```
The upload updates your deployed Worker with the new secret — no second deploy needed.

**6. Check it's alive:**
```sh
curl https://clickup-logger.<you>.workers.dev/health
```

## Connect ClickUp

**1. Generate a webhook token** — this is what keeps impostors out. (ClickUp signs deliveries with a per-webhook secret, but it doesn't expose that secret via the API — it's masked in every response — so clickup-logger gives your webhook an unguessable URL instead.)

```sh
openssl rand -hex 32
```

**2. Store it in the Worker:**
```sh
npx wrangler secret put WEBHOOK_PATH_TOKENS   # paste the generated value
```

**3. Register the webhook** — note the token at the end of the URL. Find your workspace ID with `GET https://api.clickup.com/api/v2/team`:

```sh
curl -s -X POST -H "Authorization: $CLICKUP_API_TOKEN" -H "Content-Type: application/json" \
  https://api.clickup.com/api/v2/team/<team_id>/webhook \
  --data '{"endpoint":"https://clickup-logger.<you>.workers.dev/webhook/<token>","events":["taskStatusUpdated"]}'
```

Only deliveries carrying the exact token are accepted; everything else gets a 404.

## Try it out

Move any card's status in ClickUp, then ask your logger what happened:

```sh
NOW=$(date +%s%3N); DAY_AGO=$((NOW - 86400000))
curl -s -H "Authorization: Bearer $READ_TOKEN" \
  "https://clickup-logger.<you>.workers.dev/events?from=$DAY_AGO&to=$NOW"
```

You'll see who changed what, with before/after values and timestamps. That's the whole point. 🎉

## Querying your log

| Endpoint | What it gives you |
|----------|-------------------|
| `GET /events?from=<ms>&to=<ms>` | Events in a time range (add `&user_id=<id>` to filter by person). Max 1000 per call — if the response says `truncated: true`, re-query starting from the last event's `date_ms` + 1. |
| `GET /stats` | How much you've logged and how full the database is. |
| `GET /health` | Just a liveness ping. |

`/events` and `/stats` need `Authorization: Bearer <your read token>`. Timestamps are epoch milliseconds.

## Going further

**More event types.** Subscribe to comments, assignee changes, due dates and more — see the full list in [ClickUp's webhook docs](https://developer.clickup.com/docs/webhooks). Update your existing webhook:

```sh
curl -s -X PUT -H "Authorization: $CLICKUP_API_TOKEN" -H "Content-Type: application/json" \
  https://api.clickup.com/api/v2/webhook/<webhook_id> \
  --data '{"endpoint":"<same url>","events":["taskStatusUpdated","taskAssigneeUpdated"],"status":"active"}'
```

(Find your `<webhook_id>` with `GET /team/<team_id>/webhook`.)

**More workspaces.** One Worker can serve many workspaces — register a webhook in each, and give each registration its own token (`openssl rand -hex 32` per workspace). Store them all, comma-separated:

```sh
npx wrangler secret put WEBHOOK_PATH_TOKENS   # value: token1,token2,...
```

Each stored row carries the `webhook_id` it arrived on — keep a note of which ID belongs to which workspace.

## Housekeeping

The free D1 tier caps one database at 500 MB — at ~1–2 KB per event that's still hundreds of thousands of events, so you may never need this section. `/stats` warns you (`warn: true`) once you pass 90% (tunable via `WARN_RATIO` in `wrangler.toml`). To prune old events:

```sh
npx wrangler d1 execute clickup-events --remote \
  --command "DELETE FROM events WHERE date_ms < <cutoff_ms>"
```

## Good to know

- **It records from the moment you connect it.** ClickUp doesn't expose older history via API — the past lives only in ClickUp's own activity feeds.
- **Brief outages can lose events.** ClickUp retries failed deliveries only briefly.
- **Some events have no before/after.** Deletions (like `taskDeleted`) arrive without details; they're stored with the raw payload intact.
- **Your data stays yours.** Events live in your Cloudflare account; the read token is the only key.
- **Why a URL token instead of a signature?** ClickUp signs each delivery with a per-webhook secret, but never shows you that secret (masked in every API response), so it can't be verified against. The unguessable token in the webhook URL is what authenticates deliveries instead.

## License

MIT — take it, fork it, make it yours.
