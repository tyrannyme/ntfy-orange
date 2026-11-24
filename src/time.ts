import { errors } from "./errors";
import { parseDuration } from "./util";

/**
 * Parses an `X-Delay`/`At`/`In` value into a Unix timestamp (seconds). Supported:
 * Unix timestamps, RFC 3339, durations ("30m", "2 days", "1h30m", "in 2 hours") and a
 * small natural-language subset ("10am", "8:30pm", "noon", "tomorrow, 3pm",
 * "friday 9:30", "5pm tomorrow"). Times that already passed today roll over to tomorrow.
 */
export function parseDelay(input: string, timezone: string, now = Date.now()): number | undefined {
  const s = input.trim().toLowerCase();
  if (s === "") return undefined;
  if (/^\d+$/.test(s)) return Number(s);
  if (/^\d{4}-\d{2}-\d{2}t/.test(s)) {
    const t = Date.parse(input.trim());
    return Number.isNaN(t) ? undefined : Math.floor(t / 1000);
  }
  const duration = parseDuration(s.replace(/^in\s+/, ""));
  if (duration !== undefined) return Math.floor(now / 1000) + duration;
  return parseNatural(s, timezone, now);
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function parseNatural(s: string, timezone: string, now: number): number | undefined {
  let rest = ` ${s.replace(/[,]/g, " ")} `;
  let dayOffset: number | undefined;
  let weekday: number | undefined;

  const take = (re: RegExp) => {
    const m = re.exec(rest);
    if (m) rest = rest.replace(m[0], " ");
    return m;
  };
  if (take(/\stoday\s/)) dayOffset = 0;
  else if (take(/\stomorrow\s/)) dayOffset = 1;
  else {
    const m = take(
      new RegExp(`\\s(?:next\\s+)?(${WEEKDAYS.join("|")}|${WEEKDAYS.map((d) => d.slice(0, 3)).join("|")})\\s`),
    );
    if (m) weekday = WEEKDAYS.findIndex((d) => d.startsWith(m[1]!));
  }

  let hour: number | undefined;
  let minute = 0;
  const time = take(/\s(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s/);
  if (time) {
    hour = Number(time[1]);
    minute = time[2] ? Number(time[2]) : 0;
    const ampm = time[3];
    if (!ampm && !time[2] && dayOffset === undefined && weekday === undefined) return undefined; // bare number
    if (ampm) {
      if (hour < 1 || hour > 12) return undefined;
      hour = (hour % 12) + (ampm === "pm" ? 12 : 0);
    }
    if (hour > 23 || minute > 59) return undefined;
  } else if (take(/\snoon\s/)) hour = 12;
  else if (take(/\smidnight\s/)) hour = 0;

  rest = rest.replace(/\s(at|on)\s/g, " ");
  if (rest.trim() !== "") return undefined;
  if (hour === undefined && dayOffset === undefined && weekday === undefined) return undefined;

  const local = wallClock(now, timezone);
  const h = hour ?? local.hour;
  const min = hour === undefined ? local.minute : minute;
  const sec = hour === undefined ? local.second : 0;
  let days = dayOffset ?? 0;
  if (weekday !== undefined) {
    days = (weekday - local.weekday + 7) % 7;
    if (days === 0 && /next/.test(s)) days = 7;
  }
  let t = fromWallClock(
    { year: local.year, month: local.month, day: local.day + days, hour: h, minute: min, second: sec },
    timezone,
  );
  if (t * 1000 <= now && dayOffset === undefined) {
    t = fromWallClock(
      {
        year: local.year,
        month: local.month,
        day: local.day + days + (weekday !== undefined ? 7 : 1),
        hour: h,
        minute: min,
        second: sec,
      },
      timezone,
    );
  }
  return t;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function wallClock(epochMs: number, timeZone: string): WallClock & { weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    weekday: "long",
  }).formatToParts(new Date(epochMs));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: WEEKDAYS.indexOf(get("weekday").toLowerCase()),
  };
}

/** Converts a wall-clock time in `timeZone` to Unix seconds (handles DST via two passes). */
function fromWallClock(w: WallClock, timeZone: string): number {
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  let guess = asUtc;
  for (let i = 0; i < 2; i++) {
    const local = wallClock(guess, timeZone);
    const localAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
    guess = asUtc - (localAsUtc - guess);
  }
  return Math.floor(guess / 1000);
}

export type Since =
  | { kind: "none" }
  | { kind: "all" }
  | { kind: "latest" }
  | { kind: "time"; time: number }
  | { kind: "id"; id: string };

/** Parses the subscriber `since=` parameter (duration, Unix timestamp, message ID, all, latest, none). */
export function parseSince(input: string | undefined, fallback: Since, now = Date.now()): Since {
  if (input === undefined || input === "") return fallback;
  const s = input.trim();
  if (s === "all") return { kind: "all" };
  if (s === "latest") return { kind: "latest" };
  if (s === "none") return { kind: "none" };
  if (/^\d+$/.test(s)) return { kind: "time", time: Number(s) };
  const d = parseDuration(s);
  if (d !== undefined) return { kind: "time", time: Math.floor(now / 1000) - d };
  if (/^[A-Za-z0-9]{12}$/.test(s)) return { kind: "id", id: s };
  throw errors.sinceInvalid();
}
