// clickup-logger — receives ClickUp webhook events, stores them in D1,
// and serves them back to consumers (skills, reports, alerts) for reporting.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && (url.pathname === "/webhook" || url.pathname.startsWith("/webhook/"))) {
      return handleWebhook(request, env, url);
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

// ClickUp generates its own signing secret per webhook but never exposes it
// via the API (masked in every response), so HMAC verification can't be
// configured against ClickUp. Deliveries are authenticated instead by an
// unguessable path token: POST /webhook/<token>. Senders that DO support
// shared secrets can additionally set CLICKUP_WEBHOOK_SECRET(S), which are
// then verified against X-Signature.
// Fallback events (no history_items) carry no platform event id and no
// timestamp of their own, so two genuinely distinct events can arrive as
// byte-identical bodies. Their dedup key is the body hash plus a coarse
// time bucket: a retry of a failed delivery lands well inside an hour, so
// it collapses with the original, while a repeat of the same body in a
// later bucket is kept as its own row. Trade-offs: an identical event
// repeated within the same bucket still collapses, and a retry that
// straddles a bucket boundary is stored twice.
const DEDUP_BUCKET_MS = 60 * 60 * 1000;

async function handleWebhook(request, env, url) {
  const providedToken = url.pathname.slice("/webhook".length).replace(/^\//, "");
  const tokens = webhookPathTokens(env);
  if (tokens.length === 0) {
    return new Response("webhook endpoint not configured", { status: 503 });
  }
  if (!tokens.some((t) => timingSafeStringEqual(t, providedToken))) {
    return new Response("not found", { status: 404 });
  }

  const body = await request.text();

  const secrets = webhookSecrets(env);
  if (secrets.length > 0) {
    const signature = request.headers.get("X-Signature");
    if (!(await verifySignature(body, signature, secrets))) {
      return new Response("bad signature", { status: 401 });
    }
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response("bad json", { status: 400 });
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return new Response("bad json", { status: 400 });
  }

  let items = payload.history_items === undefined ? [] : payload.history_items;
  if (!Array.isArray(items)
      || items.some((item) => item === null || typeof item !== "object" || Array.isArray(item))) {
    return new Response("bad history_items", { status: 400 });
  }
  if (items.length === 0) {
    // Some events (taskDeleted, spaceUpdated) carry no history_items.
    // Store one fallback row so the event isn't silently dropped. Its id is
    // the SHA-256 of the raw body plus a coarse time bucket: a redelivered
    // identical payload lands in the same bucket, maps to the same primary
    // key, and INSERT OR IGNORE drops the duplicate; the same body repeated
    // in a later bucket is a distinct event and lands separately.
    items = [{ date: null, field: null, user: null, before: null, after: null }];
  }
  // Stable id for rows without a platform event id: redeliveries of the same
  // body within the bucket collide and are ignored; genuinely different
  // bodies hash apart, and the same body in a later bucket lands separately.
  const bodyHash = await sha256Hex(body);
  const bucket = Math.floor(Date.now() / DEDUP_BUCKET_MS);
  let index = 0;
  for (const item of items) {
    const id = item.id != null
      ? String(item.id)
      : items.length === 1
        ? `${bodyHash}:${bucket}`
        : `${bodyHash}:${bucket}:${index}`;
    await env.DB.prepare(
      `INSERT OR IGNORE INTO events
         (id, event, webhook_id, task_id, team_id, date_ms, field, user_id, username, before_json, after_json, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        String(payload.event ?? "unknown"),
        payload.webhook_id != null ? String(payload.webhook_id) : null,
        payload.task_id != null ? String(payload.task_id) : null,
        payload.team_id != null ? Number(payload.team_id) : null,
        Number(item.date ?? Date.now()),
        item.field != null ? String(item.field) : null,
        item.user?.id != null ? Number(item.user.id) : null,
        item.user?.username != null ? String(item.user.username) : null,
        item.before != null ? JSON.stringify(item.before) : null,
        item.after != null ? JSON.stringify(item.after) : null,
        body
      )
      .run();
    index += 1;
  }

  return Response.json({ stored: items.length });
}

function isAuthorized(request, env) {
  // Fail closed: an unset READ_TOKEN must reject every read, including a
  // request that literally sends "Authorization: Bearer undefined".
  if (typeof env.READ_TOKEN !== "string" || !env.READ_TOKEN.trim()) {
    return false;
  }
  const auth = request.headers.get("Authorization") || "";
  return timingSafeStringEqual(auth, `Bearer ${env.READ_TOKEN}`);
}

// Each webhook registration has its own signing secret. Support many
// (multi-workspace) via CLICKUP_WEBHOOK_SECRETS="s1,s2", falling back to the
// singular CLICKUP_WEBHOOK_SECRET for single-workspace setups.
function webhookPathTokens(env) {
  const raw = env.WEBHOOK_PATH_TOKENS || env.WEBHOOK_PATH_TOKEN || "";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

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

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
            AVG(LENGTH(CAST(raw_json AS BLOB))) AS avg_row_bytes
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

function parseSafeInteger(value) {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function handleQuery(request, env, url) {
  if (!isAuthorized(request, env)) {
    return new Response("unauthorized", { status: 401 });
  }

  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");
  const from = fromParam === null ? 0 : parseSafeInteger(fromParam);
  const to = toParam === null ? Date.now() : parseSafeInteger(toParam);
  if (from === null || to === null) {
    return new Response("invalid event range", { status: 400 });
  }

  const userIdParam = url.searchParams.get("user_id");
  const teamIdParam = url.searchParams.get("team_id");
  const userId = userIdParam === null ? null : parseSafeInteger(userIdParam);
  const teamId = teamIdParam === null ? null : parseSafeInteger(teamIdParam);
  if ((userIdParam !== null && userId === null) || (teamIdParam !== null && teamId === null)) {
    return new Response("invalid event filter", { status: 400 });
  }

  const afterDateParam = url.searchParams.get("after_date");
  const afterId = url.searchParams.get("after_id");
  const snapshotParam = url.searchParams.get("snapshot_rowid");
  const afterDate = afterDateParam === null ? null : parseSafeInteger(afterDateParam);
  const snapshotRowId = snapshotParam === null ? null : parseSafeInteger(snapshotParam);
  // Cursor pagination on (date_ms, id): timestamps alone are not a stable
  // cursor, because multiple events can share the boundary millisecond.
  // snapshot_rowid pins every continued page to the initial ingestion
  // high-water mark. All three cursor fields are required so a continuation
  // cannot fall back to an unpinned query that includes newly inserted rows.
  const hasCursor = afterDateParam !== null || afterId !== null || snapshotParam !== null;
  if (hasCursor && (afterDateParam === null || !/^\d+$/.test(afterDateParam)
      || afterDate === null || afterDate < from || afterDate >= to || !afterId
      || snapshotParam === null || !/^\d+$/.test(snapshotParam) || snapshotRowId === null)) {
    return new Response("invalid event cursor", { status: 400 });
  }

  let sql = `SELECT id, event, webhook_id, task_id, team_id, date_ms, field, user_id, username, before_json, after_json,
                    (SELECT MAX(rowid) FROM events) AS snapshot_rowid
             FROM events WHERE date_ms >= ? AND date_ms < ?`;
  const binds = [from, to];
  if (userId !== null) {
    sql += " AND user_id = ?";
    binds.push(userId);
  }
  if (teamId !== null) {
    sql += " AND team_id = ?";
    binds.push(teamId);
  }
  if (hasCursor) {
    sql += " AND (date_ms > ? OR (date_ms = ? AND id > ?))";
    binds.push(afterDate, afterDate, afterId);
  }
  if (snapshotRowId !== null) {
    sql += " AND rowid <= ?";
    binds.push(snapshotRowId);
  }
  sql += " ORDER BY date_ms ASC, id ASC LIMIT 1001";

  // Fetch one extra row (LIMIT 1001): a 1001st row proves more data exists,
  // so `truncated` is true exactly when the consumer must continue.
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  const events = results.slice(0, 1000).map(({ snapshot_rowid, ...event }) => event);
  const truncated = results.length > 1000;
  const last = events[events.length - 1];
  const nextSnapshotRowId = snapshotRowId ?? results[0]?.snapshot_rowid;
  return Response.json({
    events,
    truncated,
    next_cursor: truncated && last
      ? { date_ms: last.date_ms, id: last.id, snapshot_rowid: nextSnapshotRowId }
      : null,
  });
}

// For senders that support shared-secret signing (ClickUp itself does not
// expose its secret — see the note on handleWebhook):
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
