import { normalizeActions, parseActionsHeader } from "./actions";
import { type Config, attachmentsEnabled } from "./config";
import { HttpError, errors } from "./errors";
import type { Action, Attachment, EventType, Message } from "./message";
import { detectType } from "./mime";
import { Params } from "./params";
import { isValidTimezone, parseDelay } from "./time";
import { bytesToBase64, falsy, isHttpUrl, isValidUtf8, randomId, sha256Hex, truthy } from "./util";

export const TOPIC_RE = /^[-_A-Za-z0-9]{1,64}$/;
export const SEQUENCE_ID_RE = /^[-_A-Za-z0-9]{1,64}$/;
/** Same reserved names as the official server, so topic URLs never shadow API paths. */
export const DISALLOWED_TOPICS = new Set([
  "docs",
  "static",
  "file",
  "app",
  "metrics",
  "account",
  "settings",
  "signup",
  "login",
  "v1",
]);

/** What the Worker hands to the Durable Object. */
export interface PublishJob {
  message: Message;
  cache: boolean;
  /** Delivered later by the DO alarm. Explicit, so Worker/DO clock skew can't matter. */
  scheduled?: boolean;
  /** Raw bytes of an uploaded attachment. */
  file?: Uint8Array;
  /** SHA-256 topic name on the upstream server (iOS poll requests), if enabled. */
  upstreamTopic?: string;
}

/** Source-independent publish fields (headers/query, JSON body, MCP tool call). */
export interface PublishFields {
  topic: string;
  event?: EventType;
  message?: string;
  title?: string;
  priority?: string | number;
  tags?: string[];
  click?: string;
  icon?: string;
  attach?: string;
  filename?: string;
  markdown?: boolean;
  delay?: string;
  timezone?: string;
  email?: string;
  call?: string;
  actions?: Action[];
  sequenceId?: string;
  cache?: boolean;
  pollId?: string;
  unifiedPush?: boolean;
  body?: Uint8Array;
}

export interface PublishContext {
  config: Config;
  baseUrl: string;
  now?: number;
}

const PRIORITIES: Record<string, number> = { min: 1, low: 2, default: 3, high: 4, max: 5, urgent: 5 };

export function parsePriority(value: string | number | undefined): number | undefined {
  if (value === undefined || value === "" || value === 0) return undefined;
  if (typeof value === "number") {
    if (Number.isInteger(value) && value >= 1 && value <= 5) return value;
    throw errors.priorityInvalid();
  }
  const v = value.trim().toLowerCase();
  if (/^[1-5]$/.test(v)) return Number(v);
  const p = PRIORITIES[v];
  if (p === undefined) throw errors.priorityInvalid();
  return p;
}

export const splitTags = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");

const utf8Length = (s: string) => new TextEncoder().encode(s).length;

/** Builds the final message (id, time, expiry, attachment metadata) from publish fields. */
export async function buildJob(f: PublishFields, ctx: PublishContext): Promise<PublishJob> {
  const { config } = ctx;
  const nowMs = ctx.now ?? Date.now();
  const now = Math.floor(nowMs / 1000);
  if (f.email) throw errors.emailDisabled();
  if (f.call) throw errors.callsDisabled();
  if (f.sequenceId !== undefined && !SEQUENCE_ID_RE.test(f.sequenceId)) throw errors.sequenceIdInvalid();

  const id = randomId();
  const event: EventType = f.pollId ? "poll_request" : (f.event ?? "message");
  const cache = f.cache !== false && config.cacheDuration > 0 && event !== "poll_request";

  // Scheduled delivery.
  let time = now;
  if (f.delay && event === "message") {
    const tz = f.timezone || config.timezone;
    if (!isValidTimezone(tz)) throw errors.timezoneInvalid();
    if (!cache) throw errors.delayNoCache();
    const at = parseDelay(f.delay, tz, nowMs);
    if (at === undefined) throw errors.delayInvalid();
    if (at < now + config.messageDelayMin) throw errors.delayTooSmall();
    if (at > now + config.messageDelayMax) throw errors.delayTooLarge();
    time = at;
  }
  const expires = cache ? time + config.cacheDuration : undefined;
  const message: Message = { id, time, event, topic: f.topic };
  if (expires !== undefined) message.expires = expires;
  if (f.sequenceId) message.sequence_id = f.sequenceId;
  if (event === "message_delete" || event === "message_clear") return { message, cache };
  if (event === "poll_request") {
    return { message: { ...message, message: "New message", poll_id: f.pollId }, cache: false };
  }

  if (f.title !== undefined && f.title !== "") {
    if (utf8Length(f.title) > 1024) throw errors.titleTooLarge();
    message.title = f.title;
  }
  const priority = parsePriority(f.priority);
  if (priority !== undefined) message.priority = priority;
  if (f.tags?.length) {
    if (utf8Length(f.tags.join(",")) > 512) throw errors.tagsTooLarge();
    message.tags = f.tags;
  }
  if (f.click) message.click = f.click;
  if (f.icon) {
    if (!isHttpUrl(f.icon)) throw errors.iconUrlInvalid();
    message.icon = f.icon;
  }
  if (f.actions?.length) message.actions = f.actions;
  if (f.markdown) message.content_type = "text/markdown";

  // Body: either the message text, or an uploaded file.
  const body = f.body ?? new Uint8Array();
  let text = f.message?.trim() || undefined;
  let file: Uint8Array | undefined;
  if (f.attach) {
    if (!isHttpUrl(f.attach)) throw errors.attachUrlInvalid();
    message.attachment = { name: f.filename || nameFromUrl(f.attach), url: f.attach };
  }
  if (body.length > 0) {
    // Only small bodies can be message text, so skip validating large uploads (CPU time).
    const utf8 = body.length <= config.messageSizeLimit && isValidUtf8(body);
    if (f.unifiedPush) {
      if (body.length > config.messageSizeLimit) throw errors.messageTooLarge();
      if (utf8) text = new TextDecoder().decode(body).trim() || text;
      else {
        text = bytesToBase64(body);
        message.encoding = "base64";
      }
    } else if (!f.attach && (f.filename || body.length > config.messageSizeLimit || !utf8)) {
      if (!attachmentsEnabled(config)) {
        throw body.length > config.messageSizeLimit || !utf8 ? errors.messageTooLarge() : errors.attachmentsDisabled();
      }
      if (body.length > config.attachmentFileSizeLimit) throw errors.attachmentTooLarge();
      const detected = detectType(body, f.filename);
      const attachment: Attachment = {
        name: f.filename || `attachment.${detected.ext}`,
        type: detected.type,
        size: body.length,
        expires: Math.min(now + config.attachmentExpiry, expires ?? Number.MAX_SAFE_INTEGER),
        url: `${ctx.baseUrl}/file/${id}.${detected.ext}`,
      };
      message.attachment = attachment;
      file = body;
      text ??= `You received a file: ${attachment.name}`;
    } else {
      text = new TextDecoder().decode(body).trim() || text;
    }
  }
  if (text !== undefined && utf8Length(text) > config.messageSizeLimit && message.encoding === undefined) {
    throw errors.messageTooLarge();
  }
  message.message = text ?? "triggered";

  const job: PublishJob = { message, cache };
  if (time > now) job.scheduled = true;
  if (file) job.file = file;
  if (config.upstreamBaseUrl && event === "message") job.upstreamTopic = await sha256Hex(`${ctx.baseUrl}/${f.topic}`);
  return job;
}

function nameFromUrl(url: string): string {
  const last = new URL(url).pathname.split("/").pop();
  return last && last.length > 0 ? decodeURIComponent(last) : "attachment";
}

/** Reads publish fields from headers/query parameters (`POST /<topic>`, `GET /<topic>/publish`). */
export function fieldsFromRequest(headers: Headers, url: URL, topic: string, body: Uint8Array): PublishFields {
  const p = new Params(headers, url);
  const template = p.get("x-template", "template", "tpl");
  if (template !== undefined && !falsy(template)) throw errors.templatesUnsupported();
  const actions = p.get("x-actions", "actions", "action");
  const cache = p.get("x-cache", "cache");
  const firebase = p.get("x-firebase", "firebase");
  void firebase; // There is no Firebase here; accepted and ignored for compatibility.
  const message = p.get("x-message", "message", "m");
  const contentType = headers.get("content-type") ?? "";
  return {
    topic,
    message: message?.replace(/\\n/g, "\n"),
    title: p.get("x-title", "title", "ti", "t"),
    priority: p.get("x-priority", "priority", "prio", "p"),
    tags: splitTags(p.get("x-tags", "tags", "tag", "ta")),
    click: p.get("x-click", "click"),
    icon: p.get("x-icon", "icon"),
    attach: p.get("x-attach", "attach", "a"),
    filename: p.get("x-filename", "filename", "file", "f"),
    markdown: truthy(p.get("x-markdown", "markdown", "md")) || /^text\/markdown\b/i.test(contentType),
    delay: p.get("x-delay", "delay", "x-at", "at", "x-in", "in"),
    timezone: p.get("x-timezone", "timezone"),
    email: p.get("x-email", "x-e-mail", "email", "e-mail", "mail", "e"),
    call: p.get("x-call", "call"),
    actions: actions ? parseActionsHeader(actions) : undefined,
    sequenceId: p.get("x-sequence-id", "sequence-id", "sid"),
    cache: !falsy(cache),
    pollId: p.get("x-poll-id", "poll-id"),
    unifiedPush: truthy(p.get("x-unifiedpush", "unifiedpush", "up")),
    body,
  };
}

/** Reads publish fields from a JSON body posted to the root URL. */
export function fieldsFromJson(body: Uint8Array): PublishFields {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw errors.jsonInvalid();
  }
  if (typeof j !== "object" || j === null || Array.isArray(j)) throw errors.jsonInvalid();
  const str = (k: string): string | undefined => {
    const v = j[k];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string") throw errors.jsonInvalid();
    return v;
  };
  const topic = str("topic");
  if (!topic || !TOPIC_RE.test(topic)) throw errors.topicInvalid();
  if (j.priority !== undefined && typeof j.priority !== "number") throw errors.jsonInvalid();
  if (j.tags !== undefined && !(Array.isArray(j.tags) && j.tags.every((t) => typeof t === "string"))) {
    throw errors.jsonInvalid();
  }
  if (j.markdown !== undefined && typeof j.markdown !== "boolean") throw errors.jsonInvalid();
  return {
    topic,
    message: str("message"),
    title: str("title"),
    priority: j.priority as number | undefined,
    tags: (j.tags as string[] | undefined)?.map((t) => t.trim()).filter(Boolean),
    click: str("click"),
    icon: str("icon"),
    attach: str("attach"),
    filename: str("filename"),
    markdown: j.markdown === true,
    delay: str("delay"),
    timezone: str("timezone"),
    email: str("email"),
    call: str("call"),
    actions: j.actions === undefined || j.actions === null ? undefined : normalizeActions(j.actions),
    sequenceId: str("sequence_id"),
    cache: j.cache !== false && j.cache !== "no",
  };
}

/** Reads a request body, enforcing a size limit without buffering more than the limit. */
export async function readBody(req: Request, limit: number, error: () => HttpError): Promise<Uint8Array> {
  const declared = Number(req.headers.get("content-length") ?? "NaN");
  if (declared > limit) throw error();
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw error();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
