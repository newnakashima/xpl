import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { SessionEvent } from "./session.js";

const root = fileURLToPath(new URL("../", import.meta.url));

async function withServer(mode: string, run: (url: string, repo: string) => Promise<void>) {
  const temporary = await mkdtemp(path.join(tmpdir(), "xpl-api-test-"));
  const repo = path.join(temporary, "repo");
  await promisify(execFile)("git", ["init", repo]);
  await writeFile(path.join(repo, "example.ts"), "export const value = 1;\n");
  const executable = path.join(temporary, "codex");
  await copyFile(fileURLToPath(new URL("./fixtures/codex.mjs", import.meta.url)), executable);
  await chmod(executable, 0o755);
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: root,
    env: { ...process.env, PORT: "0", XPL_REPO: repo, XPL_CODEX_PATH: executable, XPL_USE_API_KEY: "", XPL_TEST_MODE: mode },
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
    await run(url, repo);
  } finally {
    child.kill("SIGTERM");
    await closed;
    await rm(temporary, { recursive: true, force: true });
  }
}

test("a session uses Codex by default, streams failure, rejects later actions with 410, and can be deleted", async () => {
  await withServer("fatal", async (url, repo) => {
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
  });
});

test("questions use the viewed step for events and AI context without changing session progress", async () => {
  await withServer("question-context", async (url, repo) => {
    const request = (endpoint: string, body?: unknown) => fetch(url + endpoint, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    const created = await request("/api/sessions", { repoPath: repo, source: { kind: "working" } });
    assert.equal(created.status, 200);
    const { id } = await created.json();
    const endpoint = `/api/sessions/${id}`;
    const response = await fetch(url + endpoint + "/events", { signal: AbortSignal.timeout(10000) });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let output = "";
    const until = async (predicate: (event: SessionEvent) => boolean) => {
      while (true) {
        const events: SessionEvent[] = output.split("\n\n").slice(0, -1).filter((part) => part.startsWith("data: ")).map((part) => JSON.parse(part.slice(6)));
        const event = events.find(predicate);
        if (event) return event;
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        output += decoder.decode(chunk.value, { stream: true });
      }
    };
    try {
      await until((e) => e.type === "step" && e.index === 0);
      // Step 2 may already be prepared, but has not been revealed yet.
      assert.equal((await request(endpoint + "/questions", { text: "質問", mode: "now", afterStep: 1 })).status, 400);
      await request(endpoint + "/next");
      await until((e) => e.type === "step" && e.index === 1);

      for (const afterStep of [-1, 0.5, 2, "0", null]) {
        assert.equal((await request(endpoint + "/questions", { text: "質問", mode: "now", afterStep })).status, 400);
      }
      assert.equal((await request(endpoint + "/questions", { text: "前のステップについて", mode: "now", afterStep: 0 })).status, 200);
      const question = await until((e) => e.type === "question" && e.question.id === "Q1");
      assert.ok(question.type === "question");
      assert.equal(question.question.afterStep, 0);
      const answer = await until((e) => e.type === "answer" && e.questionId === "Q1");
      assert.ok(answer.type === "answer" && answer.blocks[0].type === "text");
      assert.match(answer.blocks[0].markdown, /while reading step 1 "全体像"/);

      // Clients that omit the viewed step retain the latest-step default.
      assert.equal((await request(endpoint + "/questions", { text: "最新のステップについて", mode: "now" })).status, 200);
      const latest = await until((e) => e.type === "question" && e.question.id === "Q2");
      assert.ok(latest.type === "question");
      assert.equal(latest.question.afterStep, 1);
      await until((e) => e.type === "answer" && e.questionId === "Q2");

      assert.equal((await request(endpoint + "/questions", { text: "あとで前のステップを確認", mode: "later", afterStep: 0 })).status, 200);
      const deferred = await until((e) => e.type === "question" && e.question.id === "Q3");
      assert.ok(deferred.type === "question");
      assert.equal(deferred.question.afterStep, 0);
      await request(endpoint + "/next");
      const final = await until((e) => e.type === "answer" && e.questionId === "Q3");
      assert.ok(final.type === "answer" && final.blocks[0].type === "text");
      assert.match(final.blocks[0].markdown, /\[Q3\] \(asked at step 1\)/);
      await until((e) => e.type === "phase" && e.phase === "finished");
    } finally {
      await reader.cancel();
    }
  });
});

test("full-file API serves only registered files, including after the agent stops", async () => {
  await withServer("fatal", async (url, repo) => {
    const created = await fetch(url + "/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoPath: repo, source: { kind: "working" } }),
    });
    assert.equal(created.status, 200);
    const { id } = await created.json();
    const endpoint = `${url}/api/sessions/${id}/files/`;
    const response = await fetch(endpoint + "F1");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { rows: [{ kind: "add", newN: 1, text: "export const value = 1;" }] });
    assert.equal((await fetch(endpoint + "missing")).status, 404);
    assert.equal((await fetch(endpoint + encodeURIComponent("../example.ts"))).status, 404);
    assert.equal((await fetch(`${url}/api/sessions/missing/files/F1`)).status, 404);
    await fetch(`${url}/api/sessions/${id}`, { method: "DELETE" });
    assert.equal((await fetch(endpoint + "F1")).status, 404);
  });
});
