import { type Config, type Permission, PERMISSIONS, type User, patternRegex } from "./config";
import { errors } from "./errors";
import { base64ToString, nowSeconds, sha256Hex } from "./util";

/**
 * What a token created through the API is limited to (an extension; ntfy tokens have no
 * scope). `topics` are patterns with `*` wildcards; empty means every topic the user can
 * access. "Read-write on every topic" is no limit at all, so it's stored as no scope.
 */
export function tokenScope(topics: string[], permission?: TokenPermission): Pick<StoredToken, "topics" | "permission"> {
  const perm = permission ?? "read-write";
  if (!topics.length && perm === "read-write") return {};
  return topics.length ? { topics, permission: perm } : { permission: perm };
}

export type TokenPermission = "read-write" | "read-only" | "write-only";

/** A token stored in the Durable Object, as the Worker sees it (never the token itself). */
export interface StoredToken {
  id: string;
  user: string;
  prefix: string;
  label?: string;
  topics?: string[];
  permission?: TokenPermission;
  created: number;
  expires?: number;
  last_access?: number;
  last_origin?: string;
}

/** Looks a stored token up by the SHA-256 hex of its value (null if unknown). */
export type TokenLookup = (hash: string) => Promise<StoredToken | null>;

/** How the caller proved who they are; account endpoints treat these differently. */
export type Credential =
  | { kind: "password" }
  | { kind: "env-token" }
  | { kind: "token"; id: string; hash: string; scoped: boolean };

export interface Principal extends User {
  credential: Credential;
  scope?: { regexes: RegExp[]; perm: Permission };
}

export type Identity = Principal | undefined; // undefined = anonymous ("everyone")

export const TOKEN_RE = /^tk_[A-Za-z0-9]{29}$/;

/**
 * Resolves the caller from `Authorization` (Basic user:pass, Basic :token, Bearer token)
 * or the `?auth=` query parameter (raw base64 of the Authorization header value).
 * Wrong credentials are a 401, never a silent downgrade to anonymous.
 */
export async function authenticate(
  headers: Headers,
  url: URL,
  config: Config,
  lookup?: TokenLookup,
): Promise<Identity> {
  let header = headers.get("authorization");
  const param = url.searchParams.get("auth");
  if (!header && param) {
    header = base64ToString(param) ?? null;
    if (header === null) throw errors.unauthorized();
  }
  if (!header) return undefined;

  const [scheme, ...rest] = header.trim().split(/\s+/);
  const value = rest.join(" ");
  if (scheme?.toLowerCase() === "bearer") return userForToken(value, config, lookup);
  if (scheme?.toLowerCase() === "basic") {
    const decoded = base64ToString(value);
    const sep = decoded?.indexOf(":") ?? -1;
    if (decoded === undefined || sep < 0) throw errors.unauthorized();
    const name = decoded.slice(0, sep);
    const secret = decoded.slice(sep + 1);
    if (name === "") return userForToken(secret, config, lookup);
    const user = config.users.get(name);
    // Always run the comparison so timing doesn't reveal whether the user exists.
    const ok = await safeEqual(secret, user?.password ?? "\u0000invalid");
    if (!user || !ok) throw errors.unauthorized();
    return { ...user, credential: { kind: "password" } };
  }
  throw errors.unauthorized();
}

async function userForToken(token: string, config: Config, lookup?: TokenLookup): Promise<Principal> {
  // Tokens from NTFY_AUTH_TOKENS: compared in constant time, every entry checked.
  let match: string | undefined;
  for (const [candidate, owner] of config.tokens) {
    if (await safeEqual(token, candidate)) match = owner.user;
  }
  if (match) {
    const user = config.users.get(match);
    if (user) return { ...user, credential: { kind: "env-token" } };
  }
  // Tokens created through the API live in the Durable Object, hashed. Looking up the hash
  // of a 29-character random secret leaks nothing useful, so no constant-time loop is needed.
  if (!lookup || !TOKEN_RE.test(token)) throw errors.unauthorized();
  const hash = await sha256Hex(token);
  const stored = await lookup(hash);
  if (!stored || (stored.expires && stored.expires <= nowSeconds())) throw errors.unauthorized();
  // A token outlives nothing: if its user is removed from NTFY_AUTH_USERS, it stops working.
  const user = config.users.get(stored.user);
  if (!user) throw errors.unauthorized();
  const scoped = stored.permission !== undefined || (stored.topics?.length ?? 0) > 0;
  return {
    ...user,
    credential: { kind: "token", id: stored.id, hash, scoped },
    scope: scoped
      ? {
          regexes: (stored.topics?.length ? stored.topics : ["*"]).map(patternRegex),
          perm: PERMISSIONS[stored.permission ?? "read-write"]!,
        }
      : undefined,
  };
}

/** Constant-time string comparison (compares SHA-256 digests, so lengths can differ). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const xa = new Uint8Array(x);
  const ya = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < xa.length; i++) diff |= xa[i]! ^ ya[i]!;
  return diff === 0;
}

/** A scoped token can only narrow what its user may do, never widen it. */
export function can(config: Config, user: Identity, topic: string, perm: "read" | "write"): boolean {
  if (user?.scope && (!user.scope.perm[perm] || !user.scope.regexes.some((r) => r.test(topic)))) return false;
  if (user?.role === "admin") return true;
  for (const entry of config.access) {
    if ((entry.user === user?.name || entry.user === "*") && entry.regex.test(topic)) return entry.perm[perm];
  }
  return config.defaultAccess[perm];
}

/** Like the official server, a denied topic is a 403 for anonymous and authenticated callers alike. */
export function authorize(config: Config, user: Identity, topics: string[], perm: "read" | "write"): void {
  for (const topic of topics) {
    if (!can(config, user, topic, perm)) throw errors.forbidden();
  }
}
