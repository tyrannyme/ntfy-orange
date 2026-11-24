import { beforeAll, describe, expect, test } from "bun:test";
import { ADMIN, TOKEN, USER, baseUrl, poll, publish, uniqueTopic } from "./server";

let url: string;
beforeAll(async () => {
  url = await baseUrl();
}, 70_000);

let nextId = 1;
async function rpc(
  method: string,
  params?: object,
  headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` },
) {
  const res = await fetch(`${url}/v1/mcp`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  return { status: res.status, body: res.status === 200 ? ((await res.json()) as any) : await res.text() };
}
const call = async (name: string, args: object, headers?: Record<string, string>) =>
  (await rpc("tools/call", { name, arguments: args }, headers)).body.result;

describe("MCP (Streamable HTTP, stateless)", () => {
  test("requires credentials and returns a Bearer challenge", async () => {
    const res = await fetch(`${url}/v1/mcp`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    expect((await fetch(`${url}/v1/mcp`)).status).toBe(405);
  });

  test("batches are capped", async () => {
    const batch = Array.from({ length: 11 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "ping" }));
    const res = await fetch(`${url}/v1/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(batch),
    });
    expect(res.status).toBe(400);
    const ok = await fetch(`${url}/v1/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(batch.slice(0, 2)),
    });
    expect(((await ok.json()) as unknown[]).length).toBe(2);
  });

  test("initialize, notifications, tools/list", async () => {
    const init = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(init.body.result).toMatchObject({
      protocolVersion: "2025-06-18",
      serverInfo: { name: "ntfy-orange" },
      capabilities: { tools: {} },
    });
    const notif = await fetch(`${url}/v1/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(notif.status).toBe(202);
    const tools = (await rpc("tools/list")).body.result.tools.map((t: { name: string }) => t.name);
    expect(tools).toEqual(["publish", "get_messages", "wait_for_message", "delete_notification", "list_topics"]);
    expect((await rpc("nope")).body.error.code).toBe(-32601);
  });

  test("publish and get_messages", async () => {
    const topic = uniqueTopic();
    const sent = await call("publish", {
      topic,
      message: "from an agent",
      title: "Agent",
      priority: "high",
      tags: ["robot"],
      actions: [{ action: "view", label: "Open", url: "https://example.com" }],
    });
    expect(sent.isError).toBeUndefined();
    expect(sent.structuredContent).toMatchObject({
      topic,
      message: "from an agent",
      title: "Agent",
      priority: 4,
      tags: ["robot"],
    });
    expect(JSON.parse(sent.content[0].text).id).toBe(sent.structuredContent.id);
    expect((await poll(topic))[0]?.id).toBe(sent.structuredContent.id);
    await publish(topic, "second", { Priority: "1" });
    const got = await call("get_messages", { topics: [topic], limit: 1 });
    expect(got.structuredContent.messages.map((m: any) => m.message)).toEqual(["second"]);
    expect(got.structuredContent.truncated).toBe(true);
    const filtered = await call("get_messages", { topics: [topic], priority: "high" });
    expect(filtered.structuredContent.messages.map((m: any) => m.message)).toEqual(["from an agent"]);
  });

  test("ACL applies to tools", async () => {
    const denied = await call("publish", { topic: "not-bens", message: "x" }, USER);
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain("no write access");
    const ok = await call("publish", { topic: "bentopic", message: "x" }, USER);
    expect(ok.isError).toBeUndefined();
    const topics = (await call("list_topics", {}, USER)).structuredContent.topics.map((t: any) => t.topic);
    expect(topics.every((t: string) => ["bentopic", "readonly", "public"].includes(t) || t.startsWith("up"))).toBe(
      true,
    );
    expect((await call("publish", { topic: "x", priority: 9 })).isError).toBe(true);
  });

  test("wait_for_message returns the next message, or times out", async () => {
    const topic = uniqueTopic();
    const waiting = call("wait_for_message", { topics: [topic], timeout_seconds: 10 });
    await Bun.sleep(500);
    await publish(topic, "yes, approved");
    const result = await waiting;
    expect(result.structuredContent.message.message).toBe("yes, approved");
    const timeout = await call("wait_for_message", { topics: [topic], timeout_seconds: 1 });
    expect(timeout.structuredContent).toEqual({ timeout: true });
  }, 15_000);

  test("wait_for_message with since= catches a reply that arrived before waiting", async () => {
    const topic = uniqueTopic();
    const question = (await publish(topic, "question")).json;
    await publish(topic, "early answer");
    const result = await call("wait_for_message", { topics: [topic], since: question.id, timeout_seconds: 2 });
    expect(result.structuredContent.message.message).toBe("early answer");
  });

  test("delete_notification", async () => {
    const topic = uniqueTopic();
    await publish(topic, "progress", {}, "/build-7");
    const del = await call("delete_notification", { topic, sequence_id: "build-7" });
    expect(del.structuredContent).toMatchObject({ event: "message_delete", sequence_id: "build-7" });
    const clear = await call("delete_notification", { topic, sequence_id: "build-7", mode: "clear" }, ADMIN);
    expect(clear.structuredContent.event).toBe("message_clear");
  });
});
