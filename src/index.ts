import { createToken, deleteToken, getAccount, updateToken } from "./account";
import { accountPage } from "./account-page";
import { authorize, type Identity } from "./auth";
import { type Config, attachmentsEnabled, loadConfig } from "./config";
import type { Env } from "./env";
import { HttpError, errors } from "./errors";
import { CONTENT_TYPES, type Format, format } from "./format";
import type { SubscribeRequest } from "./hub";
import { handleMcp } from "./mcp";
import { type Message, serialize } from "./message";
import { CORS, type Ctx, html, identify, json, parseFilters, publishFields } from "./http";
import { landingPage } from "./page";
import { Params } from "./params";
import {
  DISALLOWED_TOPICS,
  type PublishFields,
  SEQUENCE_ID_RE,
  TOPIC_RE,
  fieldsFromJson,
  fieldsFromRequest,
  readBody,
} from "./publish";
import { parseSince } from "./time";
import { truthy } from "./util";

export { Hub } from "./hub";

const MAX_TOPICS_PER_SUBSCRIPTION = 150;

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (err) {
      if (err instanceof HttpError) return json(err.toJSON(), err.http, err.headers);
      console.error(err);
      return json(errors.config(err instanceof Error ? err.message : String(err)).toJSON(), 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method;
  if (method === "OPTIONS") {
    return new Response(null, {
      headers: {
        ...CORS,
        "Access-Control-Allow-Methods": "GET, PUT, POST, PATCH, DELETE",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  let config: Config;
  try {
    config = loadConfig(env);
  } catch (err) {
    throw errors.config(err instanceof Error ? err.message : String(err));
  }
  const ctx: Ctx = {
    request,
    url,
    env,
    config,
    baseUrl: config.baseUrl ?? url.origin,
    hub: env.HUB.getByName("hub"),
  };

  const path = url.pathname.length > 1 ? url.pathname.replace(/\/$/, "") : url.pathname;
  const parts = path.split("/").slice(1).map(safeDecode);
  const isGet = method === "GET" || method === "HEAD";
  const isPublish = method === "POST" || method === "PUT";

  if (path === "/") {
    if (isGet) return html(landingPage(ctx.baseUrl));
    if (isPublish) return publishJson(ctx);
    throw errors.methodNotAllowed();
  }
  if (path === "/v1/health" && isGet) return json({ healthy: true });
  if (path === "/v1/config" && isGet) return json(webConfig());
  if (path === "/v1/mcp") return handleMcp(ctx);
  if (path === "/v1/account" && isGet) return getAccount(ctx);
  if (path === "/v1/account/token") {
    if (method === "POST") return createToken(ctx);
    if (method === "PATCH") return updateToken(ctx);
    if (method === "DELETE") return deleteToken(ctx);
    throw errors.methodNotAllowed();
  }
  if (path === "/account" && isGet) return accountPage(ctx);
  if (parts[0] === "file" && parts.length === 2 && isGet) return downloadFile(ctx, parts[1]!);
  if (path === "/_matrix/push/v1/notify") return matrix(ctx);

  const [topicPart, second, third] = parts;
  if (!topicPart || parts.length > 3) throw errors.notFound();

  if (parts.length === 1) {
    if (isGet) {
      if (!TOPIC_RE.test(topicPart)) throw errors.notFound();
      return html(landingPage(ctx.baseUrl, topicPart));
    }
    if (isPublish) return publish(ctx, topicPart, {});
    throw errors.notFound();
  }
  if (parts.length === 2 && isGet && (second === "json" || second === "sse" || second === "raw" || second === "ws")) {
    return subscribe(ctx, topicPart, second);
  }
  if (parts.length === 2 && isGet && second === "auth") {
    const topics = parseTopics(topicPart);
    authorize(config, await identify(ctx), topics, "read");
    return json({ success: true });
  }
  if (
    parts.length === 2 &&
    (second === "publish" || second === "send" || second === "trigger") &&
    (isGet || isPublish)
  ) {
    return publish(ctx, topicPart, {});
  }
  if (parts.length === 2 && second && SEQUENCE_ID_RE.test(second)) {
    if (isPublish) return publish(ctx, topicPart, { sequenceId: second });
    if (method === "DELETE") return publish(ctx, topicPart, { sequenceId: second, event: "message_delete" });
  }
  if (parts.length === 3 && second && SEQUENCE_ID_RE.test(second)) {
    if ((third === "clear" || third === "read") && (isGet || isPublish)) {
      return publish(ctx, topicPart, { sequenceId: second, event: "message_clear" });
    }
    if (third === "delete" && (isGet || isPublish || method === "DELETE")) {
      return publish(ctx, topicPart, { sequenceId: second, event: "message_delete" });
    }
  }
  throw errors.notFound();
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw errors.notFound();
  }
}

// ---- Publishing -------------------------------------------------------------------------

function checkTopic(topic: string): void {
  if (!TOPIC_RE.test(topic)) throw errors.notFound();
  if (DISALLOWED_TOPICS.has(topic)) throw errors.topicDisallowed();
}

async function publish(ctx: Ctx, topic: string, overrides: Partial<PublishFields>): Promise<Response> {
  checkTopic(topic);
  const { request, url, config } = ctx;
  const user = await identify(ctx);
  authorize(config, user, [topic], "write");
  let body: Uint8Array = new Uint8Array();
  if (!overrides.event) {
    const limit = attachmentsEnabled(config)
      ? Math.max(config.attachmentFileSizeLimit, config.messageSizeLimit)
      : config.messageSizeLimit;
    body = await readBody(
      request,
      limit,
      attachmentsEnabled(config) ? errors.attachmentTooLarge : errors.messageTooLarge,
    );
  }
  const fields = overrides.event ? { topic } : fieldsFromRequest(request.headers, url, topic, body);
  return commit(ctx, { ...fields, ...overrides });
}

async function publishJson(ctx: Ctx): Promise<Response> {
  const { request, config } = ctx;
  const user = await identify(ctx);
  const body = await readBody(request, config.messageSizeLimit * 4 + 16384, errors.messageTooLarge);
  const fields = fieldsFromJson(body);
  checkTopic(fields.topic);
  authorize(config, user, [fields.topic], "write");
  return commit(ctx, fields);
}

async function commit(ctx: Ctx, fields: PublishFields): Promise<Response> {
  const message = await publishFields(ctx, fields);
  return new Response(serialize(message) + "\n", { headers: { ...CORS, "Content-Type": "application/json" } });
}

// ---- Subscribing ------------------------------------------------------------------------

function parseTopics(list: string): string[] {
  const topics = [...new Set(list.split(","))];
  if (topics.some((t) => !TOPIC_RE.test(t))) throw errors.notFound();
  if (topics.length > MAX_TOPICS_PER_SUBSCRIPTION) throw errors.tooManyTopics();
  return topics;
}

async function subscribe(ctx: Ctx, topicList: string, kind: Format | "ws"): Promise<Response> {
  const { request, url, config, hub } = ctx;
  const topics = parseTopics(topicList);
  const user: Identity = await identify(ctx);
  authorize(config, user, topics, "read");

  const p = new Params(request.headers, url);
  const poll = truthy(p.get("x-poll", "poll", "po"));
  const since = parseSince(p.get("x-since", "since", "si"), poll ? { kind: "all" } : { kind: "none" });
  const scheduled = truthy(p.get("x-scheduled", "scheduled", "sched"));
  const filters = parseFilters(p);
  // The subscription is stored with the socket, which allows at most 16 KB.
  if (JSON.stringify({ topics, filters }).length > 15_000) throw errors.tooManyTopics();

  if (kind === "ws") {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      throw new HttpError(400, 40016, "invalid request: expected WebSocket upgrade");
    const sub: SubscribeRequest = { topics, filters, since, scheduled, kind: "ws" };
    return hub.fetch("https://hub/subscribe", {
      headers: { upgrade: "websocket", "x-ntfy-subscribe": JSON.stringify(sub) },
    });
  }

  const headers = { ...CORS, "Content-Type": CONTENT_TYPES[kind] };
  if (poll) {
    const { messages, truncated } = await hub.poll({ topics, since, scheduled, filters });
    const body = messages.map((m) => format(m, kind)).join("");
    return new Response(body, { headers: truncated ? { ...headers, "X-Messages-Truncated": "1" } : headers });
  }
  return proxyStream(ctx, { topics, filters, since, scheduled, kind: "stream" }, kind, headers);
}

/**
 * HTTP streams (json/sse/raw) are served by the Worker, which holds a WebSocket to the
 * Durable Object. The DO side is hibernatable, so a phone keeping a JSON stream open
 * all day doesn't keep the Durable Object (and its duration billing) awake.
 */
async function proxyStream(
  ctx: Ctx,
  sub: SubscribeRequest,
  kind: Format,
  headers: Record<string, string>,
): Promise<Response> {
  const res = await ctx.hub.fetch("https://hub/subscribe", {
    headers: { upgrade: "websocket", "x-ntfy-subscribe": JSON.stringify(sub) },
  });
  const ws = res.webSocket;
  if (!ws) return res;
  ws.accept();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      ws.close(1000, "client disconnected");
    } catch {
      // already closed
    }
    writer.close().catch(() => {});
  };
  ws.addEventListener("message", (event) => {
    if (closed) return;
    const m = JSON.parse(String(event.data)) as Message;
    writer.write(encoder.encode(format(m, kind))).catch(close);
  });
  ws.addEventListener("close", close);
  ws.addEventListener("error", close);
  ctx.request.signal?.addEventListener("abort", close);
  return new Response(readable, {
    headers: {
      ...headers,
      "Cache-Control": "no-cache, no-transform",
      "Content-Encoding": "identity",
      "X-Accel-Buffering": "no",
    },
  });
}

// ---- Files, Matrix, misc -------------------------------------------------------------------

async function downloadFile(ctx: Ctx, name: string): Promise<Response> {
  const id = name.split(".")[0] ?? "";
  if (!/^[A-Za-z0-9]{12}$/.test(id)) throw errors.notFound();
  const file = await ctx.hub.file(id);
  if (!file) throw errors.notFound();
  const headers = {
    ...CORS,
    "Content-Type": file.type,
    "Content-Length": String(file.size),
    // Never render uploaded content on this origin.
    "Content-Disposition": contentDisposition(file.name),
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox",
  };
  return new Response(ctx.request.method === "HEAD" ? null : file.data, { headers });
}

/** ASCII fallback plus RFC 5987 `filename*` so non-ASCII names survive. */
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return ascii === name
    ? `attachment; filename="${name}"`
    : `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Matrix Push Gateway (`/_matrix/push/v1/notify`), forwarding to the topic in the pushkey. */
async function matrix(ctx: Ctx): Promise<Response> {
  const { request, config, baseUrl } = ctx;
  if (request.method === "GET") return json({ unifiedpush: { gateway: "matrix" } });
  if (request.method !== "POST") throw errors.methodNotAllowed();
  const body = await readBody(request, config.messageSizeLimit, errors.messageTooLarge);
  let pushKey: unknown;
  try {
    pushKey = JSON.parse(new TextDecoder().decode(body))?.notification?.devices?.[0]?.pushkey;
  } catch {
    throw errors.jsonInvalid();
  }
  if (typeof pushKey !== "string") throw errors.jsonInvalid();
  let topic: string | undefined;
  try {
    const key = new URL(pushKey);
    if (key.origin === new URL(baseUrl).origin) topic = key.pathname.slice(1);
  } catch {
    // invalid URL
  }
  if (!topic || !TOPIC_RE.test(topic) || DISALLOWED_TOPICS.has(topic)) return json({ rejected: [pushKey] });
  const user = await identify(ctx);
  authorize(config, user, [topic], "write");
  await publishFields(ctx, { topic, body, unifiedPush: true });
  return json({ rejected: [] });
}

function webConfig() {
  return {
    base_url: "",
    app_root: "/",
    enable_login: false,
    require_login: false,
    enable_signup: false,
    enable_payments: false,
    enable_calls: false,
    enable_emails: false,
    enable_reservations: false,
    enable_web_push: false,
    billing_contact: "",
    web_push_public_key: "",
    disallowed_topics: [...DISALLOWED_TOPICS],
  };
}
