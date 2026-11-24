// Errors use the same JSON shape and codes as the official server, so clients that
// surface `error`/`code` (the Android app does) show meaningful messages.

const DOCS = "https://ntfy.sh/docs";

export class HttpError extends Error {
  constructor(
    readonly http: number,
    readonly code: number,
    message: string,
    readonly link?: string,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
  }

  toJSON() {
    return { code: this.code, http: this.http, error: this.message, ...(this.link ? { link: this.link } : {}) };
  }
}

const invalid = (code: number, what: string, link?: string) =>
  new HttpError(400, code, `invalid request: ${what}`, link);

export const errors = {
  notFound: () => new HttpError(404, 40401, "page not found"),
  methodNotAllowed: () => new HttpError(405, 40501, "method not allowed"),
  unauthorized: () => new HttpError(401, 40101, "unauthorized", `${DOCS}/publish/#authentication`),
  forbidden: () => new HttpError(403, 40301, "forbidden", `${DOCS}/publish/#authentication`),
  emailDisabled: () =>
    new HttpError(400, 40001, "e-mail notifications are not enabled", `${DOCS}/config/#e-mail-notifications`),
  callsDisabled: () => new HttpError(400, 40034, "phone calls are not enabled", `${DOCS}/config/#phone-calls`),
  delayNoCache: () => new HttpError(400, 40002, "cannot disable cache for delayed message"),
  delayNoEmail: () => new HttpError(400, 40003, "delayed e-mail notifications are not supported"),
  delayInvalid: () =>
    new HttpError(400, 40004, "invalid delay parameter: unable to parse delay", `${DOCS}/publish/#scheduled-delivery`),
  delayTooSmall: () =>
    new HttpError(
      400,
      40005,
      "invalid delay parameter: too small, please refer to the docs",
      `${DOCS}/publish/#scheduled-delivery`,
    ),
  delayTooLarge: () =>
    new HttpError(
      400,
      40006,
      "invalid delay parameter: too large, please refer to the docs",
      `${DOCS}/publish/#scheduled-delivery`,
    ),
  timezoneInvalid: () => invalid(40044, "invalid timezone", `${DOCS}/publish/#scheduled-delivery`),
  priorityInvalid: () => new HttpError(400, 40007, "invalid priority parameter", `${DOCS}/publish/#message-priority`),
  sinceInvalid: () =>
    new HttpError(400, 40008, "invalid since parameter", `${DOCS}/subscribe/api/#fetch-cached-messages`),
  topicInvalid: () => invalid(40009, "topic invalid"),
  topicDisallowed: () => invalid(40010, "topic name is not allowed"),
  attachUrlInvalid: () => invalid(40013, "attachment URL is invalid", `${DOCS}/publish/#attachments`),
  attachmentsDisabled: () => invalid(40014, "attachments not allowed", `${DOCS}/config/#attachments`),
  actionsInvalid: (why: string) => invalid(40018, `actions invalid; ${why}`, `${DOCS}/publish/#action-buttons`),
  iconUrlInvalid: () => invalid(40021, "icon URL is invalid", `${DOCS}/publish/#icons`),
  jsonInvalid: () => invalid(40024, "request body must be valid JSON"),
  sequenceIdInvalid: () => invalid(40049, "sequence ID invalid"),
  titleTooLarge: () => invalid(40057, "title is too large", `${DOCS}/publish/#limitations`),
  tagsTooLarge: () => invalid(40058, "tags are too large", `${DOCS}/publish/#limitations`),
  tooManyTopics: () => invalid(40060, "too many topics"),
  templatesUnsupported: () => invalid(40061, "message templates are not supported by this server"),
  messageTooLarge: () => new HttpError(413, 41301, "message too large"),
  attachmentTooLarge: () =>
    new HttpError(413, 41302, "attachment too large, or bandwidth limit reached", `${DOCS}/publish/#limitations`),
  attachmentStorageFull: () =>
    new HttpError(
      413,
      41303,
      "attachment too large, or total attachment storage limit reached",
      `${DOCS}/publish/#limitations`,
    ),
  attachmentExpired: () => new HttpError(410, 41001, "attachment has expired"),
  noToken: () => invalid(40023, "no token provided"),
  tokenFieldInvalid: (why: string) => invalid(40062, why),
  tooManyTokens: (max: number) => invalid(40063, `too many tokens (at most ${max} per user)`),
  tokenNotFound: () => new HttpError(404, 40402, "token not found"),
  tokenProvisioned: () => new HttpError(409, 40906, "conflict: cannot change or delete provisioned token"),
  config: (what: string) => new HttpError(500, 50001, `server misconfigured: ${what}`),
};
