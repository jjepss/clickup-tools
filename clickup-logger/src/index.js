// clickup-logger — receives ClickUp webhook events, stores them in D1,
// and serves them back to consumers (skills, reports, alerts) for reporting.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/webhook") {
      return handleWebhook(request, env);
    }
    if (request.method === "GET" && url.pathname === "/events") {
      return handleQuery(request, env, url);
    }
    if (request.method === "GET" && url.pathname === "/stats") {
      return handleStats(request, env);
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  },
};

async function handleWebhook(request, env) {
  const body = await request.text();

  const signature = request.headers.get("X-Signature");
  if (!(await verifySignature(body, signature, webhookSecrets(env)))) {
    return new Response("bad signature", { status: 401 });
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response("bad json", { status: 400 });
  }

  let items = payload.history_items || [];
  if (items.length === 0) {
    // Some events (taskDeleted, spaceUpdated) carry no history_items.
    // Store one fallback row so the event isn't silently dropped.
    items = [{ id: crypto.randomUUID(), date: Date.now(), field: null, user: null, before: null, after: null }];
  }
  for (const item of items) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO events
         (id, event, webhook_id, task_id, date_ms, field, user_id, username, before_json, after_json, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        String(item.id ?? crypto.randomUUID()),
        String(payload.event ?? "unknown"),
        payload.webhook_id != null ? String(payload.webhook_id) : null,
        payload.task_id != null ? String(payload.task_id) : null,
        Number(item.date ?? Date.now()),
        item.field != null ? String(item.field) : null,
        item.user?.id != null ? Number(item.user.id) : null,
        item.user?.username != null ? String(item.user.username) : null,
        item.before != null ? JSON.stringify(item.before) : null,
        item.after != null ? JSON.stringify(item.after) : null,
        body
      )
      .run();
  }

  return Response.json({ stored: items.length });
}

function isAuthorized(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const expected = `Bearer ${env.READ_TOKEN}`;
  return timingSafeStringEqual(auth, expected);
}

// Each webhook registration has its own signing secret. Support many
// (multi-workspace) via CLICKUP_WEBHOOK_SECRETS="s1,s2", falling back to the
// singular CLICKUP_WEBHOOK_SECRET for single-workspace setups.
function webhookSecrets(env) {
  if (env.CLICKUP_WEBHOOK_SECRETS) {
    return env.CLICKUP_WEBHOOK_SECRETS.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return env.CLICKUP_WEBHOOK_SECRET ? [env.CLICKUP_WEBHOOK_SECRET] : [];
}

function timingSafeStringEqual(a, b) {
  const ba = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ba.byteLength !== bb.byteLength) return false;
  return crypto.subtle.timingSafeEqual(ba, bb);
}

// D1 free tier caps a single database at 500 MB (5 GB is the per-account
// total across all databases). Warn threshold configurable via wrangler.toml.
const SIZE_LIMIT_BYTES = 500 * 1024 * 1024;
const DEFAULT_WARN_RATIO = 0.9;

async function handleStats(request, env) {
  if (!isAuthorized(request, env)) {
    return new Response("unauthorized", { status: 401 });
  }

  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS row_count,
            MIN(date_ms) AS oldest_ms,
            MAX(date_ms) AS newest_ms,
            AVG(LENGTH(raw_json)) AS avg_row_bytes
     FROM events`
  ).first();

  const warnRatio = Number(env.WARN_RATIO) || DEFAULT_WARN_RATIO;
  const estimatedBytes = Math.round((row.row_count || 0) * (row.avg_row_bytes || 0));
  const ratio = estimatedBytes / SIZE_LIMIT_BYTES;

  return Response.json({
    row_count: row.row_count,
    oldest_ms: row.oldest_ms,
    newest_ms: row.newest_ms,
    estimated_bytes: estimatedBytes,
    limit_bytes: SIZE_LIMIT_BYTES,
    usage_ratio: Math.round(ratio * 1000) / 1000,
    warn: ratio >= warnRatio,
  });
}

async function handleQuery(request, env, url) {
  if (!isAuthorized(request, env)) {
    return new Response("unauthorized", { status: 401 });
  }

  const from = Number(url.searchParams.get("from") || 0);
  const to = Number(url.searchParams.get("to") || Date.now());
  const userId = url.searchParams.get("user_id");

  let sql = `SELECT id, event, webhook_id, task_id, date_ms, field, user_id, username, before_json, after_json
             FROM events WHERE date_ms >= ? AND date_ms < ?`;
  const binds = [from, to];
  if (userId) {
    sql += " AND user_id = ?";
    binds.push(Number(userId));
  }
  sql += " ORDER BY date_ms ASC LIMIT 1000";

  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  // Machine consumers: a full page means there may be more data. Re-query
  // with from = last row's date_ms + 1 to continue.
  return Response.json({ events: results, truncated: results.length === 1000 });
}

// ClickUp signs the raw request body with the webhook secret:
// X-Signature = hex(HMAC-SHA256(body, secret))
async function verifySignature(body, signature, secrets) {
  if (!signature || secrets.length === 0) return false;
  const provided = signature.toLowerCase();
  for (const secret of secrets) {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    const expected = Array.from(new Uint8Array(mac))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    if (timingSafeStringEqual(expected, provided)) return true;
  }
  return false;
}
