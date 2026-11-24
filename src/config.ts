import { parseDurationConfig, parseSize } from "./util";
import { isValidTimezone } from "./time";

export type Permission = { read: boolean; write: boolean };
export type Role = "admin" | "user";

export interface User {
  name: string;
  password: string;
  role: Role;
}

export interface EnvToken {
  user: string;
  label?: string;
}

export interface AccessEntry {
  user: string; // username or "*"
  pattern: string;
  regex: RegExp;
  perm: Permission;
}

export interface Config {
  baseUrl?: string;
  users: Map<string, User>;
  tokens: Map<string, EnvToken>; // token -> owner (from NTFY_AUTH_TOKENS)
  access: AccessEntry[];
  defaultAccess: Permission;
  cacheDuration: number;
  keepaliveInterval: number;
  messageSizeLimit: number;
  messageDelayMin: number;
  messageDelayMax: number;
  attachmentFileSizeLimit: number;
  attachmentTotalSizeLimit: number;
  attachmentExpiry: number;
  upstreamBaseUrl?: string;
  upstreamAccessToken?: string;
  timezone: string;
  mcpEnabled: boolean;
}

/** Everything is optional; the defaults give a private (deny-all) server. */
export interface ConfigEnv {
  NTFY_BASE_URL?: string;
  NTFY_AUTH_USERS?: string;
  NTFY_AUTH_TOKENS?: string;
  NTFY_AUTH_ACCESS?: string;
  NTFY_AUTH_DEFAULT_ACCESS?: string;
  NTFY_CACHE_DURATION?: string;
  NTFY_KEEPALIVE_INTERVAL?: string;
  NTFY_MESSAGE_SIZE_LIMIT?: string;
  NTFY_MESSAGE_DELAY_LIMIT?: string;
  NTFY_ATTACHMENT_FILE_SIZE_LIMIT?: string;
  NTFY_ATTACHMENT_TOTAL_SIZE_LIMIT?: string;
  NTFY_ATTACHMENT_EXPIRY_DURATION?: string;
  NTFY_UPSTREAM_BASE_URL?: string;
  NTFY_UPSTREAM_ACCESS_TOKEN?: string;
  NTFY_TIMEZONE?: string;
  NTFY_ENABLE_MCP?: string;
  /** Test-only escape hatch: lowers the 10s minimum delay. */
  NTFY_MESSAGE_DELAY_MIN?: string;
}

export const PERMISSIONS: Record<string, Permission> = {
  "read-write": { read: true, write: true },
  rw: { read: true, write: true },
  "read-only": { read: true, write: false },
  read: { read: true, write: false },
  ro: { read: true, write: false },
  "write-only": { read: false, write: true },
  write: { read: false, write: true },
  wo: { read: false, write: true },
  "deny-all": { read: false, write: false },
  deny: { read: false, write: false },
  none: { read: false, write: false },
};

/** Entries are separated by commas or newlines (like ntfy's NTFY_AUTH_* env variables). */
const entries = (value: string | undefined) =>
  (value ?? "")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s !== "" && !s.startsWith("#"));

export const MIN_PASSWORD_LENGTH = 12;
const USERNAME = /^[-_.@a-zA-Z0-9+]{1,64}$/;

export function parseUsers(value: string | undefined): Map<string, User> {
  const users = new Map<string, User>();
  for (const entry of entries(value)) {
    // <username>:<password>[:<role>]. The password may contain colons; the role is only
    // recognized if the last segment is literally "admin" or "user".
    const first = entry.indexOf(":");
    if (first <= 0) throw new Error(`invalid NTFY_AUTH_USERS entry for "${entry.split(":")[0]}"`);
    const name = entry.slice(0, first);
    let password = entry.slice(first + 1);
    let role: Role = "user";
    const m = /:(admin|user)$/.exec(password);
    if (m) {
      role = m[1] as Role;
      password = password.slice(0, -m[0].length);
    }
    if (!USERNAME.test(name) || name === "everyone" || name === "*") throw new Error(`invalid username "${name}"`);
    // There is no login rate limiting; long passwords make online guessing hopeless
    // (the free plan caps a Worker at 100k requests/day anyway).
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`password for user "${name}" must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    if (/^\$2[aby]\$/.test(password)) {
      throw new Error(
        `user "${name}" has a bcrypt hash; ntfy-orange expects the password itself (stored as an encrypted secret), see README`,
      );
    }
    users.set(name, { name, password, role });
  }
  return users;
}

export function parseTokens(value: string | undefined, users: Map<string, User>): Map<string, EnvToken> {
  const tokens = new Map<string, EnvToken>();
  for (const entry of entries(value)) {
    const [name, token, ...label] = entry.split(":");
    if (!name || !token || !users.has(name)) throw new Error(`invalid NTFY_AUTH_TOKENS entry for user "${name}"`);
    if (!/^tk_[a-z0-9]{29}$/i.test(token)) {
      throw new Error(`token for user "${name}" must be "tk_" followed by 29 letters/digits`);
    }
    tokens.set(token, { user: name, label: label.join(":") || undefined });
  }
  return tokens;
}

/** Topic patterns in ACL entries and token scopes: topic characters plus `*` wildcards. */
export const TOPIC_PATTERN = /^[-_A-Za-z0-9*]{1,64}$/;
export const patternRegex = (pattern: string) => new RegExp(`^${pattern.replace(/\*/g, ".*")}$`);

export function parseAccess(value: string | undefined, users: Map<string, User>): AccessEntry[] {
  const list: AccessEntry[] = [];
  for (const entry of entries(value)) {
    const [rawUser, pattern, perm] = entry.split(":");
    const user = rawUser === "everyone" ? "*" : rawUser;
    if (!user || !pattern || !perm) throw new Error(`invalid NTFY_AUTH_ACCESS entry "${entry}"`);
    if (user !== "*" && !users.has(user)) throw new Error(`NTFY_AUTH_ACCESS references unknown user "${user}"`);
    if (!TOPIC_PATTERN.test(pattern)) throw new Error(`invalid topic pattern "${pattern}"`);
    const p = PERMISSIONS[perm.toLowerCase()];
    if (!p) throw new Error(`invalid permission "${perm}" in NTFY_AUTH_ACCESS`);
    const regex = patternRegex(pattern);
    list.push({ user, pattern, regex, perm: p });
  }
  // Most specific first: the user's own entries before everyone's, exact topics before
  // wildcards, longer patterns before shorter ones.
  const score = (e: AccessEntry) => [e.user === "*" ? 1 : 0, e.pattern.includes("*") ? 1 : 0, -e.pattern.length];
  return list.sort((a, b) => {
    const [x, y] = [score(a), score(b)];
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
    return 0;
  });
}

let cached: { env: ConfigEnv; config: Config } | undefined;

export function loadConfig(env: ConfigEnv): Config {
  if (cached?.env === env) return cached.config;
  const users = parseUsers(env.NTFY_AUTH_USERS);
  const defaultAccess = PERMISSIONS[(env.NTFY_AUTH_DEFAULT_ACCESS || "deny-all").toLowerCase()];
  if (!defaultAccess) throw new Error(`invalid NTFY_AUTH_DEFAULT_ACCESS "${env.NTFY_AUTH_DEFAULT_ACCESS}"`);
  const timezone = env.NTFY_TIMEZONE || "UTC";
  if (!isValidTimezone(timezone)) throw new Error(`invalid NTFY_TIMEZONE "${timezone}"`);
  const config: Config = {
    baseUrl: env.NTFY_BASE_URL?.replace(/\/+$/, "") || undefined,
    users,
    tokens: parseTokens(env.NTFY_AUTH_TOKENS, users),
    access: parseAccess(env.NTFY_AUTH_ACCESS, users),
    defaultAccess,
    cacheDuration: parseDurationConfig(env.NTFY_CACHE_DURATION, 7 * 86400),
    keepaliveInterval: Math.max(5, parseDurationConfig(env.NTFY_KEEPALIVE_INTERVAL, 45)),
    messageSizeLimit: parseSize(env.NTFY_MESSAGE_SIZE_LIMIT, 4096),
    messageDelayMin: parseDurationConfig(env.NTFY_MESSAGE_DELAY_MIN, 10),
    messageDelayMax: parseDurationConfig(env.NTFY_MESSAGE_DELAY_LIMIT, 3 * 86400),
    attachmentFileSizeLimit: parseSize(env.NTFY_ATTACHMENT_FILE_SIZE_LIMIT, 15 * 1024 ** 2),
    attachmentTotalSizeLimit: parseSize(env.NTFY_ATTACHMENT_TOTAL_SIZE_LIMIT, 250 * 1024 ** 2),
    attachmentExpiry: parseDurationConfig(env.NTFY_ATTACHMENT_EXPIRY_DURATION, 86400),
    upstreamBaseUrl: env.NTFY_UPSTREAM_BASE_URL?.replace(/\/+$/, "") || undefined,
    upstreamAccessToken: env.NTFY_UPSTREAM_ACCESS_TOKEN || undefined,
    timezone,
    mcpEnabled: env.NTFY_ENABLE_MCP !== "false",
  };
  if (config.attachmentFileSizeLimit > 100 * 1024 ** 2)
    throw new Error("NTFY_ATTACHMENT_FILE_SIZE_LIMIT is capped at 100M");
  cached = { env, config };
  return config;
}

export const attachmentsEnabled = (c: Config) => c.attachmentTotalSizeLimit > 0 && c.attachmentFileSizeLimit > 0;
