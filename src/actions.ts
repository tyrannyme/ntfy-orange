import { errors } from "./errors";
import type { Action } from "./message";
import { randomId } from "./util";

const MAX_ACTIONS = 3;
const TYPES = ["view", "broadcast", "http", "copy"] as const;

interface Field {
  key?: string;
  value: string;
}

/** Parses the `X-Actions` header: either a JSON array or the simple `;`/`,` format. */
export function parseActionsHeader(input: string): Action[] {
  const trimmed = input.trim();
  if (trimmed === "") return [];
  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw errors.actionsInvalid("JSON array is invalid");
    }
    return normalizeActions(parsed);
  }
  const actions = tokenize(trimmed).map(fieldsToAction);
  return normalizeActions(actions);
}

/** Validates actions coming from JSON (publish-as-JSON or the JSON header form). */
export function normalizeActions(input: unknown): Action[] {
  if (!Array.isArray(input)) throw errors.actionsInvalid("expected a JSON array");
  if (input.length > MAX_ACTIONS) throw errors.actionsInvalid(`only ${MAX_ACTIONS} actions allowed`);
  return input.map((raw) => {
    if (typeof raw !== "object" || raw === null) throw errors.actionsInvalid("action must be an object");
    const a = raw as Record<string, unknown>;
    const type = String(a.action ?? "").toLowerCase();
    if (!(TYPES as readonly string[]).includes(type)) {
      throw errors.actionsInvalid(
        `parameter 'action' cannot be '${type}', valid values are 'view', 'broadcast', 'http' and 'copy'`,
      );
    }
    const str = (k: string) => (a[k] === undefined || a[k] === null ? undefined : String(a[k]));
    const action: Action = {
      id: randomId(10),
      action: type as Action["action"],
      label: str("label") ?? "",
      clear: a.clear === true || a.clear === "true" || a.clear === "1" || a.clear === "yes",
    };
    if (action.label === "") throw errors.actionsInvalid(`parameter 'label' is required`);
    const url = str("url");
    if (url !== undefined) action.url = url;
    if ((type === "view" || type === "http") && !url) {
      throw errors.actionsInvalid(`parameter 'url' is required for action '${type}'`);
    }
    if (type === "http") {
      if (str("method")) action.method = str("method")!.toUpperCase();
      if (a.headers !== undefined) action.headers = stringMap(a.headers, "headers");
      if (str("body") !== undefined) action.body = str("body");
    }
    if (type === "broadcast") {
      if (str("intent")) action.intent = str("intent");
      if (a.extras !== undefined) action.extras = stringMap(a.extras, "extras");
    }
    if (type === "copy") {
      action.value = str("value") ?? "";
      if (action.value === "") throw errors.actionsInvalid(`parameter 'value' is required for action 'copy'`);
    }
    return action;
  });
}

function stringMap(v: unknown, name: string): Record<string, string> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw errors.actionsInvalid(`'${name}' must be a map`);
  const entries = Object.entries(v).map(([k, val]): [string, string] => [k, String(val)]);
  return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function fieldsToAction(fields: Field[]): Record<string, unknown> {
  const action: Record<string, unknown> = {};
  const headers: Record<string, string> = {};
  const extras: Record<string, string> = {};
  let position = 0;
  for (const { key, value } of fields) {
    if (key === undefined) {
      // Positional fields: action, label, then url (view/http) or value (copy).
      const type = String(action.action ?? "");
      const slot = position === 0 ? "action" : position === 1 ? "label" : type === "copy" ? "value" : "url";
      if (position > 2) throw errors.actionsInvalid(`term '${value}' unknown`);
      action[slot] = value;
      position++;
      continue;
    }
    const k = key.toLowerCase();
    if (k.startsWith("headers.")) headers[key.slice(8)] = value;
    else if (k.startsWith("extras.")) extras[key.slice(7)] = value;
    else if (["action", "label", "url", "method", "body", "intent", "value", "clear"].includes(k)) {
      action[k] = k === "clear" ? ["true", "1", "yes"].includes(value.toLowerCase()) : value;
      if (k === "action") position = Math.max(position, 1);
      if (k === "label") position = Math.max(position, 2);
    } else throw errors.actionsInvalid(`key '${key}' unknown`);
  }
  if (Object.keys(headers).length) action.headers = headers;
  if (Object.keys(extras).length) action.extras = extras;
  return action;
}

const KEY = /^[A-Za-z][\w.-]*$/;

/**
 * Splits the simple format into actions (`;`) and fields (`,`). A value may be wrapped in
 * single or double quotes to contain `,` or `;`; inside quotes, a backslash escapes the next char.
 */
export function tokenize(input: string): Field[][] {
  const actions: Field[][] = [];
  let fields: Field[] = [];
  let buf = "";
  let key: string | undefined;
  let quote: string | undefined;
  let quoted = false; // current value was quoted, so keep inner whitespace

  const endField = () => {
    const value = quoted ? buf : buf.trim();
    if (key !== undefined || value !== "" || quoted) fields.push({ key, value });
    buf = "";
    key = undefined;
    quoted = false;
  };
  const endAction = () => {
    endField();
    if (fields.length) actions.push(fields);
    fields = [];
  };

  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quote) {
      if (c === "\\" && i + 1 < input.length) buf += input[++i];
      else if (c === quote) quote = undefined;
      else buf += c;
      continue;
    }
    if ((c === '"' || c === "'") && buf.trim() === "" && !quoted) {
      quote = c;
      quoted = true;
      buf = "";
    } else if (c === "=" && key === undefined && !quoted && KEY.test(buf.trim())) {
      key = buf.trim();
      buf = "";
    } else if (c === ",") endField();
    else if (c === ";") endAction();
    else if (!quoted) buf += c;
  }
  if (quote) throw errors.actionsInvalid("unterminated quote");
  endAction();
  return actions;
}
