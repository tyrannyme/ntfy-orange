/**
 * ntfy parameters can arrive as HTTP headers (any alias, case-insensitive) or as
 * lowercase query parameters. Headers win over query parameters.
 */
export class Params {
  private readonly query: URLSearchParams;

  constructor(
    private readonly headers: Headers,
    url: URL,
  ) {
    this.query = url.searchParams;
  }

  get(...names: string[]): string | undefined {
    for (const name of names) {
      const v = this.headers.get(name);
      if (v !== null) return decodeRfc2047(v).trim();
    }
    for (const name of names) {
      const v = this.query.get(name.toLowerCase());
      if (v !== null) return v.trim();
    }
    return undefined;
  }

  has(...names: string[]): boolean {
    return this.get(...names) !== undefined;
  }
}

/** Decodes MIME encoded-words (`=?UTF-8?B?...?=` / `=?UTF-8?Q?...?=`) used for non-ASCII headers. */
export function decodeRfc2047(value: string): string {
  if (!value.includes("=?")) return value;
  return value
    .replace(/\?=\s+=\?/g, "?==?") // whitespace between adjacent encoded words is ignored
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (whole, charset: string, enc: string, text: string) => {
      try {
        let bytes: Uint8Array;
        if (enc.toUpperCase() === "B") {
          bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
        } else {
          const s = text.replace(/_/g, " ");
          const out: number[] = [];
          for (let i = 0; i < s.length; i++) {
            if (s[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
              out.push(parseInt(s.slice(i + 1, i + 3), 16));
              i += 2;
            } else out.push(s.charCodeAt(i));
          }
          bytes = Uint8Array.from(out);
        }
        return new TextDecoder(charset.toLowerCase()).decode(bytes);
      } catch {
        return whole;
      }
    });
}
