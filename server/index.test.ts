import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));

test("a session uses Codex by default, streams failure, rejects later actions with 410, and can be deleted", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "xpl-api-test-"));
  const repo = path.join(temporary, "repo");
  await promisify(execFile)("git", ["init", repo]);
  await writeFile(path.join(repo, "example.ts"), "export const value = 1;\n");
  const executable = path.join(temporary, "codex");
  await copyFile(fileURLToPath(new URL("./fixtures/codex.mjs", import.meta.url)), executable);
  await chmod(executable, 0o755);
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: root,
    env: { ...process.env, PORT: "0", XPL_REPO: repo, XPL_CODEX_PATH: executable, XPL_USE_API_KEY: "", XPL_TEST_MODE: "fatal" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  const closed = once(child, "close");
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${stderr}`)), 5000);
      let output = "";
      child.stdout.on("data", (data) => {
        output += data;
        const match = output.match(/http:\/\/localhost:(\d+)/);
        if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
      });
      child.on("exit", () => { clearTimeout(timer); reject(new Error(`Server exited: ${stderr}`)); });
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
    });
    const request = (endpoint: string, body?: unknown) => fetch(url + endpoint, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    assert.deepEqual(await (await fetch(url + "/api/config")).json(), { defaultRepo: repo });
    const created = await request("/api/sessions", { repoPath: repo, source: { kind: "working" } });
    assert.equal(created.status, 200);
    const { id, files } = await created.json();
    assert.equal(files, 1);
    const events = await fetch(`${url}/api/sessions/${id}/events`, { signal: AbortSignal.timeout(5000) });
    assert.equal(events.status, 200);
    const reader = events.body!.getReader();
    const decoder = new TextDecoder();
    let output = "";
    while (!output.includes('"phase":"failed"')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      output += decoder.decode(chunk.value, { stream: true });
    }
    await reader.cancel();
    assert.doesNotMatch(output, /"phase":"finished"/);
    const question = await request(`/api/sessions/${id}/questions`, { text: "質問", mode: "now" });
    assert.equal(question.status, 410);
    assert.match((await question.json()).error, /中断/);
    assert.equal((await request(`/api/sessions/${id}/next`)).status, 410);
    assert.equal((await fetch(`${url}/api/sessions/${id}`, { method: "DELETE" })).status, 200);
    assert.equal((await fetch(`${url}/api/sessions/${id}/events`)).status, 404);
  } finally {
    child.kill("SIGTERM");
    await closed;
    await rm(temporary, { recursive: true, force: true });
  }
});
