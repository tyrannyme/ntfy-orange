import { describe, expect, test } from "bun:test";
import { type Principal, type StoredToken, authenticate, can } from "../../src/auth";
import { loadConfig, parseTokens, parseUsers } from "../../src/config";
import { sha256Hex } from "../../src/util";

const config = loadConfig({
  NTFY_AUTH_USERS: "phil:phil-password:admin, ben:pa:ss:word:long:user\ncarl:carl-password",
  NTFY_AUTH_TOKENS: "ben:tk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  NTFY_AUTH_ACCESS:
    "ben:alerts*:rw,ben:alerts-private:deny,ben:furnace:ro,*:announcements:ro,*:up*:wo,everyone:public:rw",
});
const url = (q = "") => new URL(`https://ntfy.test/x${q}`);
const basic = (s: string) => `Basic ${btoa(s)}`;
const auth = (header?: string, q = "") =>
  authenticate(new Headers(header ? { authorization: header } : {}), url(q), config);

describe("users config", () => {
  test("passwords may contain colons; role is optional", () => {
    const users = parseUsers("a:x:y-long-enough:admin,b:p:q-long-enough,c:plain-long-enough");
    expect(users.get("a")).toEqual({ name: "a", password: "x:y-long-enough", role: "admin" });
    expect(users.get("b")).toEqual({ name: "b", password: "p:q-long-enough", role: "user" });
    expect(users.get("c")).toEqual({ name: "c", password: "plain-long-enough", role: "user" });
  });
  test("short passwords are rejected", () => {
    expect(() => parseUsers("a:short")).toThrow("at least 12 characters");
  });
  test("rejects bcrypt hashes with a helpful error", () => {
    expect(() => parseUsers("phil:$2a$10$YLiO8U21sX1uhZamTLJXHuxgVC0Z/GKISibrKCLohPgtG7yIxSk4C:admin")).toThrow(
      "bcrypt",
    );
  });
  test("rejects malformed tokens and unknown users in ACL", () => {
    expect(() => loadConfig({ NTFY_AUTH_USERS: "a:long-password", NTFY_AUTH_TOKENS: "a:tk_short" })).toThrow();
    expect(() => loadConfig({ NTFY_AUTH_USERS: "a:long-password", NTFY_AUTH_ACCESS: "zed:t:rw" })).toThrow(
      "unknown user",
    );
  });
});

describe("authenticate", () => {
  test("anonymous", async () => expect(await auth()).toBeUndefined());
  test("basic user:pass", async () => expect((await auth(basic("ben:pa:ss:word:long")))?.name).toBe("ben"));
  test("bearer token", async () => expect((await auth("Bearer tk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))?.name).toBe("ben"));
  test("basic with empty username = token", async () =>
    expect((await auth(basic(":tk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaa")))?.name).toBe("ben"));
  test("auth query param (raw base64 of the header)", async () => {
    const param = btoa(basic("phil:phil-password")).replace(/=+$/, "");
    expect((await auth(undefined, `?auth=${param}`))?.name).toBe("phil");
  });
  test.each([
    basic("phil:wrong"),
    basic("nobody:phil-password"),
    "Bearer tk_bbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "Digest abc",
    basic("nocolon"),
  ])("rejects %p with 401", async (header) => {
    await expect(auth(header)).rejects.toMatchObject({ http: 401 });
  });
});

const as = (name: string): Principal => ({ ...config.users.get(name)!, credential: { kind: "password" } });

describe("ACL", () => {
  const ben = as("ben");
  const phil = as("phil");
  test("admin can do everything", () => expect(can(config, phil, "anything", "write")).toBe(true));
  test("default deny-all", () => {
    expect(can(config, undefined, "secret", "read")).toBe(false);
    expect(can(config, ben, "secret", "read")).toBe(false);
  });
  test("wildcards, exact entries win over wildcards", () => {
    expect(can(config, ben, "alerts-disk", "write")).toBe(true);
    expect(can(config, ben, "alerts-private", "read")).toBe(false);
    expect(can(config, ben, "furnace", "read")).toBe(true);
    expect(can(config, ben, "furnace", "write")).toBe(false);
  });
  test("everyone entries apply to users too", () => {
    expect(can(config, undefined, "announcements", "read")).toBe(true);
    expect(can(config, ben, "announcements", "read")).toBe(true);
    expect(can(config, undefined, "upABC123", "write")).toBe(true);
    expect(can(config, undefined, "upABC123", "read")).toBe(false);
    expect(can(config, undefined, "public", "write")).toBe(true);
  });
});

describe("env token labels", () => {
  test("the optional third field is a label", () => {
    const users = parseUsers("a:long-password");
    const tokens = parseTokens(
      "a:tk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaa:my laptop,a:tk_bbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      users,
    );
    expect(tokens.get("tk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toEqual({ user: "a", label: "my laptop" });
    expect(tokens.get("tk_bbbbbbbbbbbbbbbbbbbbbbbbbbbbb")).toEqual({ user: "a", label: undefined });
  });
});

describe("stored (API) tokens", () => {
  const value = "tk_ccccccccccccccccccccccccccccc";
  let stored: Record<string, StoredToken> = {};
  const lookup = async (hash: string) => stored[hash] ?? null;
  const authWith = (token: StoredToken) => {
    stored = {};
    return sha256Hex(value).then((h) => {
      Object.assign(stored, { [h]: token });
      return authenticate(new Headers({ authorization: `Bearer ${value}` }), url(), config, lookup);
    });
  };
  const base: StoredToken = { id: "id1", user: "phil", prefix: "tk_cccc", created: 1 };

  test("an unscoped token acts as its user", async () => {
    const who = await authWith(base);
    expect(who?.name).toBe("phil");
    expect(who?.credential).toMatchObject({ kind: "token", id: "id1", scoped: false });
    expect(can(config, who, "anything", "write")).toBe(true);
  });
  test("a scoped token is limited to its topics and permission, even for an admin", async () => {
    const who = await authWith({ ...base, topics: ["alerts", "backup-*"], permission: "write-only" });
    expect(can(config, who, "alerts", "write")).toBe(true);
    expect(can(config, who, "backup-nas", "write")).toBe(true);
    expect(can(config, who, "alerts", "read")).toBe(false);
    expect(can(config, who, "other", "write")).toBe(false);
  });
  test("a scope never widens the user's own ACL", async () => {
    const who = await authWith({ ...base, user: "ben", topics: ["*"], permission: "read-write" });
    expect(can(config, who, "alerts-disk", "write")).toBe(true);
    expect(can(config, who, "secret", "write")).toBe(false);
    expect(can(config, who, "furnace", "write")).toBe(false);
  });
  test("expired tokens, removed users and unknown tokens are 401", async () => {
    await expect(authWith({ ...base, expires: 1000 })).rejects.toMatchObject({ http: 401 });
    await expect(authWith({ ...base, user: "removed" })).rejects.toMatchObject({ http: 401 });
    const unknown = authenticate(
      new Headers({ authorization: "Bearer tk_ddddddddddddddddddddddddddddd" }),
      url(),
      config,
      lookup,
    );
    await expect(unknown).rejects.toMatchObject({ http: 401 });
  });
  test("without a lookup (or a malformed token), stored tokens are never consulted", async () => {
    let called = false;
    const spy = async () => ((called = true), null);
    await expect(authenticate(new Headers({ authorization: "Bearer nope" }), url(), config, spy)).rejects.toMatchObject(
      { http: 401 },
    );
    expect(called).toBe(false);
  });
});
