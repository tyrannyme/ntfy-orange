import { type Identity, authenticate } from "./auth";
import type { Config } from "./config";
import type { Env } from "./env";
import { errors } from "./errors";
import type { Hub } from "./hub";
import type { Filters, Message } from "./message";
import type { Params } from "./params";
import { type PublishFields, buildJob, parsePriority, splitTags } from "./publish";
import { tokenLookup } from "./token-cache";

export const CORS = { "Access-Control-Allow-Origin": "*" };

export interface Ctx {
  request: Request;
  url: URL;
  env: Env;
  config: Config;
  baseUrl: string;
  hub: DurableObjectStub<Hub>;
}

/** Authenticates the request: passwords and NTFY_AUTH_TOKENS from config, API tokens from the hub. */
export function identify(ctx: Ctx): Promise<Identity> {
  const lookup = tokenLookup(ctx.hub, ctx.request.headers.get("cf-connecting-ip") ?? undefined);
  return authenticate(ctx.request.headers, ctx.url, ctx.config, lookup);
}

export function json(body: unknown, status = 200, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body) + "\n", {
    status,
    headers: { ...CORS, "Content-Type": "application/json", ...extra },
  });
}

export function html(body: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
    },
  });
}

/** Builds and stores a message; shared by every publish path (HTTP, JSON, Matrix, MCP). */
export async function publishFields(ctx: Ctx, fields: PublishFields): Promise<Message> {
  const job = await buildJob(fields, { config: ctx.config, baseUrl: ctx.baseUrl });
  const result = await ctx.hub.publish(job);
  if (!result.ok) throw errors.attachmentStorageFull();
  return job.message;
}

export function parseFilters(p: Params): Filters {
  const filters: Filters = {};
  const id = p.get("x-id", "id");
  const message = p.get("x-message", "message", "m");
  const title = p.get("x-title", "title", "t");
  const priority = p.get("x-priority", "priority", "prio", "p");
  const tags = splitTags(p.get("x-tags", "tags", "tag", "ta"));
  if (id) filters.id = id;
  if (message) filters.message = message;
  if (title) filters.title = title;
  if (priority) filters.priority = splitTags(priority).map((v) => parsePriority(v) ?? 3);
  if (tags.length) filters.tags = tags;
  return filters;
}
