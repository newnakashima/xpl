import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { CodexAgent, CodexTurnError } from "./codex.js";
import { Session } from "./session.js";
import type { ToolDefinition } from "./tools.js";
import type { FileDiff } from "./git.js";

function file(hunks = 1, lines = 1): FileDiff {
  return {
    id: "F1", oldPath: "example.ts", newPath: "example.ts", status: "modified", additions: hunks * lines, deletions: 0,
    hunks: Array.from({ length: hunks }, (_, i) => ({
      id: `F1H${i + 1}`, header: `@@ -${i + 1},0 +${i + 1},${lines} @@`, oldStart: i + 1, newStart: i + 1,
      lines: Array.from({ length: lines }, (_, j) => `+const value${j} = ${j};`),
    })),
  };
}

// Control the agent at its transport boundary; exercise Session through its public
// API and the same validated tool handlers that Codex receives in production.
async function harness(t: TestContext, files = [file()], language = "日本語") {
  let tools: ToolDefinition[] = [];
  let pending: { resolve: () => void; reject: (error: Error) => void } | undefined;
  const runs: string[] = [];
  t.mock.method(CodexAgent.prototype, "start", async function (this: CodexAgent) {
    tools = (Reflect.get(this, "options") as { tools: ToolDefinition[] }).tools;
  });
  t.mock.method(CodexAgent.prototype, "run", (text: string) => {
    assert.equal(pending, undefined, "Session must serialize AI turns");
    runs.push(text);
    return new Promise<void>((resolve, reject) => { pending = { resolve, reject }; });
  });
  const close = t.mock.method(CodexAgent.prototype, "close", () => {});
  const session = new Session({ repoRoot: process.cwd(), language, diff: { title: "Example", description: "Context", raw: "", files } });
  t.after(() => session.close());
  await session.start();
  const call = async (name: string, input: unknown) => {
    const definition = tools.find((tool) => tool.name === name);
    assert.ok(definition, `missing tool ${name}`);
    return definition.handler(input);
  };
  const finish = async (error?: Error) => {
    assert.ok(pending, "expected a running turn");
    const turn = pending;
    pending = undefined;
    if (error) turn.reject(error); else turn.resolve();
    await setImmediate();
  };
  const plan = async (count = 3) => call("submit_plan", {
    overview: "Overview", steps: Array.from({ length: count }, (_, i) => ({ section: "Section", title: `Step ${i}`, hunk_ids: ["F1H1"] })),
  });
  const present = (index: number, markdown = "Explanation") => call("present_step", { index, title: `Step ${index}`, blocks: [{ type: "text", markdown }] });
  const answer = (question_id: string, markdown = "Answer") => call("answer_question", { question_id, blocks: [{ type: "text", markdown }] });
  const shown = () => session.events.filter((e) => e.type === "step").map((e) => e.index);
  return { session, call, finish, plan, present, answer, shown, runs, close };
}

test("an empty diff finishes without starting Codex and emits its metadata", async (t) => {
  const h = await harness(t, []);
  assert.equal(h.runs.length, 0);
  assert.equal(h.session.phase, "finished");
  assert.deepEqual(h.session.events[0], { type: "meta", title: "Example", description: "Context", repo: process.cwd(), fileCount: 0, additions: 0, deletions: 0 });
  assert.ok(h.session.events.some((e) => e.type === "error" && e.message.includes("差分がありません")));
});

test("plans request missing coverage once, strip unknown references, and cannot be replaced after acceptance", async (t) => {
  const h = await harness(t, [file(5)]);
  assert.equal((await h.plan()).isError, true);
  assert.equal(h.session.phase, "planning");
  const accepted = await h.call("submit_plan", {
    overview: "partial", steps: [{ section: "s", title: "t", hunk_ids: ["F1H1", "unknown"], line_ranges: [
      { hunk_id: "F1H1", start: 1, end: 1 }, { hunk_id: "unknown", start: 1, end: 1 },
    ] }],
  });
  assert.ok(!accepted.isError);
  assert.deepEqual(h.session.plan[0], { section: "s", title: "t", hunk_ids: ["F1H1"], line_ranges: [{ hunk_id: "F1H1", start: 1, end: 1 }] });
  assert.equal((await h.plan()).isError, true);
  assert.equal(h.session.events.filter((e) => e.type === "plan").length, 1);
});

test("explicitly skipped hunks satisfy plan coverage", async (t) => {
  const h = await harness(t, [file(5)]);
  const result = await h.call("submit_plan", {
    overview: "small example", steps: [{ section: "s", title: "t", hunk_ids: ["F1H1"] }],
    skipped_hunks: ["F1H2", "F1H3", "F1H4", "F1H5"],
  });
  assert.ok(!result.isError);
  assert.equal(h.session.phase, "stepping");
});

test("prefetched steps stay hidden until next, and finish requires acknowledging the last step", async (t) => {
  const h = await harness(t);
  await h.plan(2);
  await h.present(0);
  assert.deepEqual(h.shown(), [0]);
  assert.equal((await h.present(1)).isError, true, "one step per turn");
  await h.finish();
  assert.match(h.runs.at(-1)!, /Prepare step 2/);
  assert.equal((await h.present(0)).isError, true, "cannot repeat previous index");
  await h.present(1);
  await h.finish();
  assert.deepEqual(h.shown(), [0]);
  assert.equal(h.session.phase, "stepping");
  h.session.next();
  assert.deepEqual(h.shown(), [0, 1]);
  h.session.next();
  assert.equal(h.session.phase, "finished");
});

test("repeated next while a step is being prepared does not skip it", async (t) => {
  const h = await harness(t);
  await h.plan();
  await h.present(0);
  await h.finish();
  h.session.next();
  h.session.next();
  assert.deepEqual(h.shown(), [0]);
  await h.present(1);
  assert.deepEqual(h.shown(), [0, 1]);
  assert.equal(h.session.phase, "stepping");
});

test("immediate questions run FIFO before further prefetch, while deferred questions wait", async (t) => {
  const h = await harness(t);
  await h.plan(4);
  await h.present(0);
  await h.finish(); // Prepare step 1 is already in flight.
  h.session.ask("first", "now", 0);
  h.session.ask("second", "now", 0);
  h.session.ask("deferred", "later", 0);
  await h.present(1);
  await h.finish();
  assert.match(h.runs.at(-1)!, /Question \[Q1\]/);
  assert.equal((await h.present(2)).isError, true, "question turns cannot present steps");
  await h.answer("Q1");
  await h.finish();
  assert.match(h.runs.at(-1)!, /Question \[Q2\]/);
  await h.answer("Q2");
  await h.finish();
  assert.match(h.runs.at(-1)!, /Prepare step 3/);
  assert.equal(h.session.questions[2].answered, false);
  assert.equal(h.runs.some((text) => text.includes("Question [Q3]")), false);
});

test("deferred questions are answered together and a finished session can accept a follow-up", async (t) => {
  const h = await harness(t);
  await h.plan(1);
  await h.present(0);
  await h.finish();
  h.session.ask("one", "later");
  h.session.ask("two", "later");
  h.session.next();
  assert.equal(h.session.phase, "final_qa");
  assert.match(h.runs.at(-1)!, /\[Q1\].*one/);
  assert.match(h.runs.at(-1)!, /\[Q2\].*two/);
  await h.answer("Q1");
  await h.answer("Q2");
  await h.finish();
  assert.equal(h.session.phase, "finished");
  assert.equal(h.session.ask("follow-up", "later"), true);
  assert.equal(h.session.phase, "final_qa");
  await h.answer("Q3");
  await h.finish();
  assert.equal(h.session.phase, "finished");
});

test("questions may only reference revealed integer step indices and unknown answers are rejected", async (t) => {
  const h = await harness(t);
  await h.plan(2);
  await h.present(0);
  for (const index of [-1, 0.5, 1, NaN, Infinity]) assert.throws(() => h.session.ask("q", "now", index), RangeError);
  assert.equal(h.session.questions.length, 0);
  assert.equal((await h.answer("missing")).isError, true);
  h.session.ask("valid", "later", 0);
  assert.equal(h.session.questions[0].afterStep, 0);
});

for (const language of ["日本語", "English"]) {
  test(`step prose budgets for ${language} reject oversize output twice, then permit progress`, async (t) => {
    const h = await harness(t, [file()], language);
    await h.plan(1);
    const text = "x".repeat(language === "日本語" ? 361 : 851);
    assert.equal((await h.present(0, text)).isError, true);
    assert.equal((await h.present(0, text)).isError, true);
    assert.deepEqual(h.shown(), []);
    assert.ok(!(await h.present(0, text)).isError);
    assert.deepEqual(h.shown(), [0]);
  });
}

test("code line budgets and unresolved block errors allow a corrected step", async (t) => {
  const h = await harness(t, [file(1, 29)]);
  await h.plan(1);
  const present = (hunk_id: string, end?: number) => h.call("present_step", { index: 0, title: "t", blocks: [{ type: "code", hunk_id, end }] });
  assert.equal((await present("missing")).isError, true);
  assert.equal((await present("F1H1")).isError, true);
  assert.ok(!(await present("F1H1", 28)).isError);
  assert.deepEqual(h.shown(), [0]);
});

test("oversized answers are rejected once, and invalid blocks do not mark a question answered", async (t) => {
  const h = await harness(t);
  await h.plan(1);
  await h.present(0);
  await h.finish();
  h.session.ask("question", "now");
  assert.equal((await h.call("answer_question", { question_id: "Q1", blocks: [{ type: "code", hunk_id: "missing" }] })).isError, true);
  assert.equal((await h.answer("Q1", "x".repeat(901))).isError, true);
  assert.equal(h.session.questions[0].answered, false);
  assert.ok(!(await h.answer("Q1", "x".repeat(901))).isError);
  assert.equal(h.session.questions[0].answered, true);
});

test("three missing plans stop the session and reject subsequent actions", async (t) => {
  const h = await harness(t);
  for (let i = 0; i < 3; i++) await h.finish();
  assert.equal(h.runs.length, 3);
  assert.equal(h.session.phase, "failed");
  assert.equal(h.session.isClosed, true);
  assert.equal(h.close.mock.callCount(), 1);
  const count = h.session.events.length;
  assert.equal(h.session.ask("later", "now"), false);
  h.session.next();
  assert.equal(h.session.events.length, count);
});

test("three missing prepared steps reveal a fallback and allow the next step to continue", async (t) => {
  const h = await harness(t);
  await h.plan(2);
  await h.finish(); // Plan accepted without presenting its first step.
  for (let i = 0; i < 3; i++) await h.finish();
  assert.deepEqual(h.shown(), [0]);
  const fallback = h.session.events.find((e) => e.type === "step");
  assert.ok(fallback?.type === "step" && fallback.blocks[0].type === "callout");
  assert.equal(h.session.phase, "stepping");
  await h.present(1);
  h.session.next();
  assert.deepEqual(h.shown(), [0, 1]);
});

test("recoverable turn failures retry, while transport failures close the session", async (t) => {
  const h = await harness(t);
  await h.finish(new CodexTurnError("temporary"));
  assert.equal(h.session.isClosed, false);
  assert.equal(h.runs.length, 2);
  await h.finish(new Error("connection lost"));
  assert.equal(h.session.isClosed, true);
  assert.equal(h.session.phase, "failed");
  assert.ok(h.session.events.some((e) => e.type === "error" && e.message === "connection lost"));
});

test("get_diff selects requested hunks and files, reports misses, and bounds oversized responses", async (t) => {
  const first = file(2);
  first.hunks[1].lines = ["+" + "x".repeat(100_001)];
  const h = await harness(t, [first]);
  assert.equal((await h.call("get_diff", {})).isError, true);
  const selected = await h.call("get_diff", { hunk_ids: ["F1H1"] });
  assert.match(selected.content[0].text, /\[F1H1\]/);
  assert.doesNotMatch(selected.content[0].text, /\[F1H2\]/);
  const full = await h.call("get_diff", { file_ids: ["F1"] });
  assert.match(full.content[0].text, /\[F1H2\]/);
  assert.match(full.content[0].text, /truncated; request fewer files/);
  assert.ok(full.content[0].text.length < 100_100);
});
