'use strict';

// Offline regression tests for the clickup-logger Worker. No packages, no
// network, no real D1: requests are synthetic and env.DB is an in-memory
// adapter that implements just the SQL shapes the Worker emits.

const assert = require('node:assert/strict');
const { after, test } = require('node:test');
const { createHmac, timingSafeEqual, webcrypto } = require('node:crypto');
const worker = import('../src/index.js').then(module => module.default);

// Cloudflare adds timingSafeEqual to SubtleCrypto; use Node's equivalent offline.
const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {
        subtle: {
            importKey: webcrypto.subtle.importKey.bind(webcrypto.subtle),
            sign: webcrypto.subtle.sign.bind(webcrypto.subtle),
            digest: webcrypto.subtle.digest.bind(webcrypto.subtle),
            timingSafeEqual: (a, b) => timingSafeEqual(Buffer.from(a), Buffer.from(b)),
        },
    },
});
after(() => {
    if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto);
    else delete globalThis.crypto;
});

class MemoryDB {
    constructor(rows = []) {
        this.rows = new Map();
        this.calls = [];
        this.nextRowId = 1;
        for (const row of rows) this.insert(row);
    }

    insert(row) {
        const stored = { ...row, rowid: row.rowid ?? this.nextRowId };
        this.nextRowId = Math.max(this.nextRowId, stored.rowid + 1);
        this.rows.set(stored.id, stored);
    }

    prepare(sql) {
        const db = this;
        return {
            values: [],
            bind(...values) {
                this.values = values;
                return this;
            },
            async run() {
                db.calls.push({ operation: 'run', sql, values: this.values });
                assert.match(sql, /INSERT OR IGNORE INTO events/);
                const columns = sql.match(/\(([^)]+)\)\s*VALUES/)[1].split(',').map(value => value.trim());
                const row = Object.fromEntries(columns.map((column, index) => [column, this.values[index]]));
                if (!db.rows.has(row.id)) db.insert(row);
                return { success: true };
            },
            async first() {
                db.calls.push({ operation: 'first', sql, values: this.values });
                assert.match(sql, /AVG\(LENGTH\(CAST\(raw_json AS BLOB\)\)\) AS avg_row_bytes/);
                const rows = [...db.rows.values()];
                const lengths = rows.map(row => Buffer.byteLength(row.raw_json ?? '', 'utf8'));
                return {
                    row_count: rows.length,
                    oldest_ms: rows.length ? Math.min(...rows.map(row => row.date_ms)) : null,
                    newest_ms: rows.length ? Math.max(...rows.map(row => row.date_ms)) : null,
                    avg_row_bytes: lengths.length
                        ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0,
                };
            },
            async all() {
                db.calls.push({ operation: 'all', sql, values: this.values });
                assert.match(sql, /date_ms >= \? AND date_ms < \?/);
                assert.match(sql, /ORDER BY date_ms ASC, id ASC LIMIT 1001$/);
                let rows = [...db.rows.values()].filter(row =>
                    row.date_ms >= this.values[0] && row.date_ms < this.values[1]);
                let position = 2;
                if (sql.includes('AND user_id = ?')) {
                    rows = rows.filter(row => row.user_id === this.values[position]);
                    position += 1;
                }
                if (sql.includes('AND team_id = ?')) {
                    rows = rows.filter(row => row.team_id === this.values[position]);
                    position += 1;
                }
                if (sql.includes('AND (date_ms > ?')) {
                    assert.match(sql, /AND \(date_ms > \? OR \(date_ms = \? AND id > \?\)\)/);
                    const [date, sameDate, id] = this.values.slice(position);
                    assert.equal(date, sameDate);
                    rows = rows.filter(row => row.date_ms > date || (row.date_ms === date && row.id > id));
                    position += 3;
                }
                if (sql.includes('AND rowid <= ?')) {
                    rows = rows.filter(row => row.rowid <= this.values[position]);
                }
                const highWaterRowId = Math.max(0, ...[...db.rows.values()].map(row => row.rowid));
                const columns = sql.match(/SELECT ([\s\S]+?)\s+FROM events WHERE/)[1].split(',').map(value => value.trim());
                return {
                    results: rows.sort((a, b) => a.date_ms - b.date_ms || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
                        .slice(0, 1001)
                        .map(row => Object.fromEntries(columns.map(column => column === '(SELECT MAX(rowid) FROM events) AS snapshot_rowid'
                            ? ['snapshot_rowid', highWaterRowId]
                            : [column, row[column] ?? null]))),
                };
            },
        };
    }
}

function environment(rows = [], overrides = {}) {
    return {
        DB: new MemoryDB(rows),
        READ_TOKEN: 'synthetic-read-token',
        WEBHOOK_PATH_TOKENS: 'synthetic-path-token',
        ...overrides,
    };
}

function event(overrides = {}) {
    return {
        event: 'taskStatusUpdated',
        webhook_id: 'synthetic-webhook',
        task_id: 'synthetic-task',
        team_id: '123456',
        history_items: [{
            id: 'synthetic-history', date: 1000, field: 'status',
            user: { id: 7, username: 'Synthetic User' },
            before: { status: 'open' }, after: { status: 'in progress' },
        }],
        ...overrides,
    };
}

async function request(env, path, { body, signature, authorization, method = 'GET' } = {}) {
    const headers = {};
    if (signature !== undefined) headers['X-Signature'] = signature;
    if (authorization !== undefined) headers.Authorization = authorization;
    return (await worker).fetch(new Request('https://worker.example.invalid' + path, {
        method, headers, body,
    }), env);
}

async function webhook(env, payload = event(), { path, signature } = {}) {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const configured = env.WEBHOOK_PATH_TOKENS || env.WEBHOOK_PATH_TOKEN || '';
    const token = path ?? configured.split(',').map(s => s.trim()).filter(Boolean)[0];
    return request(env, `/webhook/${token}`, { method: 'POST', body, signature });
}

function row(id, date, user = 7, team = 9) {
    return {
        id, date_ms: date, user_id: user, team_id: team,
        event: 'taskStatusUpdated', raw_json: '{"synthetic":true}',
    };
}

test('health requires no credentials or database access', async () => {
    const env = environment();
    const response = await request(env, '/health');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.deepEqual(env.DB.calls, []);
});

test('unknown paths, unsupported methods, and wrong tokens return not found without writes', async () => {
    const env = environment();
    for (const [path, method] of [
        ['/missing', 'GET'], ['/events', 'POST'], ['/webhook', 'GET'],
        ['/webhook', 'POST'], ['/webhook/wrong-token', 'POST'],
    ]) {
        assert.equal((await request(env, path, { method })).status, 404, path);
    }
    assert.deepEqual(env.DB.calls, []);
});

test('unconfigured path tokens refuse deliveries instead of accepting everything', async () => {
    for (const tokens of [undefined, null, '', '   ', ',', 0, false]) {
        const env = environment([], { WEBHOOK_PATH_TOKENS: tokens });
        if (tokens === undefined) delete env.WEBHOOK_PATH_TOKENS;
        assert.equal((await webhook(env)).status, 503, JSON.stringify(tokens));
        assert.deepEqual(env.DB.calls, []);
    }
});

test('the singular WEBHOOK_PATH_TOKEN secret still works', async () => {
    const env = environment([], { WEBHOOK_PATH_TOKENS: undefined, WEBHOOK_PATH_TOKEN: 'legacy-token' });
    delete env.WEBHOOK_PATH_TOKENS;
    assert.equal((await webhook(env)).status, 200);
    assert.equal(env.DB.rows.size, 1);
});

test('comma-separated tokens are trimmed and each one is accepted', async () => {
    const env = environment([], { WEBHOOK_PATH_TOKENS: ' token-a , ,token-b ' });
    const item = id => event({
        task_id: `task-${id}`,
        history_items: [{ ...event().history_items[0], id: `history-${id}` }],
    });
    assert.equal((await webhook(env, item('a'), { path: 'token-a' })).status, 200);
    assert.equal((await webhook(env, item('b'), { path: 'token-b' })).status, 200);
    assert.equal((await webhook(env, item('c'), { path: 'token-c' })).status, 404);
    assert.equal(env.DB.rows.size, 2);
});

test('a valid token with no signing secrets configured stores attributed history', async () => {
    const env = environment();
    const response = await webhook(env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { stored: 1 });
    const saved = env.DB.rows.get('synthetic-history');
    assert.equal(saved.user_id, 7);
    assert.equal(saved.task_id, 'synthetic-task');
    assert.equal(saved.team_id, 123456);
    assert.equal(saved.webhook_id, 'synthetic-webhook');
    assert.deepEqual(JSON.parse(saved.before_json), { status: 'open' });
    assert.deepEqual(JSON.parse(saved.after_json), { status: 'in progress' });
    assert.deepEqual(JSON.parse(saved.raw_json), event());
    assert.equal(env.DB.calls[0].values.length, 12);
    assert.ok(!env.DB.calls[0].sql.includes('Synthetic User'));
});

test('repeated history identifiers are not stored twice', async () => {
    const env = environment();
    await webhook(env);
    await webhook(env);
    assert.equal(env.DB.rows.size, 1);
});

test('fallback events deduplicate on redelivery and hash apart on different bodies', async t => {
    t.mock.method(Date, 'now', () => 5_000_000);
    const env = environment();
    const deletion = event({ event: 'taskDeleted', history_items: [] });
    assert.equal((await webhook(env, deletion)).status, 200);
    assert.equal((await webhook(env, deletion)).status, 200);  // same body again
    assert.equal(env.DB.rows.size, 1);
    const saved = [...env.DB.rows.values()][0];
    assert.match(saved.id, /^[0-9a-f]{64}:\d+$/);
    assert.equal(saved.event, 'taskDeleted');
    assert.equal(saved.user_id, null);
    assert.equal(saved.before_json, null);
    assert.equal(saved.after_json, null);
    assert.equal(saved.team_id, 123456);

    const otherDeletion = event({ event: 'taskDeleted', history_items: [], task_id: 'another-task' });
    assert.equal((await webhook(env, otherDeletion)).status, 200);
    assert.equal(env.DB.rows.size, 2);
});

test('history items without an id get a stable body-derived key', async t => {
    t.mock.method(Date, 'now', () => 5_000_000);
    const env = environment();
    const payload = event({ history_items: [{ date: 1000, field: 'status', user: { id: 7, username: 'S' } }] });
    assert.equal((await webhook(env, payload)).status, 200);
    assert.equal((await webhook(env, payload)).status, 200);
    assert.equal(env.DB.rows.size, 1);
    assert.match([...env.DB.rows.keys()][0], /^[0-9a-f]{64}:\d+$/);
});

test('identical fallback bodies in later time buckets are distinct events', async () => {
    const env = environment();
    // spaceUpdated bodies carry no event id and no timestamp, so the same
    // change repeated hours apart is byte-identical and must still store
    // twice; only same-bucket redeliveries collapse.
    const spaceUpdate = event({ event: 'spaceUpdated', task_id: null, history_items: [] });
    const realNow = Date.now;
    try {
        Date.now = () => 5_000_000;
        assert.equal((await webhook(env, spaceUpdate)).status, 200);
        Date.now = () => 5_000_000 + 2 * 60 * 60 * 1000;  // two hours later
        assert.equal((await webhook(env, spaceUpdate)).status, 200);
    } finally {
        Date.now = realNow;
    }
    assert.equal(env.DB.rows.size, 2);
});

test('fallback redelivery across an hourly boundary is stored twice', async t => {
    let now = 60 * 60 * 1000 - 1;
    t.mock.method(Date, 'now', () => now);
    const env = environment();
    const payload = event({ event: 'taskDeleted', history_items: [] });
    assert.equal((await webhook(env, payload)).status, 200);
    now += 1;
    assert.equal((await webhook(env, payload)).status, 200);
    assert.equal(env.DB.rows.size, 2);
});

test('signatures are enforced only when a signing secret is configured', async () => {
    // No secrets: the token alone authenticates (ClickUp never shares its secret).
    const open = environment();
    assert.equal((await webhook(open, event(), { signature: 'garbage' })).status, 200);

    // With a secret: the delivery must also carry a valid HMAC.
    const signed = environment([], { CLICKUP_WEBHOOK_SECRET: 'synthetic-signing-secret' });
    const body = JSON.stringify(event());
    for (const signature of [undefined, 'bad-signature', '0'.repeat(64)]) {
        assert.equal((await webhook(signed, event(), { signature })).status, 401, signature);
    }
    const good = createHmac('sha256', 'synthetic-signing-secret').update(body).digest('hex');
    assert.equal((await webhook(signed, event(), { signature: good })).status, 200);
    assert.deepEqual(signed.DB.calls.slice(0, -1), []);
});

test('multiple signing secrets and uppercase signatures are supported', async () => {
    const secret = 'synthetic-second-secret';
    const env = environment([], {
        CLICKUP_WEBHOOK_SECRET: undefined,
        CLICKUP_WEBHOOK_SECRETS: ` synthetic-first-secret, ,${secret} `,
    });
    delete env.CLICKUP_WEBHOOK_SECRET;
    const signature = createHmac('sha256', secret).update(JSON.stringify(event())).digest('hex').toUpperCase();
    assert.equal((await webhook(env, event(), { signature })).status, 200);
    assert.equal(env.DB.rows.size, 1);
});

test('signature verification covers the actual body bytes', async () => {
    const env = environment([], { CLICKUP_WEBHOOK_SECRET: 'synthetic-signing-secret' });
    const signature = createHmac('sha256', 'synthetic-signing-secret').update(JSON.stringify(event())).digest('hex');
    const response = await webhook(env, JSON.stringify(event()) + ' ', { signature });
    assert.equal(response.status, 401);
    assert.deepEqual(env.DB.calls, []);
});

test('signed invalid JSON stops without a database write', async () => {
    const env = environment([], { CLICKUP_WEBHOOK_SECRET: 'synthetic-signing-secret' });
    const body = '{invalid';
    const signature = createHmac('sha256', 'synthetic-signing-secret').update(body).digest('hex');
    assert.equal((await webhook(env, body, { signature })).status, 400);
    assert.deepEqual(env.DB.calls, []);
});

test('syntactically valid JSON values that are not objects are rejected without writes', async () => {
    for (const body of ['null', 'true', '42', '"text"', '[]']) {
        const env = environment();
        const response = await webhook(env, body);
        assert.equal(response.status, 400, body);
        assert.equal(await response.text(), 'bad json');
        assert.deepEqual(env.DB.calls, [], body);
    }
});

test('null, non-array, and non-object history items are rejected without writes', async () => {
    for (const historyItems of [null, {}, 'history', 42, true, [null], ['history'], [[]]]) {
        const env = environment();
        const response = await webhook(env, event({ history_items: historyItems }));
        assert.equal(response.status, 400, JSON.stringify(historyItems));
        assert.equal(await response.text(), 'bad history_items');
        assert.deepEqual(env.DB.calls, [], JSON.stringify(historyItems));
    }
});

test('a payload with history_items omitted still stores its fallback event', async () => {
    const env = environment();
    const { history_items, ...payload } = event({ event: 'taskDeleted' });
    const response = await webhook(env, payload);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { stored: 1 });
    assert.equal(env.DB.rows.size, 1);
});

test('event and stats reads reject missing or wrong authorization before querying', async () => {
    const env = environment();
    for (const path of ['/events', '/stats']) {
        for (const authorization of [undefined, 'Bearer wrong', 'Bearer synthetic-read-tokex']) {
            assert.equal((await request(env, path, { authorization })).status, 401, authorization);
        }
    }
    assert.deepEqual(env.DB.calls, []);
});

test('unconfigured read tokens fail closed, including literal Bearer undefined', async () => {
    for (const token of [undefined, null, '', '   ', 0, false, {}]) {
        const env = environment([row('private-existing-event', 1000)], { READ_TOKEN: token });
        if (token === undefined) delete env.READ_TOKEN;
        for (const path of ['/events', '/stats']) {
            for (const authorization of [undefined, `Bearer ${token}`, 'Bearer undefined', 'Bearer synthetic-read-token']) {
                assert.equal((await request(env, path, { authorization })).status, 401,
                    `${path} ${authorization}`);
            }
        }
        assert.deepEqual(env.DB.calls, []);
    }
});

test('event reads expose stored status JSON, webhook identity, and team_id', async () => {
    const env = environment();
    await webhook(env);
    const response = await request(env, '/events?from=0&to=2000', {
        authorization: `Bearer ${env.READ_TOKEN}`,
    });
    const { events } = await response.json();
    assert.equal(events.length, 1);
    assert.equal(events[0].webhook_id, 'synthetic-webhook');
    assert.equal(events[0].task_id, 'synthetic-task');
    assert.equal(events[0].team_id, 123456);
    assert.deepEqual(JSON.parse(events[0].before_json), { status: 'open' });
    assert.deepEqual(JSON.parse(events[0].after_json), { status: 'in progress' });
    assert.ok(!Object.hasOwn(events[0], 'raw_json'));
});

test('reads bind inclusive start, exclusive end, and optional user and team filters', async () => {
    const env = environment([
        row('before', 999), row('start', 1000), row('other-user', 1500, 8),
        row('other-team', 1600, 7, 8), row('inside', 1999), row('end', 2000),
    ]);
    const authorization = `Bearer ${env.READ_TOKEN}`;
    const user = await (await request(env, '/events?from=1000&to=2000&user_id=7', { authorization })).json();
    assert.deepEqual(user.events.map(item => item.id), ['start', 'other-team', 'inside']);
    assert.deepEqual(env.DB.calls[0].values, [1000, 2000, 7]);

    const team = await (await request(env, '/events?from=1000&to=2000&team_id=8', { authorization })).json();
    assert.deepEqual(team.events.map(item => item.id), ['other-team']);
    assert.deepEqual(env.DB.calls[1].values, [1000, 2000, 8]);

    const both = await (await request(env, '/events?from=1000&to=2000&user_id=7&team_id=9', { authorization })).json();
    assert.deepEqual(both.events.map(item => item.id), ['start', 'inside']);
    assert.deepEqual(env.DB.calls[2].values, [1000, 2000, 7, 9]);
});

test('invalid range and filter numbers are rejected before querying', async () => {
    const env = environment();
    for (const parameter of ['from', 'to', 'user_id', 'team_id']) {
        for (const value of ['', 'no', 'NaN', '1.5', '1e3', '0x10', '+1', ' 1', 'Infinity', '9007199254740992']) {
            const response = await request(env, `/events?${parameter}=${encodeURIComponent(value)}`, {
                authorization: `Bearer ${env.READ_TOKEN}`,
            });
            assert.equal(response.status, 400, `${parameter}=${value}`);
        }
    }
    assert.deepEqual(env.DB.calls, []);
});

test('negative and maximum safe integer parameters retain their existing semantics', async () => {
    const env = environment();
    const authorization = `Bearer ${env.READ_TOKEN}`;
    const response = await request(env, '/events?from=-1000&to=9007199254740991&user_id=-7&team_id=0', {
        authorization,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(env.DB.calls[0].values, [-1000, 9007199254740991, -7, 0]);

    env.DB.calls = [];
    assert.equal((await request(env, '/events', { authorization })).status, 200);
    assert.equal(env.DB.calls[0].values[0], 0);
    assert.ok(Number.isSafeInteger(env.DB.calls[0].values[1]));
});

test('unfiltered event reads are chronological and empty ranges are explicit', async () => {
    const env = environment([row('later', 2000, 8), row('earlier', 1000)]);
    const authorization = `Bearer ${env.READ_TOKEN}`;
    const all = await (await request(env, '/events?from=0&to=3000', { authorization })).json();
    assert.deepEqual(all.events.map(item => item.id), ['earlier', 'later']);
    assert.deepEqual(env.DB.calls[0].values, [0, 3000]);
    const empty = await (await request(env, '/events?from=3000&to=4000', { authorization })).json();
    assert.deepEqual(empty, { events: [], truncated: false, next_cursor: null });
});

test('the lookahead row reports remaining data without exceeding 1000 events', async () => {
    for (const count of [999, 1000, 1001]) {
        const env = environment(Array.from({ length: count }, (_, index) => row(`event-${index}`, index)));
        const response = await request(env, '/events?from=0&to=2000', {
            authorization: `Bearer ${env.READ_TOKEN}`,
        });
        const result = await response.json();
        assert.equal(result.events.length, Math.min(count, 1000));
        assert.equal(result.truncated, count > 1000);
        assert.deepEqual(result.next_cursor, count > 1000
            ? { date_ms: 999, id: 'event-999', snapshot_rowid: count } : null);
    }
});

test('cursor pagination retains every event sharing the boundary millisecond', async () => {
    const rows = Array.from({ length: 2001 }, (_, index) => row(`event-${String(index).padStart(4, '0')}`, 1000));
    const env = environment([
        ...rows.slice().reverse(), row('before', 999), row('other-user', 1000, 8), row('end', 2000),
    ]);
    const authorization = `Bearer ${env.READ_TOKEN}`;
    for (const filter of ['', '&user_id=7', '&team_id=9']) {
        let cursor = '', collected = [], pages = 0;
        do {
            const response = await request(env, '/events?from=1000&to=2000' + filter + cursor, { authorization });
            assert.equal(response.status, 200);
            const result = await response.json();
            collected.push(...result.events.map(item => item.id));
            pages += 1;
            assert.ok(pages <= 3);
            cursor = result.truncated
                ? `&after_date=${result.next_cursor.date_ms}&after_id=${encodeURIComponent(result.next_cursor.id)}&snapshot_rowid=${result.next_cursor.snapshot_rowid}` : '';
            if (!cursor) assert.equal(result.next_cursor, null);
        } while (cursor);
        const expected = rows.map(item => item.id);
        if (filter !== '&user_id=7') expected.push('other-user');
        assert.deepEqual(collected, expected, filter);
    }
});

test('continued pages stay on the original ingestion snapshot and include its boundary row', async () => {
    const original = Array.from({ length: 1001 }, (_, index) =>
        row(`event-${String(index).padStart(4, '0')}`, 1000));
    const env = environment(original);
    const authorization = `Bearer ${env.READ_TOKEN}`;
    const first = await (await request(env, '/events?from=1000&to=2000', { authorization })).json();
    assert.equal(first.truncated, true);
    assert.equal(first.next_cursor.snapshot_rowid, 1001);
    assert.match(env.DB.calls[0].sql, /\(SELECT MAX\(rowid\) FROM events\) AS snapshot_rowid/);
    assert.ok(!Object.hasOwn(first.events[0], 'snapshot_rowid'));

    // Both rows arrive after the first page. One sorts before the cursor and
    // one after it; neither belongs to the original ingestion snapshot.
    env.DB.insert(row('a-late-before-cursor', 1000));
    env.DB.insert(row('z-late-after-cursor', 1000));
    const cursor = first.next_cursor;
    const continuedPath = `/events?from=1000&to=2000&after_date=${cursor.date_ms}&after_id=${encodeURIComponent(cursor.id)}`;
    const missingSnapshot = await request(env, continuedPath, { authorization });
    assert.equal(missingSnapshot.status, 400,
        'a snapshot-less continuation must not query the now-changed table');
    assert.equal(env.DB.calls.length, 1);

    const secondResponse = await request(env,
        `${continuedPath}&snapshot_rowid=${cursor.snapshot_rowid}`, { authorization });
    assert.equal(secondResponse.status, 200);
    assert.doesNotMatch(env.DB.calls[1].sql, /MAX\(rowid\)/,
        'a continued query must use its bound snapshot instead of recomputing the high-water mark');
    const second = await secondResponse.json();
    assert.deepEqual(second.events.map(item => item.id), ['event-1000']);
    assert.equal(second.truncated, false);
    assert.equal(env.DB.rows.get('event-1000').rowid, cursor.snapshot_rowid,
        'the row exactly at the high-water mark must remain visible');
    assert.deepEqual(env.DB.calls[1].values,
        [1000, 2000, 1000, 1000, 'event-0999', 1001]);
});

test('invalid or partial cursors are rejected before querying', async () => {
    const env = environment();
    for (const cursor of [
        'after_date=1000', 'after_id=event', 'after_date=1000&after_id=event',
        'after_date=&after_id=event&snapshot_rowid=1',
        'after_date=no&after_id=event&snapshot_rowid=1',
        'after_date=1.5&after_id=event&snapshot_rowid=1',
        'after_date=1e3&after_id=event&snapshot_rowid=1',
        'after_date=-1&after_id=event&snapshot_rowid=1',
        // 2^53: one past Number.MAX_SAFE_INTEGER, so the safe-integer check trips.
        'after_date=9007199254740992&after_id=event&snapshot_rowid=1',
        'after_date=1000&after_id=&snapshot_rowid=1',
        'after_date=999&after_id=event&snapshot_rowid=1',
        'after_date=2000&after_id=event&snapshot_rowid=1',
        'snapshot_rowid=1000', 'after_date=1000&after_id=event&snapshot_rowid=',
        'after_date=1000&after_id=event&snapshot_rowid=no',
        'after_date=1000&after_id=event&snapshot_rowid=1.5',
        'after_date=1000&after_id=event&snapshot_rowid=1e3',
        'after_date=1000&after_id=event&snapshot_rowid=-1',
        'after_date=1000&after_id=event&snapshot_rowid=9007199254740992',
    ]) {
        const response = await request(env, '/events?from=1000&to=2000&' + cursor, {
            authorization: `Bearer ${env.READ_TOKEN}`,
        });
        assert.equal(response.status, 400, cursor);
    }
    assert.deepEqual(env.DB.calls, []);
});

test('a zero snapshot cutoff is a valid nonnegative cursor value', async () => {
    const env = environment();
    const response = await request(env,
        '/events?from=1000&to=2000&after_date=1000&after_id=event&snapshot_rowid=0', {
            authorization: `Bearer ${env.READ_TOKEN}`,
        });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { events: [], truncated: false, next_cursor: null });
    assert.deepEqual(env.DB.calls[0].values, [1000, 2000, 1000, 1000, 'event', 0]);
});

test('cursor identifiers remain bound data, including punctuation and SQL-like text', async () => {
    const env = environment([row('z-last', 1000)]);
    const id = "' OR 1=1 --/?&";
    const response = await request(env,
        '/events?from=1000&to=2000&after_date=1000&after_id=' + encodeURIComponent(id) + '&snapshot_rowid=1', {
            authorization: `Bearer ${env.READ_TOKEN}`,
        });
    assert.equal(response.status, 200);
    assert.deepEqual(env.DB.calls[0].values, [1000, 2000, 1000, 1000, id, 1]);
    assert.ok(!env.DB.calls[0].sql.includes(id));
});

test('an encoded cursor id containing & excludes the boundary row exactly once', async () => {
    // A consumer that interpolates after_id raw would let the & split the
    // query string; the parsed cursor would then repeat the boundary event.
    // With URL encoding, the cursor names one row and nothing repeats.
    const env = environment([row('a-first', 1500), row('history&part=2', 1500), row('z-last', 1500)]);
    const response = await request(
        env,
        '/events?from=1000&to=2000&after_date=1500&after_id=' + encodeURIComponent('history&part=2') + '&snapshot_rowid=3',
        { authorization: `Bearer ${env.READ_TOKEN}` });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.events.map(item => item.id), ['z-last']);
    assert.deepEqual(env.DB.calls[0].values, [1000, 2000, 1500, 1500, 'history&part=2', 3]);
});

test('stats report row count, date bounds, and true UTF-8 payload bytes', async () => {
    const ascii = '{"synthetic":true}';
    const nonAscii = '{"note":"café 日本 😀"}';
    const env = environment([
        { ...row('earlier', 1000), raw_json: ascii },
        { ...row('later', 2000), raw_json: nonAscii },
    ]);
    const response = await request(env, '/stats', { authorization: `Bearer ${env.READ_TOKEN}` });
    assert.deepEqual(await response.json(), {
        row_count: 2,
        oldest_ms: 1000,
        newest_ms: 2000,
        estimated_bytes: Buffer.byteLength(ascii, 'utf8') + Buffer.byteLength(nonAscii, 'utf8'),
        limit_bytes: 500 * 1024 * 1024,
        usage_ratio: 0,
        warn: false,
    });
});

test('stats warn at the configured ratio and fall back to the default when it is invalid', async () => {
    for (const [threshold, expected] of [['0.00000001', true], ['invalid', false], [undefined, false]]) {
        const env = environment([row('existing', 1000)], { WARN_RATIO: threshold });
        if (threshold === undefined) delete env.WARN_RATIO;
        const response = await request(env, '/stats', { authorization: `Bearer ${env.READ_TOKEN}` });
        assert.equal((await response.json()).warn, expected, JSON.stringify(threshold));
    }
});
