# Contributing

ntfy-orange is an ntfy-compatible server that runs on one Cloudflare Worker and one SQLite-backed
Durable Object. The goal is to behave like the official server for real clients while staying
inside the Workers Free plan.

## What fits

- Compatibility fixes: anything a real ntfy client, script or integration does that works against
  the official server and doesn't work here.
- Bug fixes in publishing, subscriptions, scheduling, auth, tokens and the MCP endpoint.
- Lower cost: fewer Durable Object wakeups, rows written or CPU per request.
- Docs that are wrong or out of date.

Probably out of scope: the ntfy web app, e-mail and phone call features, message templates, and
anything that needs a paid plan or an external service. [docs/compatibility.md](docs/compatibility.md#not-supported)
explains why. Open an issue first if you want to argue for one of them.

## Setup

You need [Bun](https://bun.sh) and Node.js (for `wrangler`).

```sh
bun install
cp .dev.vars.example .dev.vars   # then set a real password in it
bun run dev
```

## Checks

CI runs these on every pull request. Run them before you push:

```sh
bun run fmt:check   # oxfmt (bun run fmt to fix)
bun run lint        # oxlint
bun run check       # TypeScript, src and tests
bun test            # unit + end-to-end against local workerd
```

The end-to-end suite boots `wrangler dev` on its own. Two more suites compare this server with the
official one and only run when you point them at it:

```sh
scripts/reference-server.sh &
NTFY_REF_URL=http://127.0.0.1:2586 NTFY_BIN=~/.cache/ntfy-orange-ref/ntfy bun test
```

Run them if your change touches anything a client can see: status codes, headers, JSON fields or
their order, stream formats, or error messages. If you add behavior the official server has, add a
case to `test/e2e/compat.test.ts` so the comparison covers it.

## Pull requests

- Keep each pull request to one change, with tests for it.
- Say how you verified it, especially for anything only checkable on a device or a live deployment.
- Update [docs/compatibility.md](docs/compatibility.md) when compatibility changes, and
  [docs/architecture.md](docs/architecture.md) when the design or the cost model changes.
- This is a clean-room implementation. Work from the [ntfy docs](https://docs.ntfy.sh) and from
  black-box behavior of the official server, not from its source code.

Report security issues through the [security policy](SECURITY.md), not a public issue.
