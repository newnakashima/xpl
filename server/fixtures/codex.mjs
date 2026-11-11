#!/usr/bin/env node
// Protocol fixture: no network, credentials, or model calls.
import assert from "node:assert/strict";
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const reply = (id, result) => send({ id, result });
const threadId = "test-thread";
let requestId = 100;
let tools = [];
const callbacks = new Map();
const call = (tool, args) => new Promise((resolve) => {
  const id = ++requestId;
  callbacks.set(id, resolve);
  send({ id, method: "item/tool/call", params: { threadId, turnId: "turn", tool, arguments: args } });
});
const blocks = [{ type: "text", markdown: "短い解説です。" }];
const attempts = new Map();
const mode = process.env.XPL_TEST_MODE;
const complete = (failed = false) => send({ method: "turn/completed", params: { threadId, turn: {
  id: "turn", status: failed ? "failed" : "completed", error: failed ? { message: "model failed" } : null,
} } });

createInterface({ input: process.stdin }).on("line", async (line) => {
  try {
    const msg = JSON.parse(line);
    if (!msg.method) {
      callbacks.get(msg.id)?.(msg);
      callbacks.delete(msg.id);
      return;
    }
    if (msg.method === "initialize") {
      assert.equal(msg.params.capabilities.experimentalApi, true);
      assert.equal(process.env.OPENAI_API_KEY, undefined);
      assert.equal(process.env.CODEX_API_KEY, undefined);
      reply(msg.id, {});
    } else if (msg.method === "config/read") {
      reply(msg.id, { config: { mcp_servers: { external: {} }, plugins: { external: {} } } });
    } else if (msg.method === "thread/start") {
      assert.equal(msg.params.sandbox, "read-only");
      assert.equal(msg.params.approvalPolicy, "never");
      assert.equal(msg.params.config["mcp_servers.external.enabled"], false);
      assert.equal(msg.params.config["plugins.external.enabled"], false);
      assert.equal(msg.params.config["features.apps"], false);
      tools = msg.params.dynamicTools;
      assert.ok(tools.every((t) => t.type === "function" && t.inputSchema.type === "object"));
      reply(msg.id, { thread: { id: threadId } });
    } else if (msg.method === "turn/start") {
      assert.equal(msg.params.threadId, threadId);
      assert.equal(msg.params.sandboxPolicy.type, "readOnly");
      const text = msg.params.input[0].text;
      if (text === "rpc-error") {
        send({ id: msg.id, error: { message: "start failed" } });
        return;
      }
      if (text === "error-and-exit") {
        process.stdout.write(JSON.stringify({ id: msg.id, error: { message: "specific startup failure" } }) + "\n", () => process.exit(1));
        return;
      }
      reply(msg.id, { turn: { id: "turn" } });
      if (text === "hang") return;
      if (text === "exit") process.exit(2);
      if (text === "invalid-json") { process.stdout.write("not json\n"); return; }
      if (text === "blank-lines") process.stdout.write("\n \n");
      if (mode === "fatal") process.exit(2);
      const kind = text.startsWith("# Diff") ? "plan" : text.startsWith("Prepare step") ? "prepare" : "question";
      const attempt = (attempts.get(kind) ?? 0) + 1;
      attempts.set(kind, attempt);
      if (mode === "empty-plan" && kind === "plan") { complete(); return; }
      if (mode === "empty-answer" && kind === "question") { complete(); return; }
      if ((mode === "fail-plan-once" && kind === "plan" || mode === "fail-prepare-once" && kind === "prepare" ||
           mode === "fail-question-once" && kind === "question") && attempt === 1) { complete(true); return; }
      send({ method: "item/started", params: { threadId, item: { type: "commandExecution", command: "rg example" } } });
      if (text === "unknown-request") {
        const id = ++requestId;
        const response = new Promise((resolve) => callbacks.set(id, resolve));
        send({ id, method: "item/commandExecution/requestApproval", params: {} });
        assert.equal((await response).error.code, -32601);
      } else if (text === "validate-tools") {
        assert.equal((await call("record", { value: 42 })).result.success, false);
        assert.equal((await call("missing", {})).result.success, false);
        assert.equal((await call("record", { value: "ok" })).result.success, true);
      } else if (tools.some((t) => t.name === "submit_plan")) {
        if (text.startsWith("# Diff")) {
          assert.equal((await call("get_diff", { hunk_ids: ["F1H1"] })).result.success, true);
          assert.equal((await call("submit_plan", {
            overview: "変更の概要", steps: [
              { section: "概要", title: "全体像", hunk_ids: [] },
              { section: "実装", title: "変更点", hunk_ids: ["F1H1"] },
            ],
          })).result.success, true);
          assert.equal((await call("present_step", { index: 0, title: "全体像", blocks })).result.success, true);
        } else if (text.startsWith("Prepare step")) {
          assert.equal((await call("present_step", { index: 1, title: "変更点", blocks })).result.success, true);
        } else {
          const ids = [...text.matchAll(/\[(Q\d+)\]/g)].map((match) => match[1]);
          const answerBlocks = mode === "question-context" ? [{ type: "text", markdown: text }] : blocks;
          for (const question_id of ids) assert.equal((await call("answer_question", { question_id, blocks: answerBlocks })).result.success, true);
        }
      }
      complete(text === "fail");
    }
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
});
