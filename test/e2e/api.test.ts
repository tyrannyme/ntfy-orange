import { beforeAll, describe, expect, test } from "bun:test";
import { ADMIN, TOKEN, USER, USERS, baseUrl, basic, poll, publish, uniqueTopic } from "./server";

let url: string;
beforeAll(async () => {
  url = await baseUrl();
}, 70_000);

describe("auth", () => {
  test("deny-all by default: anonymous gets 403, wrong password 401", async () => {
    const anon = await fetch(`${url}/secret`, { method: "POST", body: "x" });
    expect(anon.status).toBe(403);
    expect(await anon.json()).toMatchObject({ code: 40301, http: 403, error: "forbidden" });
    const wrong = await fetch(`${url}/secret`, {
      method: "POST",
      body: "x",
      headers: { Authorization: basic("phil", "nope") },
    });
    expect(wrong.status).toBe(401);
    expect((await wrong.json()).code).toBe(40101);
    expect((await fetch(`${url}/secret/json?poll=1`)).status).toBe(403);
  });

  test("tokens via Bearer, Basic with empty user, and ?auth=", async () => {
    const topic = uniqueTopic();
    for (const headers of [{ Authorization: `Bearer ${TOKEN}` }, { Authorization: basic("", TOKEN) }]) {
      expect((await fetch(`${url}/${topic}`, { method: "POST", body: "x", headers })).status).toBe(200);
    }
    const param = btoa(`Bearer ${TOKEN}`).replace(/=+$/, "");
    expect((await fetch(`${url}/${topic}?auth=${param}`, { method: "POST", body: "x" })).status).toBe(200);
    expect(await poll(topic)).toHaveLength(3);
  });

  test("ACL: user rights, read-only topics, anonymous public and write-only up* topics", async () => {
    const send = (topic: string, headers: Record<string, string> = {}) =>
      fetch(`${url}/${topic}`, { method: "POST", body: "x", headers });
    expect((await send("bentopic", USER)).status).toBe(200);
    expect((await send("other", USER)).status).toBe(403);
    expect((await send("readonly", USER)).status).toBe(403);
    expect((await fetch(`${url}/readonly/json?poll=1`, { headers: USER })).status).toBe(200);
    expect((await send("public")).status).toBe(200);
    expect((await send("upAbc123")).status).toBe(200);
    expect((await fetch(`${url}/upAbc123/json?poll=1`)).status).toBe(403);
  });

  test("/<topic>/auth (used by the Android app to verify credentials)", async () => {
    expect(await (await fetch(`${url}/anything/auth`, { headers: ADMIN })).json()).toEqual({ success: true });
    expect((await fetch(`${url}/anything/auth`)).status).toBe(403);
    expect(
      (await fetch(`${url}/anything/auth`, { headers: { Authorization: basic(USERS.user[0], "bad") } })).status,
    ).toBe(401);
  });
});

describe("publishing", () => {
  test("metadata round-trips through the cache", async () => {
    const topic = uniqueTopic();
    const { json } = await publish(topic, "hello world", {
      Title: "T",
      Priority: "urgent",
      Tags: "warning,skull",
      Click: "https://x.y",
      Markdown: "yes",
    });
    expect(json).toMatchObject({
      event: "message",
      topic,
      title: "T",
      message: "hello world",
      priority: 5,
      tags: ["warning", "skull"],
      click: "https://x.y",
      content_type: "text/markdown",
    });
    expect(json.id).toMatch(/^[A-Za-z0-9]{12}$/);
    expect(json.expires).toBeGreaterThan(json.time);
    expect(await poll(topic)).toEqual([json]);
  });

  test("GET /publish, /send, /trigger webhooks and PUT", async () => {
    const topic = uniqueTopic();
    expect((await (await fetch(`${url}/${topic}/trigger`, { headers: ADMIN })).json()).message).toBe("triggered");
    expect(
      await (await fetch(`${url}/${topic}/publish?message=hi+there&t=tt&p=low&ta=a,b`, { headers: ADMIN })).json(),
    ).toMatchObject({ message: "hi there", title: "tt", priority: 2, tags: ["a", "b"] });
    expect((await (await fetch(`${url}/${topic}/send?m=x`, { headers: ADMIN })).json()).message).toBe("x");
    expect(
      (await (await fetch(`${url}/${topic}`, { method: "PUT", body: "put", headers: ADMIN })).json()).message,
    ).toBe("put");
  });

  test("publish as JSON to the root URL", async () => {
    const topic = uniqueTopic();
    const res = await fetch(url, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({
        topic,
        message: "j",
        title: "tt",
        tags: ["a"],
        priority: 4,
        actions: [{ action: "view", label: "Open", url: "https://example.com" }],
      }),
    });
    const json = await res.json();
    expect(json).toMatchObject({
      topic,
      message: "j",
      title: "tt",
      priority: 4,
      actions: [{ action: "view", label: "Open", url: "https://example.com", clear: false }],
    });
    const denied = await fetch(url, { method: "POST", headers: USER, body: JSON.stringify({ topic, message: "j" }) });
    expect(denied.status).toBe(403);
  });

  test("errors use ntfy codes", async () => {
    const topic = uniqueTopic();
    expect((await publish(topic, "x", { Priority: "9" })).json).toMatchObject({ code: 40007, http: 400 });
    expect((await publish(topic, "x", { Actions: "foo, bar" })).json.code).toBe(40018);
    expect((await publish(topic, "x", { Delay: "10d" })).json.code).toBe(40006);
    expect((await publish("v1", "x")).json.code).toBe(40010);
    expect((await fetch(`${url}/Bad.Topic`, { method: "POST", headers: ADMIN })).status).toBe(404);
  });

  test("Cache: no is delivered but not stored", async () => {
    const topic = uniqueTopic();
    const { json } = await publish(topic, "ephemeral", { Cache: "no" });
    expect(json.expires).toBeUndefined();
    expect(await poll(topic)).toEqual([]);
  });

  test("UnifiedPush: binary is base64 encoded, Matrix gateway forwards to the pushkey topic", async () => {
    const topic = uniqueTopic("up");
    const bin = await fetch(`${url}/${topic}?up=1`, { method: "POST", body: new Uint8Array([0xff, 0xfe, 0x00, 0x01]) });
    expect(await bin.json()).toMatchObject({ message: "//4AAQ==", encoding: "base64" });
    expect(await (await fetch(`${url}/_matrix/push/v1/notify`)).json()).toEqual({ unifiedpush: { gateway: "matrix" } });
    const body = JSON.stringify({ notification: { devices: [{ pushkey: `${url}/${topic}?up=1` }] } });
    expect(await (await fetch(`${url}/_matrix/push/v1/notify`, { method: "POST", body })).json()).toEqual({
      rejected: [],
    });
    const foreign = JSON.stringify({ notification: { devices: [{ pushkey: `https://elsewhere.example/${topic}` }] } });
    expect(await (await fetch(`${url}/_matrix/push/v1/notify`, { method: "POST", body: foreign })).json()).toEqual({
      rejected: [`https://elsewhere.example/${topic}`],
    });
    const messages = await poll(topic);
    expect(messages.at(-1)?.message).toBe(body);
  });
});

describe("cache queries", () => {
  test("since=<id>, since=<time>, since=latest, filters, multiple topics", async () => {
    const [a, b] = [uniqueTopic(), uniqueTopic()];
    const m1 = (await publish(a, "one", { Priority: "high", Tags: "x,y" })).json;
    const m2 = (await publish(b, "two")).json;
    const m3 = (await publish(a, "three", { Tags: "x" })).json;
    expect((await poll(`${a},${b}`)).map((m) => m.message)).toEqual(["one", "two", "three"]);
    expect((await poll(`${a},${b}`, `&since=${m1.id}`)).map((m) => m.id)).toEqual([m2.id, m3.id]);
    expect((await poll(a, "&since=AAAAAAAAAAAA")).map((m) => m.id)).toEqual([m1.id, m3.id]); // unknown ID: everything
    expect((await poll(`${a},${b}`, "&since=latest")).map((m) => m.id).sort()).toEqual([m2.id, m3.id].sort());
    expect(await poll(a, `&since=${m1.time + 3600}`)).toEqual([]);
    expect((await poll(a, "&since=1h")).length).toBe(2);
    expect((await poll(a, "&priority=high,urgent")).map((m) => m.id)).toEqual([m1.id]);
    expect((await poll(a, "&tags=x,y")).map((m) => m.id)).toEqual([m1.id]);
    expect((await poll(a, `&id=${m3.id}`)).map((m) => m.id)).toEqual([m3.id]);
    const headerPoll = await fetch(`${url}/${a}/json`, { headers: { ...ADMIN, "X-Poll": "1", "X-Since": "latest" } });
    expect(JSON.parse(await headerPoll.text()).id).toBe(m3.id);
    expect((await fetch(`${url}/${a}/json?poll=1&since=garbage!`, { headers: ADMIN })).status).toBe(400);
  });

  test("sse and raw poll formats", async () => {
    const topic = uniqueTopic();
    await publish(topic, "multi\nline");
    const sse = await fetch(`${url}/${topic}/sse?poll=1`, { headers: ADMIN });
    expect(sse.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(await sse.text()).toMatch(/^data: \{.*"message":"multi\\nline"\}\n\n$/);
    expect(await (await fetch(`${url}/${topic}/raw?poll=1`, { headers: ADMIN })).text()).toBe("multi line\n");
  });
});

describe("sequences: update, clear, delete", () => {
  test("events are stored and replayed in order", async () => {
    const topic = uniqueTopic();
    expect((await publish(topic, "v1", {}, "/job-1")).json).toMatchObject({ sequence_id: "job-1", message: "v1" });
    expect((await publish(topic, "v2", { "X-Sequence-ID": "job-1" })).json.sequence_id).toBe("job-1");
    const clear = await (await fetch(`${url}/${topic}/job-1/clear`, { method: "PUT", headers: ADMIN })).json();
    expect(clear).toMatchObject({ event: "message_clear", sequence_id: "job-1" });
    expect(clear.message).toBeUndefined();
    await fetch(`${url}/${topic}/job-1/read`, { headers: ADMIN });
    const del = await (await fetch(`${url}/${topic}/job-1`, { method: "DELETE", headers: ADMIN })).json();
    expect(del).toMatchObject({ event: "message_delete", sequence_id: "job-1" });
    await fetch(`${url}/${topic}/job-1/delete`, { headers: ADMIN });
    expect((await poll(topic)).map((m) => m.event)).toEqual([
      "message",
      "message",
      "message_clear",
      "message_clear",
      "message_delete",
      "message_delete",
    ]);
  });

  test("a scheduled message without a sequence ID can be canceled by its message ID", async () => {
    const topic = uniqueTopic();
    const { json } = await publish(topic, "reminder", { In: "1h" });
    await fetch(`${url}/${topic}/${json.id}`, { method: "DELETE", headers: ADMIN });
    expect((await poll(topic, "&sched=1")).map((m) => m.event)).toEqual(["message_delete"]);
  });

  test("a scheduled message is replaced by a newer one and canceled by delete", async () => {
    const topic = uniqueTopic();
    await publish(topic, "first", { In: "1h" }, "/watchdog");
    await publish(topic, "second", { In: "2h" }, "/watchdog");
    expect((await poll(topic, "&sched=1")).map((m) => m.message)).toEqual(["second"]);
    await fetch(`${url}/${topic}/watchdog`, { method: "DELETE", headers: ADMIN });
    expect((await poll(topic, "&sched=1")).map((m) => m.event)).toEqual(["message_delete"]);
  });
});

describe("attachments", () => {
  test("upload, download, metadata", async () => {
    const topic = uniqueTopic();
    const png = new Uint8Array([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      ...Array.from({ length: 100 }, () => 7),
    ]);
    const { json } = await publish(topic, png, { Filename: "cat.png" });
    expect(json).toMatchObject({
      message: "You received a file: cat.png",
      attachment: { name: "cat.png", type: "image/png", size: 108 },
    });
    expect(json.attachment.url).toBe(`${url}/file/${json.id}.png`);
    const file = await fetch(json.attachment.url); // capability URL: no auth needed, like ntfy
    expect(file.headers.get("content-type")).toBe("image/png");
    expect(file.headers.get("content-disposition")).toBe('attachment; filename="cat.png"');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(png);
    expect((await fetch(json.attachment.url, { method: "HEAD" })).headers.get("content-length")).toBe("108");
    expect((await fetch(`${url}/file/AAAAAAAAAAAA.png`)).status).toBe(404);
  });

  test("multi-chunk files survive intact; size and storage limits are enforced", async () => {
    const topic = uniqueTopic();
    const data = crypto.getRandomValues(new Uint8Array(2.5 * 1024 * 1024));
    const { json } = await publish(topic, data);
    expect(json.attachment).toMatchObject({ name: "attachment.bin", size: data.length });
    expect(new Uint8Array(await (await fetch(json.attachment.url)).arrayBuffer())).toEqual(data);
    expect((await publish(topic, new Uint8Array(3.5 * 1024 * 1024))).res.status).toBe(413); // > 3M file limit
    await publish(topic, crypto.getRandomValues(new Uint8Array(2 * 1024 * 1024)));
    const full = await publish(topic, crypto.getRandomValues(new Uint8Array(2 * 1024 * 1024))); // > 5M total
    expect(full.res.status).toBe(413);
  });

  test("external attachment URL", async () => {
    const { json } = await publish(uniqueTopic(), "see", { Attach: "https://example.com/files/flower.jpg?x=1" });
    expect(json.attachment).toEqual({ name: "flower.jpg", url: "https://example.com/files/flower.jpg?x=1" });
  });
});

describe("misc endpoints", () => {
  test("malformed paths and oversized subscriptions are client errors", async () => {
    expect((await fetch(`${url}/%E0`, { headers: ADMIN })).status).toBe(404);
    const topics = Array.from({ length: 150 }, (_, i) => `t${i}`.padEnd(64, "x")).join(",");
    const res = await fetch(`${url}/${topics}/json?poll=1`, { headers: { ...ADMIN, "X-Title": "t".repeat(8000) } });
    expect(res.status).toBe(400);
  });

  test("health, config, CORS, landing page", async () => {
    expect(await (await fetch(`${url}/v1/health`)).json()).toEqual({ healthy: true });
    expect((await (await fetch(`${url}/v1/config`)).json()).disallowed_topics).toContain("v1");
    const pre = await fetch(`${url}/mytopic`, { method: "OPTIONS" });
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    expect(pre.headers.get("access-control-allow-methods")).toContain("PUT");
    const page = await fetch(`${url}/mytopic`);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("mytopic");
  });
});
