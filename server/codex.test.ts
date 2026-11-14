import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { mkdtemp, copyFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { tool } from "./tools.js";
import { CodexAgent } from "./codex.js";
import { Session, resolveModel, type SessionEvent } from "./session.js";

let temporary: string;
const previous = { ...process.env };
const scopedEnv = ["XPL_CODEX_MODEL", "XPL_TEST_MODE"];
before(async () => {
  temporary = await mkdtemp(path.join(tmpdir(), "xpl-codex-test-"));
  const executable = path.join(temporary, "codex");
  await copyFile(fileURLToPath(new URL("./fixtures/codex.mjs", import.meta.url)), executable);
  await chmod(executable, 0o755);
  process.env.XPL_CODEX_PATH = executable;
  process.env.OPENAI_API_KEY = "must-not-reach-cli";
  process.env.CODEX_API_KEY = "must-not-reach-cli";
  delete process.env.XPL_USE_API_KEY;
});
afterEach(() => {
  for (const key of scopedEnv) {
    if (previous[key] == null) delete process.env[key];
    else process.env[key] = previous[key];
  }
});
after(async () => {
  for (const key of ["XPL_CODEX_PATH", "OPENAI_API_KEY", "CODEX_API_KEY", "XPL_USE_API_KEY"]) {
    if (previous[key] == null) delete process.env[key];
    else process.env[key] = previous[key];
  }
  await rm(temporary, { recursive: true, force: true });
});

function makeAgent(onActivity = (_text: string) => {}) {
  const seen: string[] = [];
  const errors: Error[] = [];
  const agent = new CodexAgent({
    cwd: process.cwd(),
    instructions: "Read only.",
    onActivity,
    onError: (error) => errors.push(error),
    tools: [
      tool("record", "Record text", { value: z.string() }, async ({ value }) => {
        seen.push(value);
        return { content: [{ type: "text", text: "saved" }] };
      }),
    ],
  });
  return { agent, seen, errors };
}

test("Codex validates tool inputs, returns errors to the model, and continues the same thread", async () => {
  const activities: string[] = [];
  const { agent, seen, errors } = makeAgent((text) => activities.push(text));
  try {
    await agent.start();
    await agent.run("validate-tools");
    await agent.run("validate-tools");
    assert.deepEqual(seen, ["ok", "ok"]);
    assert.deepEqual(activities, ["rg example", "rg example"]);
    assert.deepEqual(errors, []);
  } finally {
    agent.close();
  }
});

for (const [prompt, message] of [
  ["fail", /model failed/],
  ["rpc-error", /start failed/],
  ["exit", /Codex が終了/],
  ["invalid-json", /不正な JSON/],
  ["error-and-exit", /specific startup failure/],
] as const) {
  test(`Codex rejects a turn on ${prompt}`, async () => {
    const { agent } = makeAgent();
    try {
      await agent.start();
      await assert.rejects(agent.run(prompt), message);
    } finally {
      agent.close();
    }
  });
}

test("Codex refuses unsupported approval requests without hanging the turn", async () => {
  const { agent } = makeAgent();
  try {
    await agent.start();
    await agent.run("unknown-request");
  } finally {
    agent.close();
  }
});

test("an unsuccessful turn keeps the Codex connection usable and blank lines are ignored", async () => {
  const { agent, seen } = makeAgent();
  try {
    await agent.start();
    await assert.rejects(agent.run("fail"), /model failed/);
    await agent.run("blank-lines");
    await agent.run("validate-tools");
    assert.deepEqual(seen, ["ok"]);
  } finally {
    agent.close();
  }
});

test("closing Codex rejects an active turn and prevents further requests", async () => {
  const { agent } = makeAgent();
  await agent.start();
  const rejection = assert.rejects(agent.run("hang"), /終了/);
  agent.close();
  await rejection;
  await assert.rejects(agent.run("again"), /終了/);
  agent.close();
});

test("missing Codex executable reports installation guidance", async () => {
  const executable = process.env.XPL_CODEX_PATH;
  process.env.XPL_CODEX_PATH = path.join(temporary, "missing-codex");
  const { agent } = makeAgent();
  try {
    await assert.rejects(agent.start(), /codex login/);
  } finally {
    agent.close();
    process.env.XPL_CODEX_PATH = executable;
  }
});

test("model selection uses an explicit model, then XPL_CODEX_MODEL, then the Codex default", () => {
  delete process.env.XPL_CODEX_MODEL;
  assert.equal(resolveModel(), undefined);
  assert.equal(resolveModel(""), undefined);
  process.env.XPL_CODEX_MODEL = "codex-model";
  assert.equal(resolveModel(), "codex-model");
  assert.equal(resolveModel("  "), "codex-model");
  assert.equal(resolveModel(" explicit "), "explicit");
});

function waitFor(session: Session, predicate: (event: SessionEvent) => boolean) {
  if (session.events.some(predicate)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      session.off("event", listener);
      reject(new Error("Session event timed out"));
    }, 5000);
    const listener = (event: SessionEvent) => {
      if ((event.type === "phase" && event.phase === "failed") || predicate(event)) {
        clearTimeout(timer);
        session.off("event", listener);
        if (event.type === "phase" && event.phase === "failed") reject(new Error("Session failed"));
        else resolve();
      }
    };
    session.on("event", listener);
  });
}

function makeSession() {
  return new Session({
    repoRoot: process.cwd(),
    language: "日本語",
    diff: {
      title: "Example",
      raw: "",
      files: [
        {
          id: "F1",
          oldPath: "example.ts",
          newPath: "example.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          hunks: [
            {
              id: "F1H1",
              header: "@@ -1 +1 @@",
              oldStart: 1,
              newStart: 1,
              lines: ["-const a = 1;", "+const a = 2;"],
            },
          ],
        },
      ],
    },
  });
}

test("Codex session plans, prepares steps, answers immediate and deferred questions, and finishes", async () => {
  const session = makeSession();
  try {
    await session.start();
    await waitFor(session, (e) => e.type === "step" && e.index === 0);
    session.ask("なぜ変更しましたか？", "now");
    await waitFor(session, (e) => e.type === "answer" && e.questionId === "Q1");
    session.ask("影響範囲は？", "later");
    session.next();
    await waitFor(session, (e) => e.type === "step" && e.index === 1);
    session.next();
    await waitFor(session, (e) => e.type === "phase" && e.phase === "finished");
    assert.equal(session.plan.length, 2);
    assert.ok(session.questions.every((question) => question.answered));
    assert.equal(session.events.filter((e) => e.type === "answer").length, 2);
    assert.equal(
      session.events.some((e) => e.type === "error"),
      false,
    );
  } finally {
    session.close();
  }
});

for (const mode of ["fail-plan-once", "fail-prepare-once", "fail-question-once"]) {
  test(`the session recovers from ${mode} without closing`, async () => {
    process.env.XPL_TEST_MODE = mode;
    const session = makeSession();
    try {
      await session.start();
      await waitFor(session, (e) => e.type === "step" && e.index === 0);
      session.ask("質問", "now");
      await waitFor(session, (e) => e.type === "answer");
      session.next();
      await waitFor(session, (e) => e.type === "step" && e.index === 1);
      assert.equal(session.isClosed, false);
      assert.equal(session.phase, "stepping");
      assert.ok(
        session.events.some((e) => e.type === "error" && e.message.includes("model failed")),
      );
    } finally {
      session.close();
    }
  });
}

// Expected errors are part of these cases, so wait for the terminal phase directly.
function waitForFailure(session: Session) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      session.off("event", listener);
      reject(new Error("Failure phase timed out"));
    }, 5000);
    const listener = (event: SessionEvent) => {
      if (event.type === "phase" && event.phase === "failed") {
        clearTimeout(timer);
        session.off("event", listener);
        resolve();
      }
    };
    session.on("event", listener);
  });
}

for (const mode of ["empty-plan", "fatal", "empty-answer"]) {
  test(`${mode} stops with a failure, and later questions cannot become stuck waiting`, async () => {
    process.env.XPL_TEST_MODE = mode;
    const session = makeSession();
    const failure = waitForFailure(session);
    try {
      await session.start();
      if (mode === "empty-answer") {
        await waitFor(session, (e) => e.type === "step" && e.index === 0);
        session.ask("質問", "now");
      }
      await failure;
      assert.equal(session.isClosed, true);
      assert.equal(session.phase, "failed");
      const count = session.events.length;
      assert.equal(session.ask("もう一度", "now"), false);
      session.next();
      assert.equal(session.events.length, count);
      assert.equal(
        session.events.some((e) => e.type === "phase" && e.phase === "finished"),
        false,
      );
      const status = session.events.filter((e) => e.type === "status").at(-1);
      assert.ok(status?.type === "status" && !status.waiting && !status.aiWorking);
    } finally {
      session.close();
    }
  });
}
