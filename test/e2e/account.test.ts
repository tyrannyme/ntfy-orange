import { beforeAll, describe, expect, test } from "bun:test";
import { ADMIN, TOKEN, USER, baseUrl, poll, uniqueTopic } from "./server";

let url: string;
beforeAll(async () => {
  url = await baseUrl();
}, 70_000);

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function create(body: unknown, headers: Record<string, string> = ADMIN) {
  const res = await fetch(`${url}/v1/account/token`, {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

const send = (topic: string, headers: Record<string, string>, body = "x") =>
  fetch(`${url}/${topic}`, { method: "POST", body, headers }).then((r) => r.status);
const read = (topic: string, headers: Record<string, string>) =>
  fetch(`${url}/${topic}/json?poll=1`, { headers }).then((r) => r.status);

describe("token API", () => {
  test("create a token with a password, then publish with it; no redeploy needed", async () => {
    const { status, json } = await create({ label: "backup script" });
    expect(status).toBe(200);
    expect(json.token).toMatch(/^tk_[a-z0-9]{29}$/);
    expect(json.label).toBe("backup script");
    expect(json.expires).toBeUndefined(); // never expires by default
    expect(Object.keys(json).slice(0, 3)).toEqual(["token", "label", "last_access"]);

    const topic = uniqueTopic();
    expect(await send(topic, bearer(json.token), "via api token")).toBe(200);
    expect((await poll(topic))[0]?.message).toBe("via api token");
  });

  test("an empty body creates a token too", async () => {
    const { status, json } = await create(undefined);
    expect(status).toBe(200);
    expect(json.token).toMatch(/^tk_/);
  });

  test("GET /v1/account lists tokens masked, never in full", async () => {
    const { json: created } = await create({ label: "listed" });
    const res = await fetch(`${url}/v1/account`, { headers: ADMIN });
    const account = await res.json();
    expect(account).toMatchObject({ username: "phil", role: "admin" });
    const text = JSON.stringify(account);
    expect(text).not.toContain(created.token);
    expect(text).not.toContain(TOKEN);
    const mine = account.tokens.find((t: any) => t.id === created.id);
    expect(mine.token).toBe(`${created.token.slice(0, 7)}…`);
    expect(account.tokens.find((t: any) => t.provisioned)?.token).toBe(`${TOKEN.slice(0, 7)}…`);
    expect(await (await fetch(`${url}/v1/account`)).json()).toEqual({ username: "*", role: "anonymous" });
  });

  test("scoped token: only its topics and permission", async () => {
    const allowed = uniqueTopic("scoped");
    const { json } = await create({ label: "ci", topics: [allowed, "wild-*"], permission: "write-only" });
    expect(json).toMatchObject({ topics: [allowed, "wild-*"], permission: "write-only" });
    const h = bearer(json.token);
    expect(await send(allowed, h)).toBe(200);
    expect(await send("wild-card", h)).toBe(200);
    expect(await send(uniqueTopic(), h)).toBe(403);
    expect(await read(allowed, h)).toBe(403);
  });

  test("scoped tokens can't mint tokens or see the account's other tokens", async () => {
    const { json } = await create({ topics: ["only-this"] });
    expect((await create({ label: "escalate" }, bearer(json.token))).status).toBe(403);
    const account = await (await fetch(`${url}/v1/account`, { headers: bearer(json.token) })).json();
    expect(account.tokens).toHaveLength(1);
    expect(account.tokens[0].id).toBe(json.id);
  });

  test("a non-admin's token never exceeds the user's own ACL", async () => {
    const { status, json } = await create({ label: "ben's" }, USER);
    expect(status).toBe(200);
    const h = bearer(json.token);
    expect(await send("bentopic", h)).toBe(200);
    expect(await send(uniqueTopic(), h)).toBe(403);
  });

  test("an unscoped API token can create more tokens (like ntfy)", async () => {
    const { json } = await create({ label: "parent" });
    expect((await create({ label: "child" }, bearer(json.token))).status).toBe(200);
  });

  test("PATCH changes label and expiry", async () => {
    const { json } = await create({ label: "old" });
    const res = await fetch(`${url}/v1/account/token`, {
      method: "PATCH",
      headers: ADMIN,
      body: JSON.stringify({ token: json.token, label: "new", expires: 1900000000 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ token: json.token, label: "new", expires: 1900000000 });
  });

  test("PATCH changes a token's topics and permission; the token keeps working with the new limits", async () => {
    const [a, b] = [uniqueTopic(), uniqueTopic()];
    const { json } = await create({ label: "plugin", topics: [a], permission: "write-only" });
    const patch = (body: Record<string, unknown>, headers: Record<string, string> = ADMIN) =>
      fetch(`${url}/v1/account/token`, { method: "PATCH", headers, body: JSON.stringify({ id: json.id, ...body }) });
    expect(await send(b, bearer(json.token))).toBe(403);
    expect(await read(a, bearer(json.token))).toBe(403);

    // A scoped token can't widen itself.
    expect((await patch({ topics: [a, b] }, bearer(json.token))).status).toBe(403);

    // Changing only the topics keeps the permission (and vice versa).
    let res = await patch({ topics: [a, b] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ label: "plugin", topics: [a, b], permission: "write-only" });
    expect(await send(b, bearer(json.token))).toBe(200);
    expect(await read(b, bearer(json.token))).toBe(403);

    res = await patch({ permission: "read-write" });
    expect(await res.json()).toMatchObject({ topics: [a, b], permission: "read-write" });
    expect(await read(b, bearer(json.token))).toBe(200);

    // null resets a limit; every topic with publish and read is no limit at all.
    res = await patch({ topics: null });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.topics).toBeUndefined();
    expect(body.permission).toBeUndefined();
    expect(await send(uniqueTopic(), bearer(json.token))).toBe(200);
    expect((await create({ label: "child" }, bearer(json.token))).status).toBe(200);

    // And narrowing works the same way.
    res = await patch({ topics: [a], permission: "read-only" });
    expect(await res.json()).toMatchObject({ topics: [a], permission: "read-only" });
    expect(await send(a, bearer(json.token))).toBe(403);
    expect(await read(a, bearer(json.token))).toBe(200);

    expect((await patch({ permission: "admin" })).status).toBe(400);
    expect((await patch({ topics: ["bad topic"] })).status).toBe(400);
  });

  test("revoke by X-Token, by id, or the calling token itself", async () => {
    const del = (headers: Record<string, string>, query = "") =>
      fetch(`${url}/v1/account/token${query}`, { method: "DELETE", headers }).then(async (r) => ({
        status: r.status,
        json: await r.json(),
      }));
    const topic = uniqueTopic();

    const a = (await create({ label: "a" })).json;
    expect(await del({ ...ADMIN, "X-Token": a.token })).toEqual({ status: 200, json: { success: true } });
    expect(await send(topic, bearer(a.token))).toBe(401);

    const b = (await create({ label: "b" })).json;
    expect((await del(ADMIN, `?id=${b.id}`)).status).toBe(200);
    expect(await send(topic, bearer(b.token))).toBe(401);

    const c = (await create({ label: "c" })).json;
    expect((await del(bearer(c.token))).status).toBe(200);
    expect(await send(topic, bearer(c.token))).toBe(401);

    expect((await del({ ...ADMIN, "X-Token": a.token })).status).toBe(404);
  });

  test("a scoped token may revoke itself, but nothing else", async () => {
    const other = (await create({ label: "other" })).json;
    const scoped = (await create({ topics: ["x"] })).json;
    const res = await fetch(`${url}/v1/account/token?id=${other.id}`, {
      method: "DELETE",
      headers: bearer(scoped.token),
    });
    expect(res.status).toBe(403);
    const self = await fetch(`${url}/v1/account/token`, { method: "DELETE", headers: bearer(scoped.token) });
    expect(self.status).toBe(200);
  });

  test("users can't touch each other's tokens", async () => {
    const phils = (await create({ label: "phil's" })).json;
    const res = await fetch(`${url}/v1/account/token`, {
      method: "DELETE",
      headers: { ...USER, "X-Token": phils.token },
    });
    expect(res.status).toBe(404);
    expect(await send("bentopic", bearer(phils.token))).toBe(200);
  });

  test("expired tokens stop working", async () => {
    const { json } = await create({ expires: Math.floor(Date.now() / 1000) + 2 });
    expect(await send(uniqueTopic(), bearer(json.token))).toBe(200);
    await Bun.sleep(3000);
    expect(await send(uniqueTopic(), bearer(json.token))).toBe(401);
  });

  test("errors match the official server where it has them", async () => {
    const anon = await create({}, {});
    expect(anon.status).toBe(401);
    const bad = await fetch(`${url}/v1/account/token`, { method: "POST", headers: ADMIN, body: "nope" });
    expect(await bad.json()).toMatchObject({ code: 40024, http: 400 });
    const noToken = await fetch(`${url}/v1/account/token`, { method: "DELETE", headers: ADMIN });
    expect(await noToken.json()).toMatchObject({ code: 40023, http: 400 });
    const provisioned = await fetch(`${url}/v1/account/token`, { method: "DELETE", headers: bearer(TOKEN) });
    expect(await provisioned.json()).toMatchObject({ code: 40906, http: 409 });
    const badField = await create({ permission: "everything" });
    expect(badField.status).toBe(400);
    const badTopic = await create({ topics: ["no spaces"] });
    expect(badTopic.status).toBe(400);
  });
});

describe("account page", () => {
  test("served with a nonce CSP and no caching", async () => {
    const res = await fetch(`${url}/account`);
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy")!;
    const nonce = /'nonce-([A-Za-z0-9]+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text();
    expect(body).toContain(`<script nonce="${nonce}">`);
    expect(body).not.toContain("innerHTML");
  });

  test("publishing to the reserved 'account' topic is still refused", async () => {
    const res = await fetch(`${url}/account`, { method: "POST", body: "x", headers: ADMIN });
    expect(res.status).toBe(400);
  });
});
