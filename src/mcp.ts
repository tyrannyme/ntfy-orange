import { normalizeActions } from "./actions";
import { can, type Identity } from "./auth";
import { HttpError, errors } from "./errors";
import type { SubscribeRequest } from "./hub";
import { type Ctx, identify, json, publishFields } from "./http";
import type { Filters, Message } from "./message";
import {
  type PublishFields,
  SEQUENCE_ID_RE,
  TOPIC_RE,
  DISALLOWED_TOPICS,
  parsePriority,
  readBody,
  splitTags,
} from "./publish";
import { parseSince } from "./time";

/**
 * A stateless MCP server over Streamable HTTP (JSON responses only, no SSE, no sessions)
 * at `/v1/mcp`. It authenticates exactly like the ntfy API and enforces the same ACL.
 */
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const VERSION = "0.1.0";
const MAX_BODY = 64 * 1024;
const MAX_BATCH = 10;

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

class ToolError extends Error {}

const TOOLS = [
  {
    name: "publish",
    title: "Publish notification",
    description:
      "Send a push notification to an ntfy topic. Subscribed phones (ntfy Android/iOS app) and other clients receive it immediately, or at `delay` if set.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Topic name ([-_A-Za-z0-9], max 64 chars)" },
        message: { type: "string", description: "Notification body" },
        title: { type: "string" },
        priority: {
          type: ["integer", "string"],
          description: "1-5 or min/low/default/high/max/urgent (5/max/urgent = long vibration and pop-over)",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags; emoji short codes (e.g. warning, white_check_mark) render as emojis",
        },
        markdown: { type: "boolean", description: "Render the message as Markdown" },
        click: { type: "string", description: "URL opened when the notification is tapped" },
        icon: { type: "string", description: "URL of a JPEG/PNG icon" },
        attach: { type: "string", description: "URL of a file to attach" },
        filename: { type: "string", description: "File name for the attachment" },
        delay: {
          type: "string",
          description: "Schedule delivery: duration (30m, 2h), Unix time, RFC 3339, or e.g. 'tomorrow, 9am'",
        },
        actions: {
          type: "array",
          maxItems: 3,
          description:
            "Up to 3 action buttons, e.g. {action:'view',label:'Open',url:'https://...'} or {action:'http',label:'Approve',url:'https://...',method:'POST',body:'yes'}",
          items: { type: "object" },
        },
        sequence_id: {
          type: "string",
          description: "Reuse to update/replace an earlier notification of the same sequence",
        },
      },
      required: ["topic"],
    },
  },
  {
    name: "get_messages",
    title: "Get notifications",
    description: "Fetch cached notifications from one or more topics, oldest first.",
    inputSchema: {
      type: "object",
      properties: {
        topics: { type: "array", items: { type: "string" }, minItems: 1 },
        since: {
          type: "string",
          description: "Duration (10m, 1d), Unix time, message ID, 'all' (default) or 'latest'",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description: "Return at most this many of the newest messages (default 50)",
        },
        priority: { type: "string", description: "Only these priorities, comma-separated (e.g. 'high,urgent')" },
        tags: { type: "array", items: { type: "string" }, description: "Only messages that have all of these tags" },
        scheduled: { type: "boolean", description: "Include messages scheduled for later delivery" },
      },
      required: ["topics"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "wait_for_message",
    title: "Wait for a notification",
    description:
      "Block until a new message arrives on one of the topics (or the timeout passes). Combine with `publish` and an `http` action button that posts to a reply topic to ask a human a question and wait for the answer.",
    inputSchema: {
      type: "object",
      properties: {
        topics: { type: "array", items: { type: "string" }, minItems: 1 },
        timeout_seconds: { type: "integer", minimum: 1, maximum: 300, description: "Default 60" },
        since: {
          type: "string",
          description: "Message ID: also return a message published after it, if one was missed",
        },
      },
      required: ["topics"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "delete_notification",
    title: "Delete or clear a notification",
    description:
      "Delete (remove) or clear (mark read and dismiss) a delivered notification, or cancel a scheduled one, by sequence ID (the message ID if none was set).",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string" },
        sequence_id: { type: "string" },
        mode: { type: "string", enum: ["delete", "clear"], description: "Default 'delete'" },
      },
      required: ["topic", "sequence_id"],
    },
    annotations: { destructiveHint: true },
  },
  {
    name: "list_topics",
    title: "List topics",
    description: "List readable topics that have cached messages or live subscribers.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
];

export async function handleMcp(ctx: Ctx): Promise<Response> {
  const { request, url, config } = ctx;
  if (!config.mcpEnabled) throw errors.notFound();
  if (request.method !== "POST") return json({ error: "use POST (stateless Streamable HTTP)" }, 405, { Allow: "POST" });

  const hasCredentials = request.headers.has("authorization") || url.searchParams.has("auth");
  let user: Identity;
  try {
    if (!hasCredentials && config.users.size > 0) throw errors.unauthorized();
    user = await identify(ctx);
  } catch (err) {
    if (err instanceof HttpError && err.http === 401) {
      return json(err.toJSON(), 401, { "WWW-Authenticate": 'Bearer realm="ntfy"' });
    }
    throw err;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(await readBody(request, MAX_BODY, errors.messageTooLarge)));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    return json(rpcError(null, -32700, "Parse error"), 400);
  }
  if (Array.isArray(payload)) {
    if (payload.length > MAX_BATCH) return json(rpcError(null, -32600, `At most ${MAX_BATCH} requests per batch`), 400);
    const results = (await Promise.all(payload.map((r) => dispatch(ctx, user, r)))).filter((r) => r !== undefined);
    return results.length ? json(results) : new Response(null, { status: 202 });
  }
  const result = await dispatch(ctx, user, payload);
  return result === undefined ? new Response(null, { status: 202 }) : json(result);
}

async function dispatch(ctx: Ctx, user: Identity, raw: unknown): Promise<object | undefined> {
  const req = raw as RpcRequest;
  if (typeof req !== "object" || req === null || req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    return rpcError(null, -32600, "Invalid Request");
  }
  const isNotification = req.id === undefined;
  if (isNotification) return undefined;
  const id = req.id ?? null;
  switch (req.method) {
    case "initialize": {
      const requested = String(req.params?.protocolVersion ?? "");
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "ntfy-orange", title: "ntfy (Cloudflare)", version: VERSION },
        instructions:
          "Publish push notifications to the user's phone and read notification history via ntfy topics. " +
          "Use publish for alerts, get_messages to read history, wait_for_message to wait for replies.",
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS });
    case "tools/call": {
      const name = String(req.params?.name ?? "");
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const data = await callTool(ctx, user, name, args);
        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });
      } catch (err) {
        if (err instanceof ToolError || err instanceof HttpError) {
          return rpcResult(id, { content: [{ type: "text", text: err.message }], isError: true });
        }
        if (err instanceof UnknownTool) return rpcError(id, -32602, `Unknown tool: ${name}`);
        throw err;
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${req.method}`);
  }
}

class UnknownTool extends Error {}

async function callTool(
  ctx: Ctx,
  user: Identity,
  name: string,
  a: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { config } = ctx;
  const str = (k: string) => (a[k] === undefined || a[k] === null ? undefined : String(a[k]));
  const topicArg = (k = "topic") => {
    const t = str(k);
    if (!t || !TOPIC_RE.test(t) || DISALLOWED_TOPICS.has(t)) throw new ToolError(`invalid topic "${t ?? ""}"`);
    return t;
  };
  const topicsArg = () => {
    const raw = Array.isArray(a.topics)
      ? a.topics.map(String)
      : typeof a.topics === "string"
        ? splitTags(a.topics)
        : [];
    if (raw.length === 0 || raw.some((t) => !TOPIC_RE.test(t)))
      throw new ToolError("topics must be a non-empty list of topic names");
    for (const t of raw) if (!can(config, user, t, "read")) throw new ToolError(`no read access to topic "${t}"`);
    return [...new Set(raw)];
  };
  const requireWrite = (t: string) => {
    if (!can(config, user, t, "write")) throw new ToolError(`no write access to topic "${t}"`);
  };

  switch (name) {
    case "publish": {
      const topic = topicArg();
      requireWrite(topic);
      if (a.tags !== undefined && !Array.isArray(a.tags)) throw new ToolError("tags must be an array of strings");
      const fields: PublishFields = {
        topic,
        message: str("message"),
        title: str("title"),
        priority: typeof a.priority === "number" ? a.priority : str("priority"),
        tags: (a.tags as unknown[] | undefined)?.map(String),
        click: str("click"),
        icon: str("icon"),
        attach: str("attach"),
        filename: str("filename"),
        markdown: a.markdown === true,
        delay: str("delay"),
        actions: a.actions === undefined ? undefined : normalizeActions(a.actions),
        sequenceId: str("sequence_id"),
      };
      return { ...(await publishFields(ctx, fields)) };
    }
    case "get_messages": {
      const topics = topicsArg();
      const limit = Math.min(500, Math.max(1, Number(a.limit ?? 50) || 50));
      const filters: Filters = {};
      if (str("priority")) filters.priority = splitTags(str("priority")).map((p) => parsePriority(p) ?? 3);
      if (Array.isArray(a.tags) && a.tags.length) filters.tags = a.tags.map(String);
      const since = parseSince(str("since"), { kind: "all" });
      const { messages, truncated } = await ctx.hub.poll({
        topics,
        since,
        scheduled: a.scheduled === true,
        filters,
        limit,
      });
      return { messages, truncated };
    }
    case "wait_for_message": {
      const topics = topicsArg();
      const timeout = Math.min(300, Math.max(1, Number(a.timeout_seconds ?? 60) || 60));
      const since = str("since") ? parseSince(str("since"), { kind: "none" }) : ({ kind: "none" } as const);
      const message = await waitForMessage(ctx, topics, since, timeout * 1000);
      return message ? { message } : { timeout: true };
    }
    case "delete_notification": {
      const topic = topicArg();
      requireWrite(topic);
      const sequenceId = str("sequence_id");
      if (!sequenceId || !SEQUENCE_ID_RE.test(sequenceId)) throw new ToolError("invalid sequence_id");
      const event = str("mode") === "clear" ? "message_clear" : "message_delete";
      return { ...(await publishFields(ctx, { topic, sequenceId, event })) };
    }
    case "list_topics": {
      const topics = (await ctx.hub.topics()).filter((t) => can(config, user, t.topic, "read"));
      return { topics };
    }
    default:
      throw new UnknownTool();
  }
}

async function waitForMessage(
  ctx: Ctx,
  topics: string[],
  since: SubscribeRequest["since"],
  timeoutMs: number,
): Promise<Message | null> {
  const sub: SubscribeRequest = { topics, filters: {}, since, scheduled: false, kind: "stream" };
  const res = await ctx.hub.fetch("https://hub/subscribe", {
    headers: { upgrade: "websocket", "x-ntfy-subscribe": JSON.stringify(sub) },
  });
  const ws = res.webSocket;
  if (!ws) throw new ToolError("could not subscribe");
  ws.accept();
  return new Promise((resolve) => {
    let settled = false;
    const done = (m: Message | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close(1000, "done");
      } catch {
        // already closed
      }
      resolve(m);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(String(e.data)) as Message;
      if (m.event === "message") done(m);
    });
    ws.addEventListener("close", () => done(null));
    ws.addEventListener("error", () => done(null));
  });
}

const rpcResult = (id: RpcRequest["id"], result: object) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: RpcRequest["id"] | null, code: number, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});
