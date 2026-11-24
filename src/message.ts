import { randomId, nowSeconds } from "./util";

export type EventType = "open" | "keepalive" | "message" | "message_delete" | "message_clear" | "poll_request";

export interface Action {
  id: string;
  action: "view" | "broadcast" | "http" | "copy";
  label: string;
  clear: boolean;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  intent?: string;
  extras?: Record<string, string>;
  value?: string;
}

export interface Attachment {
  name: string;
  type?: string;
  size?: number;
  expires?: number;
  url: string;
}

export interface Message {
  id: string;
  sequence_id?: string;
  time: number;
  expires?: number;
  event: EventType;
  topic: string;
  title?: string;
  message?: string;
  priority?: number;
  tags?: string[];
  click?: string;
  icon?: string;
  actions?: Action[];
  attachment?: Attachment;
  poll_id?: string;
  content_type?: string;
  encoding?: string;
}

// Field order matches the official server's output. JSON clients don't care, but it
// makes side-by-side comparisons with the reference server trivial.
const FIELD_ORDER: (keyof Message)[] = [
  "id",
  "sequence_id",
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
  "actions",
  "attachment",
  "poll_id",
  "content_type",
  "encoding",
];

export function serialize(m: Message): string {
  const ordered: Record<string, unknown> = {};
  for (const key of FIELD_ORDER) {
    const value = m[key];
    if (value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0)) ordered[key] = value;
  }
  return JSON.stringify(ordered);
}

export function controlEvent(event: "open" | "keepalive", topics: string[]): Message {
  return { id: randomId(), time: nowSeconds(), event, topic: topics.join(",") };
}

/** Subscriber-side filters (`id`, `message`, `title`, `priority`, `tags`). */
export interface Filters {
  id?: string;
  message?: string;
  title?: string;
  priority?: number[];
  tags?: string[];
}

export function matchesFilters(m: Message, f: Filters): boolean {
  if (m.event !== "message") return f.id === undefined || f.id === m.id;
  if (f.id !== undefined && f.id !== m.id) return false;
  if (f.message !== undefined && f.message !== m.message) return false;
  if (f.title !== undefined && f.title !== m.title) return false;
  if (f.priority?.length && !f.priority.includes(m.priority ?? 3)) return false;
  if (f.tags?.length) {
    const have = new Set((m.tags ?? []).map((t) => t.toLowerCase()));
    if (!f.tags.every((t) => have.has(t.toLowerCase()))) return false;
  }
  return true;
}
