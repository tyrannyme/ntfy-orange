import { beforeAll, describe, expect, test } from "bun:test";
import { TOKEN, USERS, baseUrl, poll, uniqueTopic } from "./server";

/**
 * Drives the official ntfy CLI (a real ntfy client) against this server.
 * Set NTFY_BIN to the path of an `ntfy` binary to enable; skipped otherwise.
 */
const bin = process.env.NTFY_BIN;
const run = (args: string[], timeoutMs = 10_000) => {
  const p = Bun.spawnSync([bin!, ...args], { timeout: timeoutMs, env: { ...process.env, NTFY_TOPIC: "" } });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};

let url: string;
beforeAll(async () => {
  if (bin) url = await baseUrl();
}, 70_000);

describe.skipIf(!bin)("official ntfy CLI", () => {
  const auth = ["-u", `${USERS.admin[0]}:${USERS.admin[1]}`];

  test("publish with options, token auth, file upload", async () => {
    const topic = uniqueTopic();
    const out = run([
      "publish",
      ...auth,
      "--title",
      "CLI",
      "--priority",
      "5",
      "--tags",
      "rocket",
      "--click",
      "https://example.com",
      `${url}/${topic}`,
      "hello from the CLI",
    ]);
    expect(out.code).toBe(0);
    expect(JSON.parse(out.out)).toMatchObject({
      title: "CLI",
      priority: 5,
      tags: ["rocket"],
      message: "hello from the CLI",
    });
    expect(run(["publish", "--token", TOKEN, `${url}/${topic}`, "via token"]).code).toBe(0);
    const file = run(["publish", ...auth, "--file", import.meta.path, `${url}/${topic}`]);
    expect(JSON.parse(file.out).attachment.name).toBe("cli.test.ts");
    expect((await poll(topic)).length).toBe(3);
  });

  test("subscribe --poll and wrong credentials", () => {
    const topic = uniqueTopic();
    run(["publish", ...auth, `${url}/${topic}`, "one"]);
    run(["publish", ...auth, `${url}/${topic}`, "two"]);
    const sub = run(["subscribe", ...auth, "--poll", `${url}/${topic}`]);
    expect(
      sub.out
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l).message),
    ).toEqual(["one", "two"]);
    expect(run(["publish", "-u", "phil:wrong", `${url}/${topic}`, "x"]).code).not.toBe(0);
  });

  test("live subscribe runs a command per message", async () => {
    const topic = uniqueTopic();
    const proc = Bun.spawn([bin!, "subscribe", ...auth, `${url}/${topic}`, 'echo "got:$m:$t"'], { stdout: "pipe" });
    await Bun.sleep(1500);
    run(["publish", ...auth, "--title", "T", `${url}/${topic}`, "live"]);
    const reader = proc.stdout.getReader();
    let text = "";
    const deadline = Date.now() + 5000;
    while (!text.includes("got:live:T") && Date.now() < deadline) {
      const { value } = await Promise.race([reader.read(), Bun.sleep(500).then(() => ({ value: undefined }))]);
      if (value) text += new TextDecoder().decode(value);
    }
    proc.kill();
    expect(text).toContain("got:live:T");
  }, 10_000);
});
