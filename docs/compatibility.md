# Compatibility

Everything here comes from the [official ntfy docs](https://docs.ntfy.sh) and black-box testing
against the official server (v2.38.1). No ntfy server source code was used.

**How each row was verified**

| Mark     | Meaning                                                                                                                           |
| -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **D**    | differential test: same request to the official server and to this one, identical normalized response (`test/e2e/compat.test.ts`) |
| **C**    | exercised with the official `ntfy` CLI (`test/e2e/cli.test.ts`)                                                                   |
| **E**    | end-to-end test against the real Worker + DO in local workerd                                                                     |
| **M**    | compared manually against the official server                                                                                     |
| **docs** | implemented from the docs only, not compared                                                                                      |

## Publishing

| Feature                                                                                                                       | Status                                      | Verified          |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ----------------- |
| `PUT`/`POST /<topic>`, body as message, `triggered` when empty, whitespace trimmed                                            | ✅                                          | D, C              |
| Title, priority (numbers and names, case-insensitive), tags                                                                   | ✅                                          | D, C              |
| Click, icon (validated), Markdown (`X-Markdown` or `Content-Type: text/markdown`)                                             | ✅                                          | D                 |
| Every header alias and lowercase query parameter, `\n` in params, RFC 2047 encoded headers                                    | ✅                                          | D                 |
| `GET /<topic>/publish`, `/send`, `/trigger` webhooks                                                                          | ✅                                          | D                 |
| Publish as JSON to `/` (all fields, same errors)                                                                              | ✅                                          | D                 |
| Action buttons: `view`, `http`, `broadcast`, `copy`; short format, `key=value`, quoting, escapes, JSON; max 3; error messages | ✅                                          | D                 |
| Attachments: upload via body, `Filename`, >4 KB or binary body becomes a file, MIME sniffing, `/file/<id>.<ext>`              | ✅                                          | D, C, E           |
| Attachment from URL (`X-Attach`), filename derived from URL                                                                   | ✅                                          | D                 |
| Scheduled delivery: Unix time, RFC 3339, durations (`30m`, `2 days`, `1h30m`), `X-Timezone`, 10 s–3 d limits                  | ✅                                          | D, E              |
| Natural-language times (`10am`, `tomorrow, 3pm`, `friday 9:30`, `5pm tomorrow`, `noon`)                                       | ⚠️ subset                                   | M (see below)     |
| Sequences: `/<topic>/<sid>`, `X-Sequence-ID`, clear (`/clear`, `/read`), delete (`DELETE`, `/delete`)                         | ✅                                          | D                 |
| Updating and canceling scheduled messages by sequence ID                                                                      | ✅                                          | E (docs behavior) |
| `Cache: no`                                                                                                                   | ✅                                          | D                 |
| `X-Poll-ID` (acting as an upstream)                                                                                           | ✅                                          | D                 |
| UnifiedPush `up=1`: binary bodies base64-encoded                                                                              | ✅                                          | D                 |
| Matrix push gateway                                                                                                           | ✅                                          | M, E              |
| Error JSON (`code`, `http`, `error`, `link`) and status codes                                                                 | ✅ for all compared cases                   | D                 |
| `Firebase: no`                                                                                                                | accepted, no-op (there is no Firebase here) | docs              |

## Subscribing

| Feature                                                                                               | Status                                      | Verified                     |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------- |
| `/json` (ndjson), `/sse`, `/raw`, `/ws`, including the `open` event                                   | ✅                                          | D (poll forms), M + E (live) |
| Multiple topics (`/a,b,c/json`), up to 150                                                            | ✅                                          | D, E                         |
| `poll=1`, `since=` (`all`, `latest`, `none`, duration, Unix time, message ID; unknown ID returns all) | ✅                                          | D, E                         |
| `scheduled=1` / `sched=1`                                                                             | ✅                                          | D                            |
| Filters `id`, `message`, `title`, `priority` (OR), `tags` (AND); as headers or query params           | ✅                                          | D, E                         |
| Keepalive events (default 45 s)                                                                       | ✅                                          | E                            |
| WebSocket frames newline-terminated, `sequence_id` always present on WS message events                | ✅ (matches the official server)            | M, E                         |
| SSE: `event:` line only for `open`/`keepalive`/`poll_request`                                         | ✅                                          | M, E                         |
| Raw: one line per message, newlines turned into spaces, empty lines for other events                  | ✅                                          | M, E                         |
| `/<topic>/auth` credential check (used by apps)                                                       | ✅                                          | D                            |
| `X-Messages-Truncated` on oversized replays                                                           | ✅ (cap is 5,000 messages instead of 10 MB) | docs                         |

## Auth

| Feature                                                                                             | Status                                                            | Verified      |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------- |
| Basic `user:pass`, Bearer token, Basic with empty user + token, `?auth=` (raw base64 of the header) | ✅                                                                | D, C, E       |
| Roles `admin`/`user`, ACL with `*` wildcards, `everyone`/`*` user, `rw`/`ro`/`wo`/`deny`            | ✅                                                                | D, E          |
| 401 for bad credentials, 403 for denied topics (anonymous too)                                      | ✅                                                                | D             |
| Config format like `auth-users` / `auth-tokens` / `auth-access`                                     | ✅ but passwords instead of bcrypt hashes                         | —             |
| Token API: `POST`/`PATCH`/`DELETE /v1/account/token` (`label`, `expires`, `X-Token`, self-revoke)   | ✅ with the differences below                                     | D (errors), E |
| `GET /v1/account`                                                                                   | ⚠️ `username`, `role`, `tokens` only (masked), no limits or stats | E             |

## iOS

| Feature                                                                                             | Status                                            | Verified                                                                |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------- |
| `poll_request` forwarding (`NTFY_UPSTREAM_BASE_URL`), topic = SHA-256 of the topic URL, `X-Poll-ID` | ✅, including scheduled messages at delivery time | M (forwarded to a local official server, which accepted and relayed it) |
| End-to-end iOS delivery through ntfy.sh/APNs                                                        | ❓ not tested                                     | —                                                                       |

## Not supported

| Feature                                                                                                 | Why                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Web app** (`/`, `/<topic>` in a browser)                                                              | It's a large separate frontend. Browsers get a short help page instead. The JSON/SSE APIs it would use are supported, so a third-party web client works.                                                                    |
| **Accounts API** beyond tokens (signup, login, password change, reservations, tiers, billing, web push) | Users are configured declaratively; there's no user database to manage. Access tokens are supported (see Auth).                                                                                                             |
| **E-mail notifications, e-mail publishing, phone calls**                                                | They need SMTP or Twilio, which are external services. Requests return the same "not enabled" errors as an official server without them.                                                                                    |
| **Message templates** (`Template: yes`, `?template=github` etc.)                                        | They run Go `text/template` server-side, which can't be reproduced faithfully and is a DoS surface (several of ntfy's recent security fixes are in templating). Requests get a clear 400 instead of a silently raw message. |
| **Firebase (FCM)**                                                                                      | Self-hosted servers don't use FCM for the Android app (instant delivery runs over the app's own connection).                                                                                                                |
| **bcrypt password hashes**                                                                              | Too expensive for the free plan's CPU budget. Store the password as a secret instead.                                                                                                                                       |
| **Prometheus metrics, `/v1/stats`**                                                                     | Use Cloudflare's built-in Workers and Durable Object analytics.                                                                                                                                                             |
| **Per-visitor rate limits** (request buckets, daily message quotas)                                     | The default is private (deny-all), and Cloudflare caps free-plan usage anyway. Body sizes, attachment totals, topics per subscription, title and tag sizes are enforced.                                                    |

## Known differences

- **Natural-language delays** cover common phrases: times (`10am`, `8:30pm`, `noon`,
  `midnight`), `today`/`tomorrow`, weekdays (`friday`, `next mon`) and combinations like
  `tomorrow at 5pm`. The official server uses a general NLP library, so rarer phrasings it
  understands may be rejected here (400). Unix timestamps, RFC 3339 and durations are exact.
  Small differences:
  - `noon` resolves to 12:00:00 here; the official server keeps the current seconds.
  - Timezones default to `NTFY_TIMEZONE` (UTC), not the host's timezone.
- **Retention defaults** are 7 days for messages and 24 h for attachments (official: 12 h and 3 h).
  Both are configurable.
- **Error codes** for some errors with no official equivalent are made up but in the same ranges:
  timezone, tag size, too many topics, templates, storage full, token fields, too many tokens.
- **Access tokens** differ from ntfy's in four deliberate ways:
  - **Stored as SHA-256 hashes.** `GET /v1/account` shows a masked prefix (`tk_abcd…`) and an
    `id` instead of the full token.
  - **Optional limits.** Extension fields `topics` (patterns with `*`) and `permission`
    (`read-write`, `read-only`, `write-only`) limit a token, and `PATCH` can change them later.
    Limited tokens can't create or edit tokens.
  - **No default expiry.** A token without `expires` never expires (official: 72 hours).
  - **Unknown tokens** in `PATCH`/`DELETE` return 404 (official: 500). `DELETE ?id=` is an
    extension used by the `/account` page.
- **`/v1/health`** returns `{"healthy":true}` without the clustering `role` field.
- **The `Incremental: ?1` header** the official server sends on streams isn't sent. Streams send
  `Cache-Control: no-cache, no-transform` and `Content-Encoding: identity` so Cloudflare's edge
  never gzip-buffers them.

## Verification limits

What was tested on real devices and infrastructure, and what wasn't:

1. **The official Android app: verified on one device.** ntfy 1.25.2 (Play build) on Android 15
   (moto g84), against the live deployment. The following worked:
   - adding a user, and the `/<topic>/auth` check when subscribing;
   - titles, tag emojis, priority, and the `view` and `http` action buttons (the `http` button
     POSTed back to the server);
   - image attachments shown as picture notifications;
   - publishing from the app;
   - updating a notification in place, and deleting it from the tray;
   - scheduled delivery;
   - catch-up after the app was force-stopped (`since=<id>`);
   - both JSON-stream and WebSocket modes.

   On WebSockets with the screen off for 5 minutes, the app never reconnected: the server saw only
   its keepalive alarms. The next notification appeared 0.55 s after publishing. Not tested:
   multi-day battery behavior, Doze over hours, network changes, and other app versions.

2. **The iOS app**, beyond confirming that the upstream poll request is accepted by the official
   server.
3. **Production Cloudflare, partly.** A live deployment was tested with `curl`, the official CLI,
   MCP, and a 30-minute WebSocket + JSON stream run.
   - **Confirmed on the live deployment:** auth, publishing, live delivery, scheduling and
     cancellation, attachments up to 14 MB, sequences and keepalives. Hibernation works and edge
     compression doesn't buffer streams. Measured costs are in
     [architecture](architecture.md#cost-model).
   - **Still open:** whether the free plan's 10 ms CPU limit is enforced strictly on large uploads
     and on multi-hour streams.
