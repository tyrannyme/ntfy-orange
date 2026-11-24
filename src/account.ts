import { type Principal, type StoredToken, TOKEN_RE, type TokenPermission, tokenScope } from "./auth";
import { PERMISSIONS, TOPIC_PATTERN } from "./config";
import { errors } from "./errors";
import type { TokenPatch, TokenRef } from "./hub";
import { type Ctx, identify, json } from "./http";
import { readBody } from "./publish";
import { forget } from "./token-cache";
import { nowSeconds, randomId, randomToken, sha256Hex } from "./util";

/**
 * ntfy's account token API (`/v1/account`, `/v1/account/token`), backed by the Durable
 * Object, so tokens can be created and revoked without redeploying. Differences from the
 * official server, all deliberate:
 *  - Tokens are stored hashed, so listings show a masked prefix, never the full token.
 *  - Tokens can be limited to topics and a permission (`topics`, `permission`), and those
 *    limits can be changed later with `PATCH`.
 *  - A token without `expires` never expires (official default: 72 hours).
 *  - Unknown tokens are a 404 (official: 500).
 */

export const MAX_TOKENS_PER_USER = 100;
const MAX_BODY = 16 * 1024;
const MAX_LABEL = 1024;
const MAX_TOPICS = 20;

// ---- Endpoints ------------------------------------------------------------------------

/** GET /v1/account: who am I, and my tokens (masked). */
export async function getAccount(ctx: Ctx): Promise<Response> {
  const user = await identify(ctx);
  if (!user) return json({ username: "*", role: "anonymous" });
  const stored = await ctx.hub.tokenList(user.name);
  const self = user.credential.kind === "token" ? user.credential.id : undefined;
  // A scoped token only sees itself; it shouldn't learn about the account's other tokens.
  const scoped = user.credential.kind === "token" && user.credential.scoped;
  const provisioned = scoped
    ? []
    : [...ctx.config.tokens]
        .filter(([, owner]) => owner.user === user.name)
        .map(([token, owner]) => ({
          token: mask(token),
          ...(owner.label ? { label: owner.label } : {}),
          provisioned: true,
        }));
  return json({
    username: user.name,
    role: user.role,
    provisioned: true,
    tokens: [
      ...provisioned,
      ...stored.filter((t) => !scoped || t.id === self).map((t) => ({ token: mask(t.prefix), ...tokenJson(t) })),
    ],
  });
}

/** POST /v1/account/token: create a token for the caller. */
export async function createToken(ctx: Ctx): Promise<Response> {
  const user = await manager(ctx);
  const body = await readJson(ctx);
  const label = optionalLabel(body.label);
  const expires = optionalExpires(body.expires);
  const topics = optionalTopics(body.topics);
  const permission = optionalPermission(body.permission);

  const token = randomToken();
  const now = nowSeconds();
  const stored: StoredToken = { id: randomId(12), user: user.name, prefix: token.slice(0, 7), created: now };
  if (label) stored.label = label;
  if (expires) stored.expires = expires;
  Object.assign(stored, tokenScope(topics, permission));
  stored.last_access = now;
  const origin = ctx.request.headers.get("cf-connecting-ip");
  if (origin) stored.last_origin = origin;

  const hash = await sha256Hex(token);
  if (!(await ctx.hub.tokenCreate({ ...stored, hash }, MAX_TOKENS_PER_USER))) {
    throw errors.tooManyTokens(MAX_TOKENS_PER_USER);
  }
  return json({ token, ...tokenJson(stored) });
}

/** PATCH /v1/account/token: change a token's label, expiry, topics or permission. */
export async function updateToken(ctx: Ctx): Promise<Response> {
  const user = await manager(ctx);
  const body = await readJson(ctx);
  const ref = await tokenRef(ctx, user, body);
  const patch: TokenPatch = {};
  if (body.label !== undefined) patch.label = optionalLabel(body.label) ?? null;
  if (body.expires !== undefined) patch.expires = optionalExpires(body.expires) ?? null;
  // null resets a limit: every topic, or publish and read.
  if (body.topics !== undefined) patch.topics = optionalTopics(body.topics);
  if (body.permission !== undefined) patch.permission = optionalPermission(body.permission) ?? "read-write";
  const updated = await ctx.hub.tokenUpdate(user.name, ref, patch);
  if (!updated) throw errors.tokenNotFound();
  const { hash, ...stored } = updated;
  forget(hash);
  const token = typeof body.token === "string" ? body.token : mask(stored.prefix);
  return json({ token, ...tokenJson(stored) });
}

/** DELETE /v1/account/token: revoke a token (X-Token, ?id=, or the token used to call this). */
export async function deleteToken(ctx: Ctx): Promise<Response> {
  const user = await identify(ctx);
  if (!user) throw errors.unauthorized();
  const value = ctx.request.headers.get("x-token")?.trim();
  const id = ctx.url.searchParams.get("id") ?? undefined;
  let ref: TokenRef;
  if (value || id) {
    // A scoped token may revoke itself but nothing else.
    if (user.credential.kind === "token" && user.credential.scoped) {
      const self = value ? (await sha256Hex(value)) === user.credential.hash : id === user.credential.id;
      if (!self) throw errors.forbidden();
    }
    ref = await tokenRef(ctx, user, { token: value, id });
  } else if (user.credential.kind === "token") {
    ref = { id: user.credential.id };
  } else if (user.credential.kind === "env-token") {
    throw errors.tokenProvisioned();
  } else {
    throw errors.noToken();
  }
  const hash = await ctx.hub.tokenDelete(user.name, ref);
  if (!hash) throw errors.tokenNotFound();
  forget(hash);
  return json({ success: true });
}

// ---- Helpers --------------------------------------------------------------------------

/** Managing tokens needs a password or an unscoped token: a scoped token can't mint wider ones. */
async function manager(ctx: Ctx): Promise<Principal> {
  const user = await identify(ctx);
  if (!user) throw errors.unauthorized();
  if (user.credential.kind === "token" && user.credential.scoped) throw errors.forbidden();
  return user;
}

async function tokenRef(ctx: Ctx, user: Principal, body: Record<string, unknown>): Promise<TokenRef> {
  if (typeof body.id === "string" && body.id) return { id: body.id };
  if (typeof body.token !== "string" || !body.token) throw errors.noToken();
  const token = body.token.trim();
  const provisioned = ctx.config.tokens.get(token);
  if (provisioned?.user === user.name) throw errors.tokenProvisioned();
  if (!TOKEN_RE.test(token)) throw errors.tokenNotFound();
  return { hash: await sha256Hex(token) };
}

async function readJson(ctx: Ctx): Promise<Record<string, unknown>> {
  const bytes = await readBody(ctx.request, MAX_BODY, errors.messageTooLarge);
  const text = new TextDecoder().decode(bytes).trim();
  if (!text) return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw errors.jsonInvalid();
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw errors.jsonInvalid();
  return body as Record<string, unknown>;
}

function optionalLabel(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw errors.tokenFieldInvalid("label must be a string");
  if (new TextEncoder().encode(v).length > MAX_LABEL) throw errors.tokenFieldInvalid("label is too long");
  return v.trim() || undefined;
}

/** Unix seconds; absent, null or 0 means "never". */
function optionalExpires(v: unknown): number | undefined {
  if (v === undefined || v === null || v === 0) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw errors.tokenFieldInvalid("expires must be a Unix timestamp in seconds (0 = never)");
  }
  return v;
}

function optionalTopics(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  const list = typeof v === "string" ? v.split(",") : v;
  if (!Array.isArray(list) || !list.every((t) => typeof t === "string")) {
    throw errors.tokenFieldInvalid("topics must be a list of topic names or patterns");
  }
  const topics = [...new Set(list.map((t) => t.trim()).filter(Boolean))];
  if (topics.length > MAX_TOPICS) throw errors.tokenFieldInvalid(`at most ${MAX_TOPICS} topics per token`);
  const bad = topics.find((t) => !TOPIC_PATTERN.test(t));
  if (bad !== undefined) throw errors.tokenFieldInvalid(`invalid topic pattern "${bad}"`);
  return topics;
}

const PERMISSION_NAMES: Record<string, TokenPermission> = {};
for (const [name, p] of Object.entries(PERMISSIONS)) {
  if (p.read && p.write) PERMISSION_NAMES[name] = "read-write";
  else if (p.read) PERMISSION_NAMES[name] = "read-only";
  else if (p.write) PERMISSION_NAMES[name] = "write-only";
}

function optionalPermission(v: unknown): TokenPermission | undefined {
  if (v === undefined || v === null) return undefined;
  const p = typeof v === "string" ? PERMISSION_NAMES[v.toLowerCase()] : undefined;
  if (!p) throw errors.tokenFieldInvalid('permission must be "read-write", "read-only" or "write-only"');
  return p;
}

const mask = (token: string) => `${token.slice(0, 7)}…`;

/** Field order follows the official API (label, last_access, last_origin, expires), then extensions. */
function tokenJson(t: StoredToken) {
  return {
    ...(t.label ? { label: t.label } : {}),
    ...(t.last_access ? { last_access: t.last_access } : {}),
    ...(t.last_origin ? { last_origin: t.last_origin } : {}),
    ...(t.expires ? { expires: t.expires } : {}),
    id: t.id,
    created: t.created,
    ...(t.topics?.length ? { topics: t.topics } : {}),
    ...(t.permission ? { permission: t.permission } : {}),
  };
}
