import { DurableObject } from "cloudflare:workers";
import { type Config, loadConfig } from "./config";
import type { Env } from "./env";
import { type Filters, type Message, controlEvent, matchesFilters, serialize } from "./message";
import { type StoredToken, type TokenPermission, tokenScope } from "./auth";
import type { PublishJob } from "./publish";
import type { Since } from "./time";
import { nowSeconds } from "./util";

/** Stored with each hibernatable WebSocket (survives hibernation, max 16 KB). */
export interface Subscription {
  topics: string[];
  filters: Filters;
  /** "ws": a client WebSocket. "stream": the Worker proxying a JSON/SSE/raw HTTP stream. */
  kind: "ws" | "stream";
}

export interface SubscribeRequest extends Subscription {
  since: Since;
  scheduled: boolean;
}

export interface PollQuery {
  topics: string[];
  since: Since;
  scheduled: boolean;
  filters: Filters;
  /** Return at most this many of the newest matching messages. */
  limit?: number;
}

export interface PollResult {
  messages: Message[];
  truncated: boolean;
}

export type PublishResult = { ok: true } | { ok: false; error: "storage_full" };

export interface StoredFile {
  name: string;
  type: string;
  size: number;
  data: Uint8Array;
}

export interface TopicInfo {
  topic: string;
  messages: number;
  last: number;
  subscribers: number;
}

/** A stored token plus the SHA-256 hex of its value (the value itself is never stored). */
export interface NewToken extends StoredToken {
  hash: string;
}

/** Finds a user's token by its value's hash (`X-Token`) or by its ID (the account page). */
export type TokenRef = { hash: string } | { id: string };

/** Fields left out stay as they are. `topics: []` means every topic. */
export interface TokenPatch {
  label?: string | null;
  expires?: number | null;
  topics?: string[];
  permission?: TokenPermission;
}

const MAX_REPLAY = 5000;
const LAST_ACCESS_GRANULARITY = 3600; // update last_access at most hourly (each update is a row write)
const CHUNK_SIZE = 1024 * 1024; // well below the per-row size limit
const PRUNE_EVERY_MS = 5 * 60 * 1000;

/**
 * A single Durable Object holds every topic: message cache (SQLite), uploaded files,
 * and all live subscriptions as hibernatable WebSockets. While nobody is connected and
 * nothing is scheduled it sets no alarm, so an idle server costs nothing.
 */
export class Hub extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly config: Config;
  private lastPrune = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.config = loadConfig(env);
    for (const stmt of SCHEMA) this.sql.exec(stmt);
  }

  // ---- RPC API (called by the Worker) -------------------------------------------

  async publish(job: PublishJob): Promise<PublishResult> {
    const m = job.message;
    const now = nowSeconds();
    this.maybePrune();

    // A new message (or a delete) for a sequence replaces any still-scheduled message of it.
    if (m.sequence_id && (m.event === "message" || m.event === "message_delete")) {
      const old = this.sql
        .exec<{ id: string }>(
          // A message published without a sequence ID is its own sequence (its ID).
          "SELECT id FROM messages WHERE topic = ? AND scheduled = 1 AND (sequence_id = ? OR (sequence_id IS NULL AND id = ?))",
          m.topic,
          m.sequence_id,
          m.sequence_id,
        )
        .toArray();
      for (const { id } of old) this.deleteMessage(id);
    }

    const file = job.file;
    if (file) {
      const used = this.sql
        .exec<{ used: number }>("SELECT COALESCE(SUM(size), 0) AS used FROM files WHERE expires > ?", now)
        .one().used;
      if (used + file.length > this.config.attachmentTotalSizeLimit) return { ok: false, error: "storage_full" };
    }

    const scheduled = job.scheduled === true;
    this.ctx.storage.transactionSync(() => {
      if (file) {
        const a = m.attachment!;
        this.sql.exec(
          "INSERT INTO files (id, expires, name, type, size) VALUES (?, ?, ?, ?, ?)",
          m.id,
          a.expires ?? now + this.config.attachmentExpiry,
          a.name,
          a.type ?? "application/octet-stream",
          file.length,
        );
        for (let i = 0, idx = 0; i < file.length; i += CHUNK_SIZE, idx++) {
          this.sql.exec(
            "INSERT INTO file_chunks (id, idx, data) VALUES (?, ?, ?)",
            m.id,
            idx,
            file.subarray(i, i + CHUNK_SIZE),
          );
        }
      }
      if (job.cache) this.insert(m, scheduled, job.upstreamTopic);
    });
    if (scheduled) await this.ensureAlarm(m.time * 1000);
    else this.deliver(m, job.upstreamTopic);
    return { ok: true };
  }

  async poll(q: PollQuery): Promise<PollResult> {
    this.maybePrune();
    return this.query(q);
  }

  async file(id: string): Promise<StoredFile | null> {
    const meta = this.sql
      .exec<{ name: string; type: string; size: number; expires: number }>(
        "SELECT name, type, size, expires FROM files WHERE id = ?",
        id,
      )
      .toArray()[0];
    if (!meta || meta.expires <= nowSeconds()) return null;
    const data = new Uint8Array(meta.size);
    let offset = 0;
    for (const row of this.sql.exec<{ data: ArrayBuffer }>(
      "SELECT data FROM file_chunks WHERE id = ? ORDER BY idx",
      id,
    )) {
      const chunk = new Uint8Array(row.data);
      if (offset + chunk.length > meta.size) return null;
      data.set(chunk, offset);
      offset += chunk.length;
    }
    if (offset !== meta.size) return null;
    return { name: meta.name, type: meta.type, size: meta.size, data };
  }

  async topics(): Promise<TopicInfo[]> {
    const subscribers = new Map<string, number>();
    for (const ws of this.ctx.getWebSockets()) {
      for (const t of this.subscription(ws)?.topics ?? []) subscribers.set(t, (subscribers.get(t) ?? 0) + 1);
    }
    const rows = this.sql
      .exec<{ topic: string; n: number; last: number }>(
        "SELECT topic, COUNT(*) AS n, MAX(time) AS last FROM messages WHERE scheduled = 0 AND expires > ? GROUP BY topic",
        nowSeconds(),
      )
      .toArray();
    const result = new Map<string, TopicInfo>(
      rows.map((r) => [r.topic, { topic: r.topic, messages: r.n, last: r.last, subscribers: 0 }]),
    );
    for (const [topic, n] of subscribers) {
      const info = result.get(topic) ?? { topic, messages: 0, last: 0, subscribers: 0 };
      info.subscribers = n;
      result.set(topic, info);
    }
    return [...result.values()].sort((a, b) => b.last - a.last);
  }

  // ---- Access tokens (created through /v1/account/token) ---------------------------

  async tokenCreate(token: NewToken, maxPerUser: number): Promise<boolean> {
    const count = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM tokens WHERE user = ?", token.user).one().n;
    if (count >= maxPerUser) return false;
    this.sql.exec(
      `INSERT INTO tokens (id, hash, user, prefix, label, topics, permission, created, expires, last_access, last_origin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      token.id,
      token.hash,
      token.user,
      token.prefix,
      token.label ?? null,
      token.topics?.length ? JSON.stringify(token.topics) : null,
      token.permission ?? null,
      token.created,
      token.expires ?? null,
      token.last_access ?? null,
      token.last_origin ?? null,
    );
    return true;
  }

  /** Used by the Worker to authenticate a token (on a cache miss). */
  async tokenAuth(hash: string, origin?: string): Promise<StoredToken | null> {
    const row = this.sql.exec<TokenRow>("SELECT * FROM tokens WHERE hash = ?", hash).toArray()[0];
    if (!row) return null;
    const now = nowSeconds();
    if (row.expires && row.expires <= now) return null;
    if (!row.last_access || now - row.last_access >= LAST_ACCESS_GRANULARITY) {
      row.last_access = now;
      row.last_origin = origin ?? row.last_origin;
      this.sql.exec("UPDATE tokens SET last_access = ?, last_origin = ? WHERE id = ?", now, row.last_origin, row.id);
    }
    return toStoredToken(row);
  }

  async tokenList(user: string): Promise<StoredToken[]> {
    return this.sql
      .exec<TokenRow>("SELECT * FROM tokens WHERE user = ? ORDER BY created, id", user)
      .toArray()
      .map(toStoredToken);
  }

  /** Returns the token's hash too, so the Worker can drop it from its cache. */
  async tokenUpdate(user: string, ref: TokenRef, patch: TokenPatch): Promise<(StoredToken & { hash: string }) | null> {
    const row = this.findToken(user, ref);
    if (!row) return null;
    if (patch.label !== undefined) row.label = patch.label;
    if (patch.expires !== undefined) row.expires = patch.expires;
    if (patch.topics !== undefined || patch.permission !== undefined) {
      const current = toStoredToken(row);
      const scope = tokenScope(patch.topics ?? current.topics ?? [], patch.permission ?? current.permission);
      row.topics = scope.topics ? JSON.stringify(scope.topics) : null;
      row.permission = scope.permission ?? null;
    }
    this.sql.exec(
      "UPDATE tokens SET label = ?, expires = ?, topics = ?, permission = ? WHERE id = ?",
      row.label,
      row.expires,
      row.topics,
      row.permission,
      row.id,
    );
    return { ...toStoredToken(row), hash: row.hash };
  }

  /** Returns the deleted token's hash, so the Worker can drop it from its cache. */
  async tokenDelete(user: string, ref: TokenRef): Promise<string | null> {
    const row = this.findToken(user, ref);
    if (!row) return null;
    this.sql.exec("DELETE FROM tokens WHERE id = ?", row.id);
    return row.hash;
  }

  private findToken(user: string, ref: TokenRef): TokenRow | undefined {
    const [column, value] = "hash" in ref ? ["hash", ref.hash] : ["id", ref.id];
    return this.sql.exec<TokenRow>(`SELECT * FROM tokens WHERE user = ? AND ${column} = ?`, user, value).toArray()[0];
  }

  // ---- Subscriptions -----------------------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return new Response("expected websocket", { status: 426 });
    const req = JSON.parse(request.headers.get("x-ntfy-subscribe") ?? "null") as SubscribeRequest | null;
    if (!req) return new Response("missing subscription", { status: 400 });

    const { 0: client, 1: server } = new WebSocketPair();
    const sub: Subscription = { topics: req.topics, filters: req.filters, kind: req.kind };
    try {
      server.serializeAttachment(sub); // max 16 KB; the Worker caps the size, this is a backstop
    } catch {
      return new Response("subscription too large", { status: 400 });
    }
    this.ctx.acceptWebSocket(server);
    // No awaits between the replay query and acceptWebSocket: a message published
    // meanwhile is either in the replay or delivered live, never lost or duplicated.
    this.send(server, sub, controlEvent("open", sub.topics));
    const { messages } = this.query({
      topics: req.topics,
      since: req.since,
      scheduled: req.scheduled,
      filters: req.filters,
    });
    for (const m of messages) this.send(server, sub, m);
    await this.ensureAlarm(Date.now() + this.config.keepaliveInterval * 1000);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(): Promise<void> {
    // Subscribers have nothing to say; ignore anything they send.
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // already closed
    }
  }

  // ---- Alarm: scheduled delivery + keepalives ------------------------------------------

  override async alarm(): Promise<void> {
    const now = nowSeconds();
    const due = this.sql
      .exec<{ id: string; json: string; upstream: string | null }>(
        "SELECT id, json, upstream FROM messages WHERE scheduled = 1 AND time <= ? ORDER BY time, seq",
        now,
      )
      .toArray();
    for (const row of due) {
      const m = JSON.parse(row.json) as Message;
      // Re-insert so the message gets a fresh `seq`: replay order is delivery order, and a
      // client resuming with since=<id of something delivered earlier> must still get it.
      this.ctx.storage.transactionSync(() => {
        this.sql.exec("DELETE FROM messages WHERE id = ?", row.id);
        this.insert(m, false, row.upstream ?? undefined);
      });
      this.deliver(m, row.upstream ?? undefined);
    }
    for (const ws of this.ctx.getWebSockets()) {
      const sub = this.subscription(ws);
      if (sub) this.send(ws, sub, controlEvent("keepalive", sub.topics));
    }
    this.maybePrune();
    await this.scheduleNextAlarm();
  }

  private async scheduleNextAlarm(): Promise<void> {
    const nextScheduled = this.sql
      .exec<{ t: number | null }>("SELECT MIN(time) AS t FROM messages WHERE scheduled = 1")
      .one().t;
    const candidates: number[] = [];
    if (nextScheduled !== null) candidates.push(nextScheduled * 1000);
    if (this.ctx.getWebSockets().length > 0) candidates.push(Date.now() + this.config.keepaliveInterval * 1000);
    if (candidates.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.min(...candidates));
  }

  private async ensureAlarm(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  // ---- Internals -------------------------------------------------------------------------

  private insert(m: Message, scheduled: boolean, upstreamTopic?: string): void {
    this.sql.exec(
      "INSERT INTO messages (id, topic, time, expires, scheduled, sequence_id, upstream, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      m.id,
      m.topic,
      m.time,
      m.expires ?? m.time,
      scheduled ? 1 : 0,
      m.sequence_id ?? null,
      upstreamTopic ?? null,
      serialize(m),
    );
  }

  private deliver(m: Message, upstreamTopic?: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      const sub = this.subscription(ws);
      if (sub?.topics.includes(m.topic) && matchesFilters(m, sub.filters)) this.send(ws, sub, m);
    }
    if (upstreamTopic && this.config.upstreamBaseUrl) this.ctx.waitUntil(this.forwardUpstream(m, upstreamTopic));
  }

  private send(ws: WebSocket, sub: Subscription, m: Message): void {
    // The official server always includes sequence_id on WebSocket message events.
    const out = sub.kind === "ws" && m.event === "message" && !m.sequence_id ? { ...m, sequence_id: m.id } : m;
    try {
      ws.send(serialize(out) + "\n");
    } catch {
      // Socket is closing; webSocketClose will clean up.
    }
  }

  private subscription(ws: WebSocket): Subscription | undefined {
    try {
      return (ws.deserializeAttachment() as Subscription | null) ?? undefined;
    } catch {
      return undefined;
    }
  }

  private query(q: PollQuery): PollResult {
    const now = nowSeconds();
    const topics = JSON.stringify([...new Set(q.topics)]);
    const sched = q.scheduled ? 1 : 0;
    let rows: { json: string }[];
    const base =
      "FROM messages WHERE topic IN (SELECT value FROM json_each(?)) AND expires > ? AND (scheduled = 0 OR ? = 1)";
    switch (q.since.kind) {
      case "none":
        return { messages: [], truncated: false };
      case "latest":
        rows = this.sql
          .exec<{ json: string }>(
            `SELECT json FROM (SELECT json, seq, ROW_NUMBER() OVER (PARTITION BY topic ORDER BY seq DESC) AS rn ${base}) WHERE rn = 1 ORDER BY seq`,
            topics,
            now,
            sched,
          )
          .toArray();
        break;
      case "id": {
        const ref = this.sql.exec<{ seq: number }>("SELECT seq FROM messages WHERE id = ?", q.since.id).toArray()[0];
        rows = ref
          ? this.newest(`${base} AND seq > ?`, [topics, now, sched, ref.seq])
          : this.newest(base, [topics, now, sched]);
        break;
      }
      case "time":
        rows = this.newest(`${base} AND time >= ?`, [topics, now, sched, q.since.time]);
        break;
      case "all":
        rows = this.newest(base, [topics, now, sched]);
        break;
    }
    let messages = rows.map((r) => JSON.parse(r.json) as Message).filter((m) => matchesFilters(m, q.filters));
    let truncated = messages.length > MAX_REPLAY;
    if (truncated) messages = messages.slice(-MAX_REPLAY);
    if (q.limit !== undefined && messages.length > q.limit) {
      messages = messages.slice(-q.limit);
      truncated = true;
    }
    return { messages, truncated };
  }

  private newest(where: string, params: (string | number)[]): { json: string }[] {
    return this.sql
      .exec<{ json: string }>(`SELECT json ${where} ORDER BY seq DESC LIMIT ?`, ...params, MAX_REPLAY + 1)
      .toArray()
      .reverse();
  }

  private deleteMessage(id: string): void {
    this.sql.exec("DELETE FROM messages WHERE id = ?", id);
    this.sql.exec("DELETE FROM file_chunks WHERE id = ?", id);
    this.sql.exec("DELETE FROM files WHERE id = ?", id);
  }

  private maybePrune(): void {
    if (Date.now() - this.lastPrune < PRUNE_EVERY_MS) return;
    this.lastPrune = Date.now();
    const now = nowSeconds();
    this.sql.exec("DELETE FROM messages WHERE expires <= ? AND scheduled = 0", now);
    this.sql.exec("DELETE FROM file_chunks WHERE id IN (SELECT id FROM files WHERE expires <= ?)", now);
    this.sql.exec("DELETE FROM files WHERE expires <= ?", now);
    this.sql.exec("DELETE FROM tokens WHERE expires IS NOT NULL AND expires <= ?", now);
  }

  private async forwardUpstream(m: Message, upstreamTopic: string): Promise<void> {
    const headers: Record<string, string> = { "X-Poll-ID": m.id };
    if (this.config.upstreamAccessToken) headers.Authorization = `Bearer ${this.config.upstreamAccessToken}`;
    try {
      await fetch(`${this.config.upstreamBaseUrl}/${upstreamTopic}`, { method: "POST", headers, body: "New message" });
    } catch (err) {
      console.warn("upstream poll request failed", err);
    }
  }
}

interface TokenRow extends Record<string, SqlStorageValue> {
  id: string;
  hash: string;
  user: string;
  prefix: string;
  label: string | null;
  topics: string | null;
  permission: string | null;
  created: number;
  expires: number | null;
  last_access: number | null;
  last_origin: string | null;
}

function toStoredToken(r: TokenRow): StoredToken {
  const t: StoredToken = { id: r.id, user: r.user, prefix: r.prefix, created: r.created };
  if (r.label !== null) t.label = r.label;
  if (r.topics !== null) t.topics = JSON.parse(r.topics) as string[];
  if (r.permission !== null) t.permission = r.permission as StoredToken["permission"];
  if (r.expires !== null) t.expires = r.expires;
  if (r.last_access !== null) t.last_access = r.last_access;
  if (r.last_origin !== null) t.last_origin = r.last_origin;
  return t;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    topic TEXT NOT NULL,
    time INTEGER NOT NULL,
    expires INTEGER NOT NULL,
    scheduled INTEGER NOT NULL DEFAULT 0,
    sequence_id TEXT,
    upstream TEXT,
    json TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS messages_topic_seq ON messages (topic, seq)",
  "CREATE INDEX IF NOT EXISTS messages_expires ON messages (expires)",
  "CREATE INDEX IF NOT EXISTS messages_scheduled ON messages (scheduled, time)",
  `CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    expires INTEGER NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    size INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS file_chunks (
    id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (id, idx)
  )`,
  // Access tokens created through the API. Only a SHA-256 hash of each token is stored.
  `CREATE TABLE IF NOT EXISTS tokens (
    id TEXT PRIMARY KEY,
    hash TEXT NOT NULL UNIQUE,
    user TEXT NOT NULL,
    prefix TEXT NOT NULL,
    label TEXT,
    topics TEXT,
    permission TEXT,
    created INTEGER NOT NULL,
    expires INTEGER,
    last_access INTEGER,
    last_origin TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS tokens_user ON tokens (user)",
];
