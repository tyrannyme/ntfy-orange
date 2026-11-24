import { describe, expect, test } from "bun:test";
import { format } from "../../src/format";
import { type Message, matchesFilters } from "../../src/message";
import { detectType } from "../../src/mime";

const msg: Message = {
  id: "abc",
  time: 1,
  event: "message",
  topic: "t",
  message: "multi\nline",
  priority: 4,
  tags: ["a", "B"],
};

describe("stream formats", () => {
  test("json", () =>
    expect(format(msg, "json")).toBe(
      '{"id":"abc","time":1,"event":"message","topic":"t","message":"multi\\nline","priority":4,"tags":["a","B"]}\n',
    ));
  test("sse: event line only for control events", () => {
    expect(format(msg, "sse")).toStartWith("data: {");
    expect(format({ ...msg, event: "message_delete" }, "sse")).toStartWith("data: {");
    expect(format({ id: "x", time: 1, event: "keepalive", topic: "t" }, "sse")).toStartWith(
      "event: keepalive\ndata: {",
    );
  });
  test("raw: newlines become spaces, other events are empty lines", () => {
    expect(format(msg, "raw")).toBe("multi line\n");
    expect(format({ id: "x", time: 1, event: "open", topic: "t" }, "raw")).toBe("\n");
  });
});

describe("filters", () => {
  test("priority is OR, tags are AND (case-insensitive)", () => {
    expect(matchesFilters(msg, { priority: [4, 5] })).toBe(true);
    expect(matchesFilters(msg, { priority: [5] })).toBe(false);
    expect(matchesFilters(msg, { tags: ["A", "b"] })).toBe(true);
    expect(matchesFilters(msg, { tags: ["a", "c"] })).toBe(false);
    expect(matchesFilters({ ...msg, priority: undefined }, { priority: [3] })).toBe(true);
    expect(matchesFilters(msg, { title: "nope" })).toBe(false);
  });
});

describe("mime detection", () => {
  const bytes = (...b: number[]) => Uint8Array.from(b);
  test.each([
    [bytes(0xff, 0xd8, 0xff, 0xe0), undefined, "image/jpeg", "jpg"],
    [new TextEncoder().encode("%PDF-1.7"), undefined, "application/pdf", "pdf"],
    [bytes(0x50, 0x4b, 0x03, 0x04, 0), "app.apk", "application/vnd.android.package-archive", "apk"],
    [bytes(0x50, 0x4b, 0x03, 0x04, 0), undefined, "application/zip", "zip"],
    [new TextEncoder().encode("héllo"), "notes.bin", "text/plain; charset=utf-8", "txt"],
    [bytes(0xff, 0xfe, 0x00), undefined, "application/octet-stream", "bin"],
  ])("%#", (data, name, type, ext) => expect(detectType(data, name)).toEqual({ type, ext }));
});
