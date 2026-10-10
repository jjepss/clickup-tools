# clickup-logger

**Your own ClickUp activity log, in ~15 minutes.**

ClickUp can tell you what changed in your workspace — but only through audit logs, which require an Enterprise plan. This little Cloudflare Worker gives you the same superpower for free: ClickUp pushes every change to your Worker the moment it happens, and it stores each event in a database you own.

Out of the box it logs **task status changes** ("who moved what, from what, to what, when"). Want more — comments, assignees, due dates? That's a one-line config change, no code.

```
someone moves a card in ClickUp
        │
        ▼  ClickUp delivers a signed webhook event
clickup-logger (Cloudflare Worker)
        │  verifies it's really ClickUp, then stores the event
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

**4. Choose a read token** — this protects your data when you query it later. Generate a good one:
```sh
openssl rand -hex 32
npx wrangler secret put READ_TOKEN   # paste the generated value
```

**5. Deploy:**
```sh
npx wrangler deploy
```
Note your URL: `https://clickup-logger.<you>.workers.dev`

**6. Check it's alive:**
```sh
curl https://clickup-logger.<you>.workers.dev/health
```

## Connect ClickUp

Find your workspace ID with `GET https://api.clickup.com/api/v2/team`, then register the webhook:

```sh
curl -s -X POST -H "Authorization: $CLICKUP_API_TOKEN" -H "Content-Type: application/json" \
  https://api.clickup.com/api/v2/team/<team_id>/webhook \
  --data '{"endpoint":"https://clickup-logger.<you>.workers.dev/webhook","events":["taskStatusUpdated"]}'
```

The response includes a `secret` — ClickUp signs every delivery with it, so your Worker can reject impostors. Store it:

```sh
npx wrangler secret put CLICKUP_WEBHOOK_SECRET
```

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

**More workspaces.** One Worker can serve many workspaces — register a webhook in each, all pointing at the same URL. Each registration has its own signing secret, so store them all, comma-separated:

```sh
npx wrangler secret put CLICKUP_WEBHOOK_SECRETS   # value: secret1,secret2,...
```

Each stored row carries the `webhook_id` it arrived on — keep a note of which ID belongs to which workspace.

## Housekeeping

The free D1 tier holds 5 GB — millions of events, so you may never need this section. `/stats` warns you (`warn: true`) once you pass 90% (tunable via `WARN_RATIO` in `wrangler.toml`). To prune old events:

```sh
npx wrangler d1 execute clickup-events --remote \
  --command "DELETE FROM events WHERE date_ms < <cutoff_ms>"
```

## Good to know

- **It records from the moment you connect it.** ClickUp doesn't expose older history via API — the past lives only in ClickUp's own activity feeds.
- **Brief outages can lose events.** ClickUp retries failed deliveries only briefly.
- **Some events have no before/after.** Deletions (like `taskDeleted`) arrive without details; they're stored with the raw payload intact.
- **Your data stays yours.** Events live in your Cloudflare account; the read token is the only key.

## License

MIT — take it, fork it, make it yours.
