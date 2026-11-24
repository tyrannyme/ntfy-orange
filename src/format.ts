import { type Message, serialize } from "./message";

export type Format = "json" | "sse" | "raw";

export const CONTENT_TYPES: Record<Format, string> = {
  json: "application/x-ndjson; charset=utf-8",
  sse: "text/event-stream; charset=utf-8",
  raw: "text/plain; charset=utf-8",
};

/** Renders one event the way the official server does for each stream format. */
export function format(m: Message, f: Format): string {
  switch (f) {
    case "json":
      return serialize(m) + "\n";
    case "sse":
      // Only control events get an `event:` line; message/delete/clear are plain `data:`.
      return m.event === "open" || m.event === "keepalive" || m.event === "poll_request"
        ? `event: ${m.event}\ndata: ${serialize(m)}\n\n`
        : `data: ${serialize(m)}\n\n`;
    case "raw":
      return m.event === "message" ? `${(m.message ?? "").replace(/\r?\n/g, " ")}\n` : "\n";
  }
}
