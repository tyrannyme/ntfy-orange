import { beforeAll, describe, expect, test } from "bun:test";
import { TOKEN, USERS, baseUrl, basic, uniqueTopic } from "./server";

/**
 * Differential test: sends identical requests to the official ntfy server (black box)
 * and to this implementation, then compares status, error codes, JSON key order and
 * values (ignoring IDs, timestamps and hostnames). Start a reference server with
 * `scripts/reference-server.sh` and set NTFY_REF_URL to enable.
 */
const REF = process.env.NTFY_REF_URL;

const ADMIN = { Authorization: basic(...USERS.admin) };
let ours: string;
beforeAll(async () => {
  if (REF) ours = await baseUrl();
}, 70_000);

interface Case {
  name: string;
  method?: string;
  path?: string; // appended to /<topic>; "@root" for the server root
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Runs before the request, on both servers (e.g. seed messages). */
  seed?: Omit<Case, "name" | "seed">[];
}

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const CASES: Case[] = [
  { name: "plain message", body: "hello" },
  { name: "empty body -> triggered", body: "" },
  { name: "whitespace is trimmed", body: "  spaced \n\n" },
  { name: "title, priority, tags", body: "x", headers: { Title: "T", Priority: "high", Tags: "warning,skull" } },
  { name: "priority names are case-insensitive", body: "x", headers: { Priority: "HIGH" } },
  { name: "explicit default priority is kept", body: "x", headers: { Priority: "3" } },
  { name: "priority 0 is invalid", body: "x", headers: { Priority: "0" } },
  { name: "priority 9 is invalid", body: "x", headers: { Priority: "9" } },
  { name: "empty and spaced tags", body: "x", headers: { Tags: "a,,b, c " } },
  {
    name: "click, icon, external attachment, markdown",
    body: "md",
    headers: {
      Click: "https://x.y",
      Icon: "https://i.png",
      Attach: "https://example.com/files/flower.jpg?x=1",
      Markdown: "yes",
    },
  },
  { name: "attachment URL without file name", body: "x", headers: { Attach: "https://example.com/" } },
  { name: "invalid icon URL", body: "x", headers: { Icon: "ftp://x" } },
  { name: "invalid attachment URL", body: "x", headers: { Attach: "notaurl" } },
  { name: "Content-Type: text/markdown", body: "x", headers: { "Content-Type": "text/markdown" } },
  { name: "RFC 2047 title", body: "x", headers: { Title: "=?UTF-8?B?w6TDtsO8?=" } },
  { name: "message header vs body", body: "body", headers: { Message: "header msg" } },
  { name: "message param with \\n", method: "POST", path: "?message=a%5Cnb" },
  { name: "query params", method: "POST", path: "?title=qt&priority=low&tags=a,b", body: "q" },
  { name: "GET /publish webhook", method: "GET", path: "/publish?message=hi%20there&title=tt&tags=a,b&priority=low" },
  { name: "GET /trigger", method: "GET", path: "/trigger" },
  { name: "GET /send short params", method: "GET", path: "/send?m=short&t=ti&p=5&ta=x" },
  { name: "title too large", body: "x", headers: { Title: "t".repeat(1100) } },
  { name: "e-mail not enabled", body: "x", headers: { Email: "a@b.c" } },
  { name: "Cache: no", body: "x", headers: { Cache: "no" } },
  { name: "Cache: no with delay", body: "x", headers: { Cache: "no", Delay: "1h" } },
  { name: "delay too large", body: "x", headers: { Delay: "10d" } },
  { name: "poll request", body: "x", headers: { "X-Poll-ID": "abc", Firebase: "no" } },
  {
    name: "actions: all types",
    body: "a",
    headers: {
      Actions:
        'http, "Turn down", https://api.nest.com/, body="{\\"temp\\": 65}", headers.Authorization=Bearer zAzsx1sk, method=PUT, clear=true; broadcast, Take pic, extras.cmd=pic, extras.camera=front; copy, Copy, 1234',
    },
  },
  {
    name: "actions: key=value and quotes",
    body: "a",
    headers: { Actions: "action=view, label='a, b', url=https://x;http,y,https://z" },
  },
  { name: "actions: broadcast intent", body: "a", headers: { Actions: "broadcast, x, intent=com.foo.BAR" } },
  {
    name: "actions: JSON header",
    body: "a",
    headers: { Actions: '[{"action":"view","label":"x","url":"https://x"}]' },
  },
  {
    name: "actions: too many",
    body: "a",
    headers: { Actions: "view, a, https://a; view, b, https://b; view, c, https://c; view, d, https://d" },
  },
  { name: "actions: unknown type", body: "a", headers: { Actions: "foo, bar" } },
  { name: "actions: missing url", body: "a", headers: { Actions: "view, x" } },
  { name: "actions: unknown key", body: "a", headers: { Actions: "http, x, https://h, foo=bar" } },
  { name: "small file with Filename", method: "PUT", body: "small", headers: { Filename: "f.txt" } },
  { name: "binary upload", method: "PUT", body: png },
  {
    name: "binary upload with name and message",
    method: "PUT",
    body: png,
    headers: { Filename: "cat.png", Message: "a cat" },
  },
  { name: "large text becomes an attachment", body: "a".repeat(5000) },
  { name: "UnifiedPush text", path: "?up=1", body: "plain text" },
  { name: "UnifiedPush binary", path: "?up=1", body: new Uint8Array([0xe0, 0xca, 0x1e, 0x5e, 0x28, 0xe3]) },
  { name: "sequence ID in path", path: "/myseq", body: "v1" },
  { name: "sequence ID header", headers: { SID: "myseq" }, body: "v2" },
  { name: "clear", method: "PUT", path: "/myseq/clear" },
  { name: "read (clear alias) via GET", method: "GET", path: "/myseq/read" },
  { name: "delete", method: "DELETE", path: "/myseq" },
  { name: "delete via GET", method: "GET", path: "/myseq/delete" },
  {
    name: "JSON publish",
    method: "POST",
    path: "@root",
    body: JSON.stringify({
      topic: "@topic",
      message: "j",
      title: "tt",
      tags: ["a"],
      priority: 2,
      actions: [{ action: "http", label: "x", url: "https://h", headers: { a: "b" } }],
      click: "https://c",
      attach: "https://a/b.png",
      filename: "f.png",
      markdown: true,
      icon: "https://i",
      sequence_id: "seq1",
    }),
  },
  {
    name: "JSON publish: string priority",
    method: "POST",
    path: "@root",
    body: JSON.stringify({ topic: "@topic", message: "j", priority: "high" }),
  },
  { name: "JSON publish: no topic", method: "POST", path: "@root", body: JSON.stringify({ message: "x" }) },
  { name: "JSON publish: not JSON", method: "POST", path: "@root", body: "notjson" },
  {
    name: "token API: anonymous create",
    method: "POST",
    path: "@v1/account/token",
    body: "{}",
    headers: { Authorization: "" },
  },
  { name: "token API: body not JSON", method: "POST", path: "@v1/account/token", body: "nope" },
  { name: "token API: delete without token", method: "DELETE", path: "@v1/account/token" },
  { name: "token API: patch without token", method: "PATCH", path: "@v1/account/token", body: '{"label":"x"}' },
  {
    name: "token API: delete provisioned token",
    method: "DELETE",
    path: "@v1/account/token",
    headers: { "X-Token": TOKEN },
  },
  {
    name: "token API: calling token is provisioned",
    method: "DELETE",
    path: "@v1/account/token",
    headers: { Authorization: `Bearer ${TOKEN}` },
  },
  { name: "disallowed topic", method: "POST", path: "@v1", body: "x" },
  { name: "invalid topic", method: "POST", path: "@Bad.Topic", body: "x" },
  { name: "anonymous on a private topic", body: "x", headers: { Authorization: "" } },
  { name: "wrong password", body: "x", headers: { Authorization: basic("phil", "wrong") } },
  { name: "unknown token", body: "x", headers: { Authorization: "Bearer tk_wrongwrongwrongwrongwrongwron" } },
  { name: "token via Basic with empty user", body: "x", headers: { Authorization: basic("", TOKEN) } },
  { name: "user without access", body: "x", headers: { Authorization: basic(...USERS.user) } },
  { name: "anonymous on public topic", method: "POST", path: "@public", body: "x", headers: { Authorization: "" } },
  // Subscriber-side queries against a seeded topic.
  ...(() => {
    const seed: Case["seed"] = [
      { body: "one", headers: { Priority: "high", Tags: "x,y" } },
      { body: "two", headers: { Title: "t2" } },
      { body: "multi\nline", headers: { Tags: "x" } },
      { body: "later", headers: { In: "1h" } },
    ];
    return [
      { name: "poll all", method: "GET", path: "/json?poll=1", seed },
      { name: "poll latest", method: "GET", path: "/json?poll=1&since=latest", seed },
      { name: "poll with scheduled", method: "GET", path: "/json?poll=1&sched=1", seed },
      { name: "poll unknown id", method: "GET", path: "/json?poll=1&since=AAAAAAAAAAAA", seed },
      { name: "poll since 1h", method: "GET", path: "/json?poll=1&since=1h", seed },
      { name: "poll since none", method: "GET", path: "/json?poll=1&since=none", seed },
      { name: "poll invalid since", method: "GET", path: "/json?poll=1&since=garbage!", seed },
      { name: "filter priority", method: "GET", path: "/json?poll=1&p=4,5", seed },
      { name: "filter tags", method: "GET", path: "/json?poll=1&tags=x", seed },
      { name: "filter title", method: "GET", path: "/json?poll=1&t=t2", seed },
      { name: "filter message", method: "GET", path: "/json?poll=1&message=two", seed },
      { name: "poll via headers", method: "GET", path: "/json", headers: { "X-Poll": "1", "X-Since": "all" }, seed },
      { name: "poll SSE", method: "GET", path: "/sse?poll=1", seed },
      { name: "poll raw", method: "GET", path: "/raw?poll=1", seed },
      { name: "auth check ok", method: "GET", path: "/auth" },
      { name: "auth check anonymous", method: "GET", path: "/auth", headers: { Authorization: "" } },
    ] as Case[];
  })(),
];

async function send(base: string, topic: string, c: Omit<Case, "name" | "seed">) {
  const path = c.path ?? "";
  const target =
    path === "@root" ? `${base}/` : path.startsWith("@") ? `${base}/${path.slice(1)}` : `${base}/${topic}${path}`;
  const headers: Record<string, string> = { ...ADMIN, ...c.headers };
  if (headers.Authorization === "") delete headers.Authorization;
  const body = typeof c.body === "string" ? c.body.replace("@topic", topic) : c.body;
  const res = await fetch(target, {
    method: c.method ?? "POST",
    headers,
    body: c.method === "GET" ? undefined : (body as BodyInit | undefined),
  });
  return { status: res.status, type: res.headers.get("content-type")?.split(";")[0], text: await res.text() };
}

/** Removes per-server noise: IDs, timestamps, hostnames, topic names. */
function normalize(text: string, topic: string, base: string): unknown {
  const lines = text.split("\n").filter((l) => l !== "");
  const norm = (v: unknown, key = ""): unknown => {
    if (Array.isArray(v)) return v.map((x) => norm(x));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x, k)]));
    if (typeof v === "number" && ["time", "expires"].includes(key)) return "<ts>";
    if (typeof v === "string" && key === "id") return "<id>";
    if (typeof v === "string")
      return v
        .replaceAll(base, "<base>")
        .replaceAll(topic, "<topic>")
        .replace(/\/file\/[A-Za-z0-9]{12}\./, "/file/<id>.");
    return v;
  };
  return lines.map((line) => {
    const json = line.replace(/^data: /, "");
    try {
      const parsed = JSON.parse(json);
      // Keep key order visible in the comparison.
      return { keys: Object.keys(parsed), value: norm(parsed), prefix: line.startsWith("data: ") ? "data: " : "" };
    } catch {
      return norm(line);
    }
  });
}

describe.skipIf(!REF)("compatibility with the official ntfy server", () => {
  test.each(CASES.map((c) => [c.name, c] as const))("%s", async (_, c) => {
    const results = [];
    for (const base of [REF!, ours]) {
      const topic = uniqueTopic("compat");
      for (const s of c.seed ?? []) await send(base, topic, s);
      const r = await send(base, topic, c);
      results.push({ status: r.status, type: r.type, body: normalize(r.text, topic, base) });
    }
    if (process.env.COMPAT_DEBUG) console.log(JSON.stringify(results));
    expect(results[1]).toEqual(results[0]!);
  });
});
