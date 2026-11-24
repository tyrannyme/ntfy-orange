const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Random [A-Za-z0-9] string; ntfy uses 12 chars for messages and 10 for actions. */
export function randomId(length = 12, alphabet = ALNUM): string {
  const limit = 256 - (256 % alphabet.length); // rejection sampling avoids modulo bias
  let out = "";
  while (out.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array((length - out.length) * 2))) {
      if (b >= limit) continue;
      out += alphabet[b % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}

const LOWER_ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";

/** An access token in ntfy's format: `tk_` + 29 lowercase letters/digits (~150 bits). */
export const randomToken = () => `tk_${randomId(29, LOWER_ALNUM)}`;

export const nowSeconds = () => Math.floor(Date.now() / 1000);

const DURATION_UNITS: Record<string, number> = {
  s: 1,
  sec: 1,
  secs: 1,
  second: 1,
  seconds: 1,
  m: 60,
  min: 60,
  mins: 60,
  minute: 60,
  minutes: 60,
  h: 3600,
  hr: 3600,
  hrs: 3600,
  hour: 3600,
  hours: 3600,
  d: 86400,
  day: 86400,
  days: 86400,
  w: 604800,
  week: 604800,
  weeks: 604800,
};

/** Parses "30s", "10m", "3h", "2 days", "1h30m", "1 hour 30 minutes" into seconds. */
export function parseDuration(input: string): number | undefined {
  const s = input.trim().toLowerCase();
  if (!/^(\d+\s*[a-z]+\s*)+$/.test(s)) return undefined;
  let total = 0;
  for (const [, n, u] of s.matchAll(/(\d+)\s*([a-z]+)/g)) {
    const unit = DURATION_UNITS[u!];
    if (unit === undefined) return undefined;
    total += Number(n) * unit;
  }
  return total;
}

/** Like parseDuration but also accepts a bare number of seconds and "0". */
export function parseDurationConfig(input: string | undefined, fallback: number): number {
  if (input === undefined || input.trim() === "") return fallback;
  if (/^\d+$/.test(input.trim())) return Number(input.trim());
  const d = parseDuration(input);
  if (d === undefined) throw new Error(`invalid duration "${input}"`);
  return d;
}

const SIZE_UNITS: Record<string, number> = { "": 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };

export function parseSize(input: string | undefined, fallback: number): number {
  if (input === undefined || input.trim() === "") return fallback;
  const m = /^(\d+)\s*([kmgt]?)b?$/i.exec(input.trim());
  if (!m) throw new Error(`invalid size "${input}"`);
  return Number(m[1]) * SIZE_UNITS[m[2]!.toLowerCase()]!;
}

export function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Decodes standard or URL-safe base64, with or without padding. */
export function base64ToString(input: string): string | undefined {
  try {
    let s = input.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    const bin = atob(s);
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return undefined;
  }
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function truthy(value: string | undefined): boolean {
  return value !== undefined && ["1", "yes", "true"].includes(value.trim().toLowerCase());
}

export function falsy(value: string | undefined): boolean {
  return value !== undefined && ["0", "no", "false"].includes(value.trim().toLowerCase());
}
