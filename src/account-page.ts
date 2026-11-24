import type { Ctx } from "./http";
import { randomId } from "./util";

/**
 * `/account`: a small page to create, copy, edit and revoke access tokens. It talks to the
 * same `/v1/account` API as everything else; credentials stay in this browser tab.
 */
export function accountPage(ctx: Ctx): Response {
  const nonce = randomId(24);
  return new Response(page(nonce, new URL(ctx.baseUrl).host), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        "style-src 'unsafe-inline'",
        "connect-src 'self'",
        "img-src data:",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join("; "),
    },
  });
}

const page = (nonce: string, host: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Access tokens</title>
<style>
  :root { --bg: #fbfaf8; --fg: #1d1b18; --muted: #6b665e; --line: #e6e1d8; --card: #ffffff; --code: #f1ede6;
          --accent: #e8590c; --accent-fg: #ffffff; --danger: #c92a2a; --ok: #2b8a3e; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #161513; --fg: #ece8e1; --muted: #a39d93; --line: #2d2a26; --card: #1d1b19; --code: #22201d;
            --accent: #ff8a3d; --accent-fg: #1a1008; --danger: #ff6b6b; --ok: #69db7c; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 680px; margin: 0 auto; padding: 40px 16px 64px; }
  h1 { font-size: 26px; line-height: 1.2; margin: 0 0 4px; letter-spacing: -0.01em; }
  h1 span { color: var(--accent); }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 32px 0 10px; }
  .lede { color: var(--muted); margin: 0 0 24px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px; }
  label { display: block; font-size: 13px; color: var(--muted); margin: 0 0 4px; }
  input, select { width: 100%; font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--line);
                  border-radius: 7px; padding: 8px 10px; }
  input:focus, select:focus, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .grid .wide { grid-column: 1 / -1; }
  @media (max-width: 520px) { .grid { grid-template-columns: 1fr; } }
  .hint { font-size: 12.5px; color: var(--muted); margin-top: 4px; }
  button { font: inherit; cursor: pointer; border-radius: 7px; padding: 8px 14px; border: 1px solid var(--line);
           background: var(--bg); color: var(--fg); }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); font-weight: 600; }
  button.danger { color: var(--danger); }
  button:disabled { opacity: 0.6; cursor: default; }
  .actions { display: flex; gap: 8px; align-items: center; margin-top: 14px; flex-wrap: wrap; }
  .error { color: var(--danger); font-size: 14px; }
  .bar { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
  .muted { color: var(--muted); }
  code, pre { font: 13px/1.5 ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
  code { background: var(--code); padding: 2px 6px; border-radius: 5px; }
  pre { background: var(--code); border: 1px solid var(--line); border-radius: 7px; padding: 10px 12px; margin: 10px 0 0;
        overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
  .reveal { border-color: var(--accent); }
  .reveal .token { font: 600 15px/1.4 ui-monospace, "SF Mono", Menlo, Consolas, monospace; word-break: break-all;
                   background: var(--code); padding: 10px 12px; border-radius: 7px; margin: 8px 0 0; }
  ul.tokens { list-style: none; padding: 0; margin: 0; }
  ul.tokens li { display: flex; justify-content: space-between; gap: 12px; padding: 12px 0; border-top: 1px solid var(--line); }
  ul.tokens li:first-child { border-top: 0; padding-top: 0; }
  ul.tokens li:last-child { padding-bottom: 0; }
  ul.tokens li form { flex: 1; }
  .row-actions { display: flex; gap: 8px; align-items: flex-start; }
  .name { font-weight: 600; }
  .meta { font-size: 13px; color: var(--muted); }
  .empty { color: var(--muted); }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <h1>Access tokens<span>.</span></h1>
  <p class="lede">For apps, scripts and agents publishing to <code>${host}</code>. Create one token per client, so you can revoke it on its own.</p>

  <section id="login" class="card" hidden>
    <form id="login-form" class="grid">
      <div><label for="u">Username</label><input id="u" autocomplete="username" required></div>
      <div><label for="p">Password</label><input id="p" type="password" autocomplete="current-password" required></div>
      <div class="wide actions" style="margin-top:2px">
        <button class="primary" type="submit">Sign in</button><span id="login-error" class="error"></span>
      </div>
    </form>
  </section>

  <div id="app" hidden>
    <div class="bar"><span class="muted">Signed in as <strong id="who"></strong></span><button id="logout" type="button">Sign out</button></div>

    <h2>New token</h2>
    <section class="card">
      <form id="create-form" class="grid">
        <div class="wide"><label for="label">Name</label><input id="label" placeholder="e.g. Home Assistant, backup script" maxlength="200"></div>
        <div class="wide"><label for="topics">Topics</label><input id="topics" placeholder="All topics" autocapitalize="off" autocomplete="off" spellcheck="false">
          <div class="hint">Comma-separated. <code>*</code> is a wildcard, e.g. <code>alerts, backup-*</code>. Leave empty for every topic you can access.</div></div>
        <div><label for="permission">Can</label><select id="permission">
          <option value="read-write">Publish and read</option>
          <option value="write-only">Publish only</option>
          <option value="read-only">Read only</option></select></div>
        <div><label for="expires">Expires</label><select id="expires">
          <option value="0">Never</option><option value="7">In 7 days</option>
          <option value="30">In 30 days</option><option value="365">In a year</option></select></div>
        <div class="wide actions"><button class="primary" type="submit">Create token</button><span id="create-error" class="error"></span></div>
      </form>
    </section>

    <section id="reveal" class="card reveal" hidden style="margin-top:12px">
      <div class="bar"><strong>Copy your new token now</strong><button id="copy" type="button">Copy</button></div>
      <div id="new-token" class="token"></div>
      <div class="hint">It won't be shown again: only a hash is stored.</div>
      <pre id="example"></pre>
    </section>

    <h2>Your tokens</h2>
    <section class="card"><ul id="tokens" class="tokens"></ul><p id="tokens-error" class="error" hidden></p></section>
  </div>
</main>
<script nonce="${nonce}">
"use strict";
const KEY = "ntfy-account-auth";
const $ = (id) => document.getElementById(id);
const store = {
  get() { try { return sessionStorage.getItem(KEY); } catch { return null; } },
  set(v) { try { v ? sessionStorage.setItem(KEY, v) : sessionStorage.removeItem(KEY); } catch {} },
};
let auth = store.get();

function el(tag, props, ...children) {
  const n = document.createElement(tag);
  Object.assign(n, props || {});
  for (const c of children) if (c != null) n.append(c);
  return n;
}

async function api(method, path, body, extraHeaders) {
  const headers = { Authorization: auth, ...(extraHeaders || {}) };
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(res.status === 401 ? "Wrong username or password." : data.error || "Request failed (" + res.status + ")");
    err.status = res.status;
    throw err;
  }
  return data;
}

const date = (s) => new Date(s * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
const when = (s) => {
  const d = Math.round((Date.now() / 1000 - s) / 60);
  if (d < 2) return "just now";
  if (d < 60) return d + " min ago";
  if (d < 48 * 60) return Math.round(d / 60) + " h ago";
  return date(s);
};
const CAN = { "read-write": "publish and read", "write-only": "publish only", "read-only": "read only" };

function describe(t) {
  if (t.provisioned) return "From NTFY_AUTH_TOKENS · change it with wrangler secret put";
  const scope = (t.topics ? t.topics.join(", ") : "All topics") + " · " + CAN[t.permission || "read-write"];
  const parts = [scope];
  if (t.created) parts.push("created " + date(t.created));
  if (t.last_access) parts.push("used " + when(t.last_access));
  if (t.expires) parts.push((t.expires * 1000 < Date.now() ? "expired " : "expires ") + date(t.expires));
  return parts.join(" · ");
}

function render(account) {
  $("who").textContent = account.username + (account.role === "admin" ? " (admin)" : "");
  const list = $("tokens");
  list.replaceChildren();
  if (!account.tokens || account.tokens.length === 0) {
    list.append(el("li", { className: "empty", textContent: "No tokens yet." }));
    return;
  }
  for (const t of account.tokens) {
    const info = el("div", {},
      el("div", { className: "name", textContent: t.label || (t.provisioned ? "Configured token" : "Untitled token") }),
      el("div", { className: "meta" }, el("code", { textContent: t.token }), " ", describe(t)));
    const row = el("li", {}, info);
    if (!t.provisioned && t.id) {
      const edit = el("button", { type: "button", textContent: "Edit" });
      edit.addEventListener("click", () => row.replaceChildren(editForm(t)));
      const btn = el("button", { type: "button", className: "danger", textContent: "Revoke" });
      btn.addEventListener("click", async () => {
        if (!confirm("Revoke \\"" + (t.label || t.token) + "\\"? Clients using it stop working.")) return;
        btn.disabled = true;
        try { await api("DELETE", "/v1/account/token?id=" + encodeURIComponent(t.id)); await refresh(); }
        catch (e) { btn.disabled = false; alert(e.message); }
      });
      row.append(el("div", { className: "row-actions" }, edit, btn));
    }
    list.append(row);
  }
}

function option(value, text, selected) {
  return el("option", { value, textContent: text, selected: value === selected });
}

// Changes take effect within a minute; the token itself stays the same.
function editForm(t) {
  const id = (name) => "edit-" + name + "-" + t.id;
  const field = (name, label, input, wide) => {
    input.id = id(name);
    return el("div", wide ? { className: "wide" } : {}, el("label", { htmlFor: input.id, textContent: label }), input);
  };
  const label = el("input", { value: t.label || "", maxLength: 200 });
  const topics = el("input", { value: (t.topics || []).join(", "), placeholder: "All topics", autocapitalize: "off",
                               autocomplete: "off", spellcheck: false });
  const perm = el("select", {}, option("read-write", "Publish and read", t.permission || "read-write"),
    option("write-only", "Publish only", t.permission), option("read-only", "Read only", t.permission));
  const expires = el("select", {}, option("keep", t.expires ? "Keep (" + date(t.expires) + ")" : "Keep (never)", "keep"),
    option("0", "Never"), option("7", "In 7 days"), option("30", "In 30 days"), option("365", "In a year"));
  const error = el("span", { className: "error" });
  const save = el("button", { type: "submit", className: "primary", textContent: "Save" });
  const cancel = el("button", { type: "button", textContent: "Cancel" });
  cancel.addEventListener("click", () => refresh());
  const form = el("form", { className: "grid" },
    field("label", "Name", label, true),
    field("topics", "Topics", topics, true),
    field("permission", "Can", perm),
    field("expires", "Expires", expires),
    el("div", { className: "wide actions" }, save, cancel, error));
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const body = {
      id: t.id,
      label: label.value.trim(),
      topics: topics.value.split(",").map((s) => s.trim()).filter(Boolean),
      permission: perm.value,
    };
    if (expires.value !== "keep") {
      const days = Number(expires.value);
      body.expires = days ? Math.floor(Date.now() / 1000) + days * 86400 : 0;
    }
    save.disabled = true;
    error.textContent = "";
    try { await api("PATCH", "/v1/account/token", body); await refresh(); }
    catch (e) {
      if (e.status === 401) return signOut(e.message);
      save.disabled = false;
      error.textContent = e.message;
    }
  });
  setTimeout(() => label.focus());
  return form;
}

async function refresh() {
  try {
    const account = await api("GET", "/v1/account");
    if (account.username === "*") throw Object.assign(new Error("Sign in first."), { status: 401 });
    $("login").hidden = true;
    $("app").hidden = false;
    render(account);
  } catch (e) {
    if (e.status === 401) return signOut(e.message);
    $("tokens-error").hidden = false;
    $("tokens-error").textContent = e.message;
  }
}

function signOut(message) {
  auth = null;
  store.set(null);
  $("app").hidden = true;
  $("reveal").hidden = true;
  $("login").hidden = false;
  $("login-error").textContent = message || "";
  $("u").focus();
}

$("login-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const bytes = new TextEncoder().encode($("u").value + ":" + $("p").value);
  auth = "Basic " + btoa(String.fromCharCode(...bytes));
  store.set(auth);
  $("p").value = "";
  $("login-error").textContent = "";
  await refresh();
});

$("logout").addEventListener("click", () => signOut());

$("create-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const button = ev.submitter || ev.target.querySelector("button");
  const topics = $("topics").value.split(",").map((s) => s.trim()).filter(Boolean);
  const days = Number($("expires").value);
  const body = { label: $("label").value.trim() || undefined, permission: $("permission").value };
  if (topics.length) body.topics = topics;
  if (days) body.expires = Math.floor(Date.now() / 1000) + days * 86400;
  button.disabled = true;
  $("create-error").textContent = "";
  try {
    const t = await api("POST", "/v1/account/token", body);
    $("new-token").textContent = t.token;
    const topic = (topics.find((x) => !x.includes("*")) || "mytopic");
    $("example").textContent = (body.permission === "read-only")
      ? 'curl -H "Authorization: Bearer ' + t.token + '" ' + location.origin + "/" + topic + "/json"
      : 'curl -H "Authorization: Bearer ' + t.token + '" -d "Hello" ' + location.origin + "/" + topic;
    $("reveal").hidden = false;
    $("copy").textContent = "Copy";
    $("create-form").reset();
    await refresh();
    $("reveal").scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (e) {
    if (e.status === 401) return signOut(e.message);
    $("create-error").textContent = e.message;
  } finally {
    button.disabled = false;
  }
});

$("copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("new-token").textContent); $("copy").textContent = "Copied"; }
  catch { getSelection().selectAllChildren($("new-token")); $("copy").textContent = "Selected, press Ctrl+C"; }
});

if (auth) refresh(); else signOut();
</script>
</body>
</html>`;
