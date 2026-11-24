import { beforeAll, describe, expect, test } from "bun:test";
import { ADMIN, baseUrl, openWs, poll, publish, readStream, uniqueTopic, waitFor } from "./server";

let url: string;
beforeAll(async () => {
  url = await baseUrl();
}, 70_000);

describe("WebSocket subscriptions", () => {
  test("open event, live delivery to the right topics only, newline-terminated frames", async () => {
    const [a, b, other] = [uniqueTopic(), uniqueTopic(), uniqueTopic()];
    const sub = await openWs(`${a},${b}`);
    const open = await sub.waitFor((e) => e.event === "open");
    expect(open.topic).toBe(`${a},${b}`);
    await publish(other, "not for you");
    const sent = (await publish(b, "for b", { Title: "hey" })).json;
    const got = await sub.waitFor((e) => e.event === "message");
    // Like the official server, WebSocket message events always carry sequence_id.
    expect(got).toEqual({ ...sent, sequence_id: sent.id });
    expect(sub.raw.every((r) => r.endsWith("\n"))).toBe(true);
    expect(sub.events.filter((e) => e.event === "message")).toHaveLength(1);
    sub.ws.close();
  });

  test("replays missed messages with since=<id> (offline recovery), then goes live", async () => {
    const topic = uniqueTopic();
    const m1 = (await publish(topic, "one")).json;
    const m2 = (await publish(topic, "two")).json;
    const m3 = (await publish(topic, "three")).json;
    const sub = await openWs(topic, `&since=${m1.id}`);
    await waitFor(sub.events, (e) => e.id === m3.id);
    const live = (await publish(topic, "four")).json;
    await sub.waitFor((e) => e.id === live.id);
    expect(sub.events.filter((e) => e.event === "message").map((e) => e.id)).toEqual([m2.id, m3.id, live.id]);
    sub.ws.close();
  });

  test("filters apply to live messages", async () => {
    const topic = uniqueTopic();
    const sub = await openWs(topic, "&priority=5");
    await sub.waitFor((e) => e.event === "open");
    await publish(topic, "low", { Priority: "1" });
    const high = (await publish(topic, "urgent", { Priority: "5" })).json;
    await sub.waitFor((e) => e.id === high.id);
    expect(sub.events.filter((e) => e.event === "message").map((e) => e.message)).toEqual(["urgent"]);
    sub.ws.close();
  });

  test("unauthorized WebSocket upgrades are rejected before the upgrade", async () => {
    const ws = new WebSocket(`${url.replace(/^http/, "ws")}/${uniqueTopic()}/ws`);
    const result = await new Promise<string>((resolve) => {
      ws.addEventListener("open", () => resolve("open"));
      ws.addEventListener("error", () => resolve("error"));
    });
    expect(result).toBe("error");
  });

  test("keepalive events arrive on schedule (interval is 5s in tests)", async () => {
    const topic = uniqueTopic();
    const sub = await openWs(topic);
    const ka = await sub.waitFor((e) => e.event === "keepalive", 12_000);
    expect(ka.topic).toBe(topic);
    sub.ws.close();
  }, 15_000);
});

describe("HTTP streams (proxied by the Worker over a hibernatable WebSocket)", () => {
  test("JSON stream", async () => {
    const topic = uniqueTopic();
    let sent: Record<string, any> = {};
    const { res, text } = await readStream(
      `${url}/${topic}/json`,
      ADMIN,
      (t) => t.includes('"event":"message"'),
      5000,
      async () => {
        sent = (await publish(topic, "streamed")).json;
      },
    );
    expect(res.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    const lines = text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ event: "open", topic });
    expect(lines[1]).toEqual(sent); // no sequence_id injection on HTTP streams
  });

  test("SSE stream", async () => {
    const topic = uniqueTopic();
    const { text } = await readStream(
      `${url}/${topic}/sse`,
      ADMIN,
      (t) => t.includes('"event":"message"'),
      5000,
      () => publish(topic, "sse!"),
    );
    expect(text).toMatch(/^event: open\ndata: \{.*\}\n\ndata: \{.*"message":"sse!"\}\n\n$/);
  });

  test("raw stream", async () => {
    const topic = uniqueTopic();
    const { text } = await readStream(
      `${url}/${topic}/raw`,
      ADMIN,
      (t) => t.includes("raw!"),
      5000,
      () => publish(topic, "raw\nraw!"),
    );
    expect(text).toBe("\nraw raw!\n");
  });

  test("since=all replays the cache before live messages", async () => {
    const topic = uniqueTopic();
    await publish(topic, "cached");
    const { text } = await readStream(
      `${url}/${topic}/json?since=all`,
      ADMIN,
      (t) => t.includes("live"),
      5000,
      () => publish(topic, "live"),
    );
    expect(
      text
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l).message ?? JSON.parse(l).event),
    ).toEqual(["open", "cached", "live"]);
  });

  test("keepalives are forwarded", async () => {
    const topic = uniqueTopic();
    const { text } = await readStream(`${url}/${topic}/json`, ADMIN, (t) => t.includes("keepalive"), 12_000);
    expect(text).toContain('"event":"keepalive"');
  }, 15_000);
});

describe("scheduled delivery", () => {
  test("delivered by the Durable Object alarm at the scheduled time", async () => {
    const topic = uniqueTopic();
    const sub = await openWs(topic);
    const sent = (await publish(topic, "later", { Delay: "2s" })).json;
    expect(sent.time).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(await poll(topic)).toEqual([]); // not yet visible
    expect((await poll(topic, "&sched=1")).map((m) => m.id)).toEqual([sent.id]);
    const got = await sub.waitFor((e) => e.id === sent.id, 8000);
    expect(got.message).toBe("later");
    expect((await poll(topic)).map((m) => m.id)).toEqual([sent.id]);
    sub.ws.close();
  }, 12_000);
});
