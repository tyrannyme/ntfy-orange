const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * There is no web app (see README). Browsers opening the server or a topic URL get a
 * short page explaining how to connect instead. It reveals nothing about configuration.
 */
export function landingPage(baseUrl: string, topic?: string): string {
  const url = escape(baseUrl);
  const host = escape(new URL(baseUrl).host);
  const t = topic ? escape(topic) : "mytopic";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${topic ? `${t} · ` : ""}ntfy on Cloudflare</title>
<style>
  :root { --bg: #fbfaf8; --fg: #1d1b18; --muted: #6b665e; --line: #e6e1d8; --code: #f1ede6; --accent: #e8590c; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #161513; --fg: #ece8e1; --muted: #a39d93; --line: #2d2a26; --code: #22201d; --accent: #ff8a3d; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 640px; margin: 0 auto; padding: 56px 16px 64px; }
  h1 { font-size: 28px; line-height: 1.2; margin: 0 0 8px; letter-spacing: -0.01em; }
  h1 span { color: var(--accent); }
  h2 { font-size: 15px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 40px 0 8px; }
  p { margin: 0 0 12px; }
  .lede { color: var(--muted); }
  code, pre { font: 13.5px/1.5 ui-monospace, "SF Mono", Menlo, Consolas, monospace; background: var(--code); border-radius: 6px; }
  code { padding: 2px 6px; }
  pre { padding: 12px 14px; overflow-x: auto; border: 1px solid var(--line); margin: 0 0 12px; }
  ol { padding-left: 20px; margin: 0 0 12px; }
  li { margin-bottom: 6px; }
  a { color: var(--accent); }
  footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--line); color: var(--muted); font-size: 14px; }
</style>
</head>
<body>
<main>
  <h1>ntfy<span>.</span> on Cloudflare</h1>
  <p class="lede">${topic ? `This is the topic <code>${t}</code> on <code>${host}</code>.` : `This is an ntfy-compatible notification server.`} There is no web app here: use the ntfy apps, the CLI or plain HTTP.</p>

  <h2>Subscribe on Android</h2>
  <ol>
    <li>In the ntfy app, open <em>Settings → Manage users</em> and add a user for <code>${url}</code>.</li>
    <li>Tap <em>+</em>, enter the topic (<code>${t}</code>), check <em>Use another server</em> and enter <code>${url}</code>.</li>
  </ol>

  <h2>Publish</h2>
<pre>curl -u USER:PASS -d "Backup finished" ${url}/${t}
curl -H "Authorization: Bearer tk_..." -H "Priority: high" -d "Disk full" ${url}/${t}</pre>

  <p>Create and revoke access tokens at <a href="/account">/account</a>.</p>

  <h2>Subscribe from a script</h2>
<pre>curl -s -u USER:PASS ${url}/${t}/json</pre>

  <footer>ntfy-compatible server running on Cloudflare Workers. Not affiliated with ntfy.sh.</footer>
</main>
</body>
</html>`;
}
