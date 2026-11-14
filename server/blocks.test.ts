import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BlockError, BlockSchema, langOf, measure, resolveBlocks, type Block, type BlockInput } from "./blocks.js";
import { parseDiff } from "./git.js";

const files = parseDiff([
  "diff --git a/old.ts b/new.ts", "rename from old.ts", "rename to new.ts", "--- a/old.ts", "+++ b/new.ts",
  "@@ -10,4 +20,5 @@", " same", "-before", "+after", "+inserted", "-removed", " tail", "+last", "",
].join("\n"));
const ctx = { files, repoRoot: process.cwd() };
function code(input: Omit<Extract<BlockInput, { type: "code" }>, "type" | "hunk_id"> = {}) {
  const [block] = resolveBlocks([{ type: "code", hunk_id: "F1H1", ...input }], ctx);
  assert.ok(block.type === "code");
  return block;
}

test("code resolution defaults to diff for rewrites and preserves paths, notes, and highlights", () => {
  const block = code({ notes: [{ line: 21, text: "reason" }], highlight: [21], caption: "caption" });
  assert.equal(block.view, "diff");
  assert.equal(block.file, "old.ts → new.ts");
  assert.equal(block.filePath, "new.ts");
  assert.equal(block.lang, "typescript");
  assert.deepEqual(block.highlight, [21]);
  assert.deepEqual(block.notes, [{ line: 21, text: "reason" }]);
  assert.equal(block.caption, "caption");
  assert.equal(block.fileId, undefined);
});

for (const view of ["new", "old", "diff", "split"] as const) {
  test(`${view} view selects the corresponding side and line numbers`, () => {
    const block = code({ view });
    const expected = view === "new" ? ["same", "after", "inserted", "tail", "last"]
      : view === "old" ? ["same", "before", "removed", "tail"]
      : ["same", "before", "after", "inserted", "removed", "tail", "last"];
    assert.deepEqual(block.rows.map((r) => r.text), expected);
    if (view === "new") assert.deepEqual(block.rows.map((r) => r.newN), [20, 21, 22, 23, 24]);
    if (view === "old") assert.deepEqual(block.rows.map((r) => r.oldN), [10, 11, 12, 13]);
  });
}

test("ranges are inclusive, attribute deletions to the next new line, and accept one-sided bounds", () => {
  assert.deepEqual(code({ start: 21, end: 21 }).rows.map((r) => r.text), ["before", "after"]);
  assert.deepEqual(code({ start: 23, end: 23 }).rows.map((r) => r.text), ["removed", "tail"]);
  assert.deepEqual(code({ view: "old", start: 11, end: 12 }).rows.map((r) => r.text), ["before", "removed"]);
  assert.deepEqual(code({ start: 24 }).rows.map((r) => r.text), ["last"]);
  assert.deepEqual(code({ end: 20 }).rows.map((r) => r.text), ["same"]);
  assert.throws(() => code({ start: 999 }), BlockError);
  assert.throws(() => code({ start: 23, end: 20 }), /selects no lines/);
  assert.throws(() => resolveBlocks([{ type: "code", hunk_id: "missing" }], ctx), /Unknown hunk_id/);
});

test("additions default to new and pure deletions always use old-file coordinates", () => {
  const files = parseDiff([
    "diff --git a/new.py b/new.py", "new file mode 100644", "--- /dev/null", "+++ b/new.py", "@@ -0,0 +1 @@", "+new",
    "diff --git a/gone.py b/gone.py", "deleted file mode 100644", "--- a/gone.py", "+++ /dev/null", "@@ -8,2 +0,0 @@", "-one", "-two", "",
  ].join("\n"));
  const blocks = resolveBlocks([
    { type: "code", hunk_id: "F1H1" }, { type: "code", hunk_id: "F2H1", view: "new", start: 9, end: 9 },
  ], { ...ctx, files });
  assert.ok(blocks[0].type === "code" && blocks[1].type === "code");
  assert.equal(blocks[0].view, "new");
  assert.equal(blocks[1].view, "old");
  assert.equal(blocks[1].filePath, "gone.py");
  assert.deepEqual(blocks[1].rows, [{ kind: "del", oldN: 9, text: "two" }]);
});

test("context ranges clamp to actual lines and reject missing files and paths outside the repo", async (t) => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "xpl-block-test-"));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  await writeFile(path.join(repoRoot, "caller.ts"), "first\nsecond\n");
  const context = { files: [], repoRoot };
  const [block] = resolveBlocks([{ type: "context", file: "./caller.ts", start: 0, end: 99 }], context);
  assert.ok(block.type === "code");
  assert.equal(block.view, "context");
  assert.equal(block.filePath, "caller.ts");
  assert.deepEqual(block.rows.map((r) => r.text), ["first", "second"]);
  for (const file of ["../outside.ts", `${repoRoot}-sibling/file.ts`, repoRoot]) {
    assert.throws(() => resolveBlocks([{ type: "context", file, start: 1, end: 2 }], context), /outside repo/);
  }
  assert.throws(() => resolveBlocks([{ type: "context", file: "missing", start: 1, end: 2 }], context), /Cannot read/);
  assert.throws(() => resolveBlocks([{ type: "context", file: "caller.ts", start: 3, end: 4 }], context), /Bad range/);
});

test("visual and prose blocks pass through, while budget measurement counts visible split height and annotations", () => {
  const content: BlockInput[] = [
    { type: "text", markdown: "abcd" }, { type: "callout", tone: "tip", markdown: "ef" },
    { type: "mermaid", code: "x".repeat(1000) }, { type: "html", code: "y".repeat(1000) },
  ];
  assert.deepEqual(resolveBlocks(content, ctx), content);
  const blocks: Block[] = [...resolveBlocks(content, ctx), code({ view: "split", notes: [{ line: 21, text: "12345" }], caption: "abc" })];
  assert.deepEqual(measure(blocks), { codeLines: 5, prose: 12 });
  assert.deepEqual(measure([code()]), { codeLines: 7, prose: 0 });
});

test("block schemas reject unsupported types, invalid views, tones, and fractional line numbers", () => {
  for (const input of [
    { type: "unknown" }, { type: "code", hunk_id: "F1H1", view: "both" },
    { type: "code", hunk_id: "F1H1", start: 1.5 }, { type: "callout", tone: "danger", markdown: "x" },
    { type: "context", file: "a.ts", start: 1 }, { type: "text", markdown: 42 },
    { type: "code", hunk_id: "F1H1", notes: [{ line: 1.5, text: "x" }] },
  ]) assert.equal(BlockSchema.safeParse(input).success, false, JSON.stringify(input));
  assert.equal(langOf("component.TSX"), "typescript");
  assert.equal(langOf("README"), "plaintext");
});
