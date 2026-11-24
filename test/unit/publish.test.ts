import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/config";
import { serialize } from "../../src/message";
import { buildJob, fieldsFromJson, fieldsFromRequest } from "../../src/publish";
import { decodeRfc2047 } from "../../src/params";

const config = loadConfig({ NTFY_CACHE_DURATION: "12h" });
const ctx = { config, baseUrl: "https://ntfy.test", now: Date.UTC(2026, 10, 24, 3, 0, 0) };
const enc = (s: string) => new TextEncoder().encode(s);
const fromHeaders = async (headers: Record<string, string>, body = "", query = "") =>
  buildJob(fieldsFromRequest(new Headers(headers), new URL(`https://ntfy.test/t${query}`), "t", enc(body)), ctx);

describe("publish via headers/query", () => {
  test("all metadata, field order matches the official server", async () => {
    const { message } = await fromHeaders(
      {
        Title: "T",
        Priority: "high",
        Tags: "warning,skull",
        Click: "https://x.y",
        Icon: "https://i.png",
        Attach: "https://example.com/files/flower.jpg?x=1",
        Markdown: "yes",
      },
      "hello",
    );
    const { id: _id, time, expires, ...rest } = JSON.parse(serialize(message));
    expect(Object.keys(JSON.parse(serialize(message)))).toEqual([
      "id",
      "time",
      "expires",
      "event",
      "topic",
      "title",
      "message",
      "priority",
      "tags",
      "click",
      "icon",
      "attachment",
      "content_type",
    ]);
    expect(expires - time).toBe(43200);
    expect(rest).toEqual({
      event: "message",
      topic: "t",
      title: "T",
      message: "hello",
      priority: 4,
      tags: ["warning", "skull"],
      click: "https://x.y",
      icon: "https://i.png",
      attachment: { name: "flower.jpg", url: "https://example.com/files/flower.jpg?x=1" },
      content_type: "text/markdown",
    });
  });

  test("query params, header wins; body wins over message param; \\n in params", async () => {
    expect((await fromHeaders({}, "", "?message=a%5Cnb&t=qt&p=5&ta=x,y")).message).toMatchObject({
      message: "a\nb",
      title: "qt",
      priority: 5,
      tags: ["x", "y"],
    });
    expect((await fromHeaders({ Title: "header" }, "body", "?title=query&message=param")).message).toMatchObject({
      title: "header",
      message: "body",
    });
    expect((await fromHeaders({}, "")).message.message).toBe("triggered");
    expect((await fromHeaders({}, "  spaced \n\n")).message.message).toBe("spaced");
  });

  test("RFC 2047 encoded headers", () => {
    expect(decodeRfc2047("=?UTF-8?B?w6TDtsO8?=")).toBe("äöü");
    expect(decodeRfc2047("=?utf-8?q?caf=C3=A9_ol=C3=A9?=")).toBe("café olé");
  });

  test("large, binary or named bodies become attachments", async () => {
    const big = await fromHeaders({}, "a".repeat(5000));
    expect(big.message.message).toBe("You received a file: attachment.txt");
    expect(big.message.attachment).toMatchObject({
      name: "attachment.txt",
      type: "text/plain; charset=utf-8",
      size: 5000,
      url: `https://ntfy.test/file/${big.message.id}.txt`,
    });
    expect(big.file?.length).toBe(5000);
    const named = await fromHeaders({ Filename: "f.txt", Message: "see file" }, "small");
    expect(named.message).toMatchObject({ message: "see file", attachment: { name: "f.txt", size: 5 } });
    const png = await buildJob(
      { topic: "t", body: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0xff]) },
      ctx,
    );
    expect(png.message.attachment).toMatchObject({ name: "attachment.png", type: "image/png" });
  });

  test("UnifiedPush: binary bodies are base64, never attachments", async () => {
    const { message, file } = await buildJob(
      { topic: "up1", unifiedPush: true, body: Uint8Array.from([0xff, 0xfe, 0x00, 0x01]) },
      ctx,
    );
    expect(message).toMatchObject({ message: "//4AAQ==", encoding: "base64" });
    expect(file).toBeUndefined();
  });

  test("scheduling and cache rules", async () => {
    const delayed = await fromHeaders({ In: "30m" }, "later");
    expect(delayed.message.time).toBe(ctx.now / 1000 + 1800);
    expect(delayed.message.expires).toBe(ctx.now / 1000 + 1800 + 43200);
    await expect(fromHeaders({ Delay: "5s" })).rejects.toThrow("too small");
    await expect(fromHeaders({ Delay: "10d" })).rejects.toThrow("too large");
    await expect(fromHeaders({ Delay: "1h", Cache: "no" })).rejects.toThrow("cannot disable cache");
    await expect(fromHeaders({ Delay: "1h", Timezone: "Mars/Olympus" })).rejects.toThrow("timezone");
    const noCache = await fromHeaders({ Cache: "no" }, "x");
    expect(noCache.cache).toBe(false);
    expect(noCache.message.expires).toBeUndefined();
  });

  test("validation errors", async () => {
    await expect(fromHeaders({ Priority: "9" })).rejects.toThrow("invalid priority");
    await expect(fromHeaders({ Title: "t".repeat(1100) })).rejects.toThrow("title is too large");
    await expect(fromHeaders({ Icon: "ftp://x" })).rejects.toThrow("icon URL is invalid");
    await expect(fromHeaders({ Attach: "notaurl" })).rejects.toThrow("attachment URL is invalid");
    await expect(fromHeaders({ Email: "a@b.c" })).rejects.toThrow("e-mail notifications are not enabled");
    await expect(fromHeaders({ Template: "github" })).rejects.toThrow("templates are not supported");
  });

  test("poll requests and sequence events", async () => {
    expect((await fromHeaders({ "X-Poll-ID": "abc" }, "x")).message).toMatchObject({
      event: "poll_request",
      message: "New message",
      poll_id: "abc",
    });
    const del = await buildJob({ topic: "t", event: "message_delete", sequenceId: "s1" }, ctx);
    expect(Object.keys(JSON.parse(serialize(del.message)))).toEqual([
      "id",
      "sequence_id",
      "time",
      "expires",
      "event",
      "topic",
    ]);
  });
});

describe("publish as JSON", () => {
  test("fields", async () => {
    const f = fieldsFromJson(
      enc(
        JSON.stringify({
          topic: "t",
          message: "j",
          title: "tt",
          tags: ["a"],
          priority: 2,
          actions: [{ action: "http", label: "x", url: "https://h", headers: { a: "b" } }],
          markdown: true,
          sequence_id: "seq1",
        }),
      ),
    );
    const { message } = await buildJob(f, ctx);
    expect(message).toMatchObject({
      sequence_id: "seq1",
      title: "tt",
      message: "j",
      priority: 2,
      tags: ["a"],
      content_type: "text/markdown",
    });
    expect(message.actions?.[0]).toMatchObject({
      action: "http",
      label: "x",
      clear: false,
      url: "https://h",
      headers: { a: "b" },
    });
  });
  test("errors match the official server", () => {
    expect(() => fieldsFromJson(enc('{"topic":"t","priority":"high"}'))).toThrow("request body must be valid JSON");
    expect(() => fieldsFromJson(enc('{"message":"x"}'))).toThrow("topic invalid");
    expect(() => fieldsFromJson(enc("notjson"))).toThrow("request body must be valid JSON");
  });
});
