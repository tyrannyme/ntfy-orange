import type { StoredToken, TokenLookup } from "./auth";
import type { Hub } from "./hub";

// Authenticating a stored token needs the Durable Object. Results are cached per isolate
// for a minute, so a busy client costs one DO request per minute, not one per publish.
// Revocation is immediate in the isolate that handled it and takes up to a minute elsewhere.

const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 1000;
const cache = new Map<string, { token: StoredToken | null; until: number }>();

export function tokenLookup(hub: DurableObjectStub<Hub>, origin?: string): TokenLookup {
  return async (hash) => {
    const hit = cache.get(hash);
    if (hit && hit.until > Date.now()) return hit.token;
    const token = await hub.tokenAuth(hash, origin);
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(hash, { token, until: Date.now() + CACHE_TTL_MS });
    return token;
  };
}

export function forget(hash: string | null): void {
  if (hash) cache.delete(hash);
}
