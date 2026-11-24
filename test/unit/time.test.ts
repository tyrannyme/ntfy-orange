import { describe, expect, test } from "bun:test";
import { parseDelay, parseSince } from "../../src/time";
import { parseDuration, parseSize } from "../../src/util";

// Tue Nov 24 2026 03:10:42 UTC
const NOW = Date.UTC(2026, 10, 24, 3, 10, 42);
const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

describe("parseDelay (cases verified against the official server)", () => {
  test.each([
    ["1am", "2026-11-25T01:00:00Z"], // already passed today: tomorrow
    ["11pm", "2026-11-24T23:00:00Z"],
    ["tomorrow", "2026-11-25T03:10:42Z"],
    ["noon", "2026-11-24T12:00:00Z"], // the official server keeps the current seconds (12:00:42)
    ["in 2 hours", "2026-11-24T05:10:42Z"],
    ["2026-11-25T10:00:00Z", "2026-11-25T10:00:00Z"],
    ["30min", "2026-11-24T03:40:42Z"],
    ["1795500000", "2026-11-24T06:00:00Z"],
    ["45 seconds", "2026-11-24T03:11:27Z"],
    ["1h30m", "2026-11-24T04:40:42Z"],
    ["tomorrow at 5pm", "2026-11-25T17:00:00Z"],
    ["5pm tomorrow", "2026-11-25T17:00:00Z"],
    ["tomorrow, 3pm", "2026-11-25T15:00:00Z"],
    ["friday 9:30", "2026-11-27T09:30:00Z"],
    ["2 days", "2026-11-26T03:10:42Z"],
  ])("%p", (input, expected) => {
    expect(parseDelay(input, "UTC", NOW)).toBe(at(expected));
  });

  test("timezones", () => {
    // Verified: "tomorrow, 10am" in Asia/Tokyo == 2026-11-25T01:00:00Z
    expect(parseDelay("tomorrow, 10am", "Asia/Tokyo", NOW)).toBe(at("2026-11-25T01:00:00Z"));
    expect(parseDelay("9am", "America/New_York", NOW)).toBe(at("2026-11-24T14:00:00Z"));
  });

  test.each(["", "banana", "25pm", "tomorrow banana", "13:99"])("rejects %p", (input) => {
    expect(parseDelay(input, "UTC", NOW)).toBeUndefined();
  });
});

describe("parseSince", () => {
  test("variants", () => {
    expect(parseSince(undefined, { kind: "none" })).toEqual({ kind: "none" });
    expect(parseSince("all", { kind: "none" })).toEqual({ kind: "all" });
    expect(parseSince("latest", { kind: "none" })).toEqual({ kind: "latest" });
    expect(parseSince("1645970742", { kind: "none" })).toEqual({ kind: "time", time: 1645970742 });
    expect(parseSince("10m", { kind: "none" }, NOW)).toEqual({ kind: "time", time: NOW / 1000 - 600 });
    expect(parseSince("nFS3knfcQ1xe", { kind: "none" })).toEqual({ kind: "id", id: "nFS3knfcQ1xe" });
    expect(parseSince("4OutulyP2sK4", { kind: "none" })).toEqual({ kind: "id", id: "4OutulyP2sK4" });
    expect(() => parseSince("garbage!", { kind: "none" })).toThrow("invalid since parameter");
  });
});

describe("durations and sizes", () => {
  test("durations", () => {
    expect(parseDuration("45s")).toBe(45);
    expect(parseDuration("12h")).toBe(43200);
    expect(parseDuration("7d")).toBe(604800);
    expect(parseDuration("1 hour 30 minutes")).toBe(5400);
    expect(parseDuration("5x")).toBeUndefined();
  });
  test("sizes", () => {
    expect(parseSize("4K", 0)).toBe(4096);
    expect(parseSize("15M", 0)).toBe(15 * 1024 * 1024);
    expect(parseSize("1G", 0)).toBe(1024 ** 3);
    expect(parseSize("", 7)).toBe(7);
    expect(() => parseSize("lots", 0)).toThrow();
  });
});
