# clickup-tools
Monorepo of ClickUp tools and integrations. Each tool lives in its own directory.

## Tools

| Directory | What it does |
|-----------|--------------|
| [`clickup-logger/`](clickup-logger/) | Cloudflare Worker + D1 webhook event logger with full attribution — a self-hosted, forward-only substitute for Enterprise audit logs. Currently subscribed to `taskStatusUpdated` (status changes); other event types can be added without code changes. |
