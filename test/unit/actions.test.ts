import { describe, expect, test } from "bun:test";
import { parseActionsHeader } from "../../src/actions";
import { HttpError } from "../../src/errors";

const strip = (actions: ReturnType<typeof parseActionsHeader>) =>
  actions.map(({ id, ...rest }) => (expect(id).toMatch(/^[A-Za-z0-9]{10}$/), rest));

describe("X-Actions simple format", () => {
  test("short form for every action type", () => {
    const actions = parseActionsHeader(
      'http, "Turn down", https://api.nest.com/, body="{\\"temp\\": 65}", headers.Authorization=Bearer zAzsx1sk, method=PUT, clear=true; broadcast, Take pic, extras.cmd=pic, extras.camera=front; copy, Copy, 1234',
    );
    // Output verified against the official server (black-box).
    expect(strip(actions)).toEqual([
      {
        action: "http",
        label: "Turn down",
        clear: true,
        url: "https://api.nest.com/",
        method: "PUT",
        headers: { Authorization: "Bearer zAzsx1sk" },
        body: '{"temp": 65}',
      },
      { action: "broadcast", label: "Take pic", clear: false, extras: { camera: "front", cmd: "pic" } },
      { action: "copy", label: "Copy", clear: false, value: "1234" },
    ]);
  });

  test("key=value form, quotes and URLs containing '='", () => {
    const actions = parseActionsHeader("action=view, label='a, b', url=https://x.com/?q=1&r=2;http,y,https://z");
    expect(strip(actions)).toEqual([
      { action: "view", label: "a, b", clear: false, url: "https://x.com/?q=1&r=2" },
      { action: "http", label: "y", clear: false, url: "https://z" },
    ]);
  });

  test("semicolons inside quotes", () => {
    const [a] = parseActionsHeader('view, "Open; now", https://example.com');
    expect(a?.label).toBe("Open; now");
  });

  test("broadcast intent and JSON array form", () => {
    expect(strip(parseActionsHeader("broadcast, x, intent=com.foo.BAR"))).toEqual([
      { action: "broadcast", label: "x", clear: false, intent: "com.foo.BAR" },
    ]);
    expect(strip(parseActionsHeader('[{"action":"view","label":"x","url":"https://x"}]'))).toEqual([
      { action: "view", label: "x", clear: false, url: "https://x" },
    ]);
  });

  test.each([
    ["view, x", "parameter 'url' is required for action 'view'"],
    ["foo, bar", "parameter 'action' cannot be 'foo'"],
    ["http, x, https://h, foo=bar", "key 'foo' unknown"],
    ["view, a, https://a; view, b, https://b; view, c, https://c; view, d, https://d", "only 3 actions allowed"],
    ['view, "unterminated, https://x', "unterminated quote"],
    ["copy, Copy", "parameter 'value' is required"],
  ])("rejects %p", (input, message) => {
    expect(() => parseActionsHeader(input)).toThrow(HttpError);
    expect(() => parseActionsHeader(input)).toThrow(message);
  });
});
