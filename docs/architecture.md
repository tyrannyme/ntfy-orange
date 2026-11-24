# Architecture

ntfy-orange takes the official ntfy server as a **behavioral** reference only. The design starts
from Cloudflare's execution and billing model: pay per request and per second awake, objects that
can sleep while holding connections open, and a 10 ms CPU budget per Worker request on the free
plan.

```
                       ┌──────────────────────────── Cloudflare ─────────────────────────────┐
 publish (HTTP)  ────▶ │  Worker (stateless)              Durable Object "hub" (one, global) │
 poll (HTTP)     ────▶ │  · routing, ntfy param parsing   · SQLite: messages, files          │
                       │  · auth + ACL (from secrets)  ─▶ · fan-out to subscribers           │
 WebSocket       ════▶ │  · upgrade forwarded as-is ═════▶ · hibernatable WebSockets         │
 JSON/SSE/raw    ◀──── │  · stream proxy  ◀══ ws ═══════  · one alarm: scheduled delivery,   │
 stream                │    (DO side hibernates)            keepalives, nothing when idle    │
                       └─────────────────────────────────────────────────────────────────────┘
```

## Components

| File                                                            | Role                                                                                                |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `src/index.ts`                                                  | Worker entry point: routes, publish/subscribe handlers, stream proxy, file download, Matrix gateway |
| `src/hub.ts`                                                    | The Durable Object: storage, replay queries, live fan-out, alarm scheduling, pruning                |
| `src/publish.ts`                                                | Turns headers/query/JSON/MCP input into a message (one builder for every path)                      |
| `src/auth.ts`, `src/config.ts`                                  | Users, tokens, ACL, settings parsed from env (cached per isolate)                                   |
| `src/actions.ts`, `src/time.ts`, `src/mime.ts`, `src/params.ts` | Action-button parser, delay/since parsing, content sniffing, header/query parameters                |
| `src/format.ts`, `src/message.ts`                               | Wire formats (JSON, SSE, raw) with the official field order                                         |
| `src/account.ts`, `src/account-page.ts`, `src/token-cache.ts`   | Token API (`/v1/account/token`), the `/account` page, per-isolate token cache                       |
| `src/mcp.ts`                                                    | Stateless MCP server (JSON-RPC over Streamable HTTP)                                                |

## Key decisions

### One Durable Object for everything

Every topic lives in a single SQLite-backed Durable Object named `hub`. That's deliberate:

- **Clients subscribe to many topics on one connection.** The Android app, CLI and web clients use
  `/<t1>,<t2>,.../ws`. With one object per topic, a single connection would need to fan in from
  many objects. That means extra connections, extra wakeups and cross-object ordering problems.
  With one hub, a multi-topic subscription is just a filter.
- **Replay is consistent.** A new subscriber's catch-up query and its registration for live
  messages run in the same synchronous turn of a single-threaded object, with no `await` between
  them. Nothing published in between can be lost or duplicated.
- **One alarm covers everything.** Keepalives and scheduled messages share one timer instead of
  one per topic.

The cost is a throughput ceiling of roughly 1,000 requests per second per object, Cloudflare's soft
limit. That's orders of magnitude above personal or small-team use. Sharding by topic would be the
next step if it ever mattered. The trade-off is documented rather than engineered away.

### Subscriptions are hibernatable WebSockets

Durable Objects bill wall-clock time while they're in memory, unless they're idle with only
hibernatable WebSockets open. Then they can be evicted while the sockets stay connected. Cloudflare
doesn't bill duration for an idle object that is eligible to hibernate, and protocol-level pings
are answered without waking it.

- **Client WebSockets** (`/<topics>/ws`): the Worker authenticates, then forwards the upgrade. The
  DO accepts the socket with `ctx.acceptWebSocket()` and stores the subscription (topics + filters)
  in the socket's serialized attachment, so it survives eviction.
- **HTTP streams** (`/json`, `/sse`, `/raw`): a streaming response held by the Durable Object
  would keep it awake for the life of the connection. One always-open phone stream would use about
  10,800 of the 13,000 free GB-s per day. Instead, the **Worker** holds the client's HTTP response
  and opens a WebSocket to the DO, which hibernates on its side. The Worker turns each event into
  the requested format. Workers bill CPU time, not wall-clock time, so waiting costs nothing.

Verified locally: with a subscriber connected, the DO constructor ran again at every keepalive
(the object had been evicted in between), and the subscriber saw an unbroken stream. This was
checked in `workerd` via `wrangler dev`, for both WebSocket and proxied JSON subscribers.

### One alarm, set only when needed

A Durable Object has a single alarm. On every wakeup the hub computes the next deadline:

```
next = min(earliest scheduled message, now + keepalive interval if any socket is open)
```

If neither exists, the alarm is deleted. An idle server with no subscribers and nothing scheduled
never runs. When the last subscriber leaves, the next alarm sees no sockets and stops rescheduling
itself.

The alarm handler delivers due scheduled messages (and forwards their iOS poll requests), sends a
`keepalive` event to every socket, and prunes expired rows.

### Keepalives

The Android app reconnects if it hears nothing for 77 seconds (per the ntfy docs), so the server
must send something periodically. The default is 45 seconds, the same as ntfy. Each keepalive
wakes the hub for a few milliseconds. Intermediaries don't need more: the Worker-to-DO and
client-to-edge legs are both Cloudflare-managed.

### Storage

```sql
messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, topic, time, expires,
          scheduled, sequence_id, upstream, json)          -- json: the exact wire form
files    (id PRIMARY KEY, expires, name, type, size)       -- id = message id
file_chunks (id, idx, data BLOB)                           -- 1 MB chunks
tokens   (id, hash UNIQUE, user, label, topics, permission, expires, last_access, ...)
```

- **Ordering:** replay order is `seq`, which is delivery order. A scheduled message is re-inserted
  with a fresh `seq` when the alarm delivers it. That way, a client resuming with `since=<id>` of
  anything delivered before it still receives it, even if the alarm ran late or something was
  published in the same second. For immediate messages this is the same as the official server's
  time order.
- **`since=<id>`:** returns the messages with a higher `seq` than that message. An unknown ID
  returns the whole cache (official behavior). `since=latest` uses a window function to return the
  newest message per topic.
- **Atomic writes:** a message and its file chunks are written in one `transactionSync`, so a
  failed upload never leaves a half-stored file behind.
- **Topic lists** are passed as one JSON parameter and expanded with `json_each`. Durable Object
  SQL allows at most 100 bound parameters, and a subscription may have up to 150 topics.
- **Clear and delete events are stored as their own messages.** ntfy's update model is
  append-only, so a phone that was offline replays them. A new message or delete for a sequence
  also removes any still-_scheduled_ message of that sequence (watchdog / dead man's switch
  pattern).
- **Pruning** runs at most every 5 minutes, piggybacking on publishes, polls and alarms. Expired
  messages and files are deleted by indexed range deletes. Expired files return 404 even before
  they're pruned.
- **Replays are capped** at the newest 5,000 messages, with `X-Messages-Truncated: 1`, like
  ntfy's response cap.

Attachments live in the Durable Object's SQLite database rather than R2, because R2 needs a
payment method on file even for its free tier. The 250 MB default total cap keeps them well inside
the free 5 GB.

## Cost model

These are free-plan limits as documented by Cloudflare in November 2026. The table below gives
estimates from the design. Measurements from a live deployment follow it.

| Event                                             | Worker req | DO req | DO duration    | Rows written                                |
| ------------------------------------------------- | ---------- | ------ | -------------- | ------------------------------------------- |
| Publish                                           | 1          | 1      | ms             | ~5 (row + indexes; more with an attachment) |
| Poll / reconnect                                  | 1          | 1      | ms             | 0                                           |
| Keepalive tick (only while someone is subscribed) | 0          | 1      | ms             | 1 (`setAlarm`)                              |
| Idle subscriber between ticks                     | 0          | 0      | 0 (hibernated) | 0                                           |
| Nobody subscribed, nothing scheduled              | 0          | 0      | 0              | 0                                           |

At the default 45 s interval, an always-connected phone costs 1,920 DO requests and 1,920 row
writes a day. That's about 2% of each free daily allowance. Incoming WebSocket messages would be
billed at 20:1, but ntfy clients don't send any.

**Measured on a live deployment (November 2026).** One WebSocket and one JSON stream subscriber
were held open for 30 minutes, with a burst of test traffic at the start: about 20 publishes,
several polls, and uploads of 0.2, 3, 8 and 14 MB. Numbers come from Cloudflare's GraphQL
analytics and `wrangler tail`:

| Metric                                          | Result                                                       |
| ----------------------------------------------- | ------------------------------------------------------------ |
| Keepalives                                      | 40 on each connection, exactly 45 s apart; no disconnects    |
| DO duration, whole 40-minute window             | 1.6 GB-s (free: 13,000 per day)                              |
| DO active time                                  | 12 s in 40 minutes. The object slept between events.         |
| Keepalive alarm                                 | 0 ms CPU, about 28 ms wall time each                         |
| DO rows written                                 | 226, including the publishes and attachment chunks           |
| Worker CPU, publish / poll                      | 0–4 ms                                                       |
| Worker CPU, the 30-minute JSON stream, in total | 3.1 ms                                                       |
| Worker CPU, uploads                             | 16 ms (3 MB), 53 ms (8 MB), 73 ms (14 MB): about 5 ms per MB |

**Still open:** whether the free plan's 10 ms CPU limit is enforced strictly.

- **Uploads:** large uploads exceeded it and still succeeded, with no `exceededCpu` errors.
  Cloudflare may tolerate occasional overruns, or the account used for the test may not be on the
  free plan.
- **Long streams:** a JSON/SSE/raw stream uses about 6 ms of CPU an hour. If that is counted
  against the 10 ms limit, a stream could be cut after an hour or two. The client then reconnects
  with `since=` and loses nothing. WebSocket subscribers aren't affected, because their socket
  terminates at the DO, not in the Worker. This is another reason to prefer WebSockets in the
  Android app.

## Security

- **Deny-all by default.** Anonymous users get nothing unless `NTFY_AUTH_ACCESS` or
  `NTFY_AUTH_DEFAULT_ACCESS` says otherwise. Bad credentials always return 401; they never fall
  back to anonymous.
- **Credentials live in Worker secrets**, which are encrypted at rest and can't be read back
  through the dashboard or API. Passwords are compared in constant time by comparing SHA-256
  digests, and the unknown-user path does the same work.
  - bcrypt hashes (ntfy's format) are rejected with an explanation. Verifying bcrypt costs about
    50–100 ms of CPU, far over the free plan's 10 ms per request.
  - There is no per-IP login throttle: in-isolate counters are trivially bypassed, and a global
    one would add a DO round-trip to every request. Instead, passwords must be at least 12
    characters. Since a free-plan Worker serves at most 100k requests a day, online guessing is
    hopeless. Tokens are 32 random characters.
- **API tokens** (`/account`, `/v1/account/token`) live in the Durable Object's SQLite.
  - **Hashing:** only the SHA-256 of each token is stored. A token is 29 random characters, so a
    fast hash is enough; bcrypt-style slowness only matters for guessable passwords.
  - **Lookup cost:** the Worker caches lookups per isolate for 60 seconds, so a busy client costs
    one DO request a minute, not one per publish.
  - **Revocation and edits** are immediate in the isolate that handled them and take up to 60 s
    elsewhere. Open subscriptions authorized before a change stay open until they reconnect,
    as in ntfy.
  - **Limits:** a limited token can only narrow its user's access, and can't mint or edit tokens.
  - **Removed users:** removing a user from `NTFY_AUTH_USERS` disables all of their tokens.
- **The Durable Object is unreachable from the internet.** Only the Worker's binding can call it.
  Every authorization decision happens in the Worker before the DO is touched, and the internal
  subscription header is built by the Worker, never copied from the client.
- **Attachments use capability URLs** (12 random characters), like ntfy, so phones can download
  them without credentials. They're served with `Content-Disposition: attachment`,
  `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`, so an uploaded HTML
  file can't run on your origin.
- **The help page** escapes everything and is served with a strict CSP. It reveals nothing about
  configuration, users or topics.
- **Abuse limits:** body size limits are enforced while streaming the body, before buffering. There
  is also a global attachment quota, at most 150 topics per subscription, 1 KB titles, 512 B of tags
  and 3 actions. An attacker can still spend your free daily request quota; that applies to any
  public Worker. Cloudflare WAF rate-limiting rules on a custom domain are the remedy if it
  matters.

## Scaling limits

| Limit                   | Value                                                             | Why                                                     |
| ----------------------- | ----------------------------------------------------------------- | ------------------------------------------------------- |
| Throughput              | ~1,000 req/s                                                      | single Durable Object                                   |
| Concurrent subscribers  | thousands (Cloudflare allows 32k hibernatable sockets per object) | fan-out is a loop over sockets                          |
| Topics per subscription | 150                                                               | same as ntfy; the 16 KB socket attachment limit         |
| Attachment size         | 15 MB default, 100 MB max                                         | Worker request body limit; files are buffered in memory |
| Message replay          | newest 5,000 per request                                          | response size                                           |
