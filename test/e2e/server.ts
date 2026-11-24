import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

/**
 * Runs the real Worker + Durable Object in local workerd via `wrangler dev`, with a
 * throwaway state directory. Started once and shared by all e2e test files.
 */
export const USERS = { admin: ["phil", "phil-password"], user: ["ben", "ben-password"] } as const;
export const TOKEN = "tk_3gd7d2yftt4b8ixyfe9mnmro88o76";

export const TEST_VARS: Record<string, string> = {
  NTFY_AUTH_USERS: `phil:phil-password:admin,ben:ben-password:user`,
  NTFY_AUTH_TOKENS: `phil:${TOKEN}`,
  NTFY_AUTH_ACCESS: "ben:bentopic:rw,ben:readonly:ro,*:public:rw,*:up*:wo",
  NTFY_AUTH_DEFAULT_ACCESS: "deny-all",
  NTFY_KEEPALIVE_INTERVAL: "5s",
  NTFY_MESSAGE_DELAY_MIN: "1s",
  NTFY_ATTACHMENT_FILE_SIZE_LIMIT: "3M",
  NTFY_ATTACHMENT_TOTAL_SIZE_LIMIT: "5M",
  NTFY_BASE_URL: "",
};

let server: Promise<string> | undefined;
let proc: Subprocess | undefined;
let stateDir: string | undefined;

export function baseUrl(): Promise<string> {
  if (process.env.NTFY_TEST_URL) return Promise.resolve(process.env.NTFY_TEST_URL);
  server ??= start();
  return server;
}

async function start(): Promise<string> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  stateDir = mkdtempSync(join(tmpdir(), "ntfy-orange-e2e-"));
  const vars = Object.entries(TEST_VARS).flatMap(([k, v]) => ["--var", `${k}:${v}`]);
  proc = Bun.spawn(
    [
      "./node_modules/.bin/wrangler",
      "dev",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--persist-to",
      stateDir,
      "--show-interactive-dev-session=false",
      ...vars,
    ],
    {
      cwd: join(import.meta.dir, "../.."),
      detached: true, // own process group, so workerd children can be killed with it
      stdout: "ignore",
      stderr: "pipe",
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    },
  );
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${url}/v1/health`)).ok) return url;
    } catch {
      // not up yet
    }
    if (proc.exitCode !== null) break;
    await Bun.sleep(250);
  }
  const err = await new Response(proc.stderr as ReadableStream).text();
  throw new Error(`wrangler dev did not start:\n${err}`);
}

/** Stops wrangler and its workerd children (called from the global afterAll in test/setup.ts). */
export function stopServer(): void {
  if (proc?.pid) {
    try {
      process.kill(-proc.pid, "SIGTERM"); // the whole process group
    } catch {
      proc.kill();
    }
  }
  proc = undefined;
  server = undefined;
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  stateDir = undefined;
}

process.on("exit", stopServer);

// ---- helpers ---------------------------------------------------------------------

export const basic = (user: string, pass: string) => `Basic ${btoa(`${user}:${pass}`)}`;
export const ADMIN = { Authorization: basic(...USERS.admin) };
export const USER = { Authorization: basic(...USERS.user) };

export const uniqueTopic = (prefix = "t") => `${prefix}${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

export async function publish(
  topic: string,
  body: BodyInit | null = "hi",
  headers: Record<string, string> = {},
  path = "",
) {
  const res = await fetch(`${await baseUrl()}/${topic}${path}`, {
    method: "POST",
    body,
    headers: { ...ADMIN, ...headers },
  });
  return { res, json: (await res.json()) as Record<string, any> };
}

export async function poll(topics: string, query = "", headers: Record<string, string> = ADMIN) {
  const res = await fetch(`${await baseUrl()}/${topics}/json?poll=1${query}`, { headers });
  const text = await res.text();
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, any>);
}

/** Opens a WebSocket subscription and collects events. */
export async function openWs(topics: string, query = "") {
  const auth = btoa(ADMIN.Authorization).replace(/=+$/, "");
  const url = `${(await baseUrl()).replace(/^http/, "ws")}/${topics}/ws?auth=${auth}${query}`;
  const ws = new WebSocket(url);
  const events: Record<string, any>[] = [];
  const raw: string[] = [];
  ws.addEventListener("message", (e) => {
    raw.push(String(e.data));
    events.push(JSON.parse(String(e.data)));
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("websocket failed")));
  });
  return {
    ws,
    events,
    raw,
    waitFor: (pred: (e: Record<string, any>) => boolean, ms = 5000) => waitFor(events, pred, ms),
  };
}

export async function waitFor<T>(list: T[], pred: (e: T) => boolean, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = list.find(pred);
    if (hit) return hit;
    await Bun.sleep(25);
  }
  throw new Error(`timed out after ${ms}ms; got ${JSON.stringify(list)}`);
}

/** Reads an HTTP stream into lines until `until` matches or the timeout passes. */
export async function readStream(
  url: string,
  headers: Record<string, string>,
  until: (text: string) => boolean,
  ms = 5000,
  onOpen?: () => Promise<unknown>,
) {
  const controller = new AbortController();
  const res = await fetch(url, { headers, signal: controller.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const timer = setTimeout(() => controller.abort(), ms);
  let opened = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (!opened && onOpen) {
        opened = true;
        await onOpen();
      }
      if (until(text)) break;
    }
  } catch {
    // aborted
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return { res, text };
}
