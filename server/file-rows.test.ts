import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getDiff, parseDiff, type FileDiff } from "./git.js";
import { fullFileRows, textRows, type Row } from "./file-rows.js";
import { resolveBlocks } from "./blocks.js";
import { Session } from "./session.js";

async function repository(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "xpl-file-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = async (...args: string[]) => (await promisify(execFile)("git", args, { cwd: root })).stdout.trim();
  await git("init", "-b", "main");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.com");
  const save = (file: string, text: string) => writeFile(path.join(root, file), text);
  const commit = async () => { await git("add", "."); return git("commit", "-m", "fixture"); };
  return { root, git, save, commit };
}

const original = Array.from({ length: 40 }, (_, i) => `const line${i + 1} = ${i + 1};`).join("\n") + "\n";
const changed = original.replace("const line8 = 8;", "const line8 = 80;\nconst extra = true;").replace("const line30 = 30;\n", "");

function assertVersions(rows: Row[], oldText: string, newText: string) {
  const before = rows.filter((r) => r.kind !== "add");
  const after = rows.filter((r) => r.kind !== "del");
  assert.deepEqual(before.map((r) => r.text), textRows(oldText).map((r) => r.text));
  assert.deepEqual(after.map((r) => r.text), textRows(newText).map((r) => r.text));
  assert.deepEqual(before.map((r) => r.oldN), before.map((_, i) => i + 1));
  assert.deepEqual(after.map((r) => r.newN), after.map((_, i) => i + 1));
}

test("full working files keep gaps, all hunks, line numbers, and the session-start snapshot", async (t) => {
  const repo = await repository(t);
  await repo.save("example.ts", original);
  await repo.commit();
  await repo.save("example.ts", changed);
  const diff = await getDiff(repo.root, { kind: "working" });
  assert.equal(diff.files[0].hunks.length, 2);
  await repo.save("example.ts", "later edits\n");
  const session = new Session({ repoRoot: repo.root, diff, language: "日本語" });
  const rows = await session.getFileRows("F1");
  assert.ok(rows);
  assertVersions(rows, original, changed);
  assert.equal(session.getFileRows("F1"), session.getFileRows("F1"));
  assert.equal(session.getFileRows("../../etc/passwd"), undefined);
  const blocks = resolveBlocks([{ type: "code", hunk_id: "F1H1", start: 8, end: 9 }], {
    repoRoot: repo.root, files: diff.files, fullFiles: new Map([["F1", async () => rows]]),
  });
  assert.ok(blocks[0].type === "code");
  assert.equal(blocks[0].fileId, "F1");
  assert.equal(blocks[0].filePath, "example.ts");
  assert.ok(blocks[0].rows.length < rows.length);
});

test("commit and branch files use the selected revision even after the branch and working tree move", async (t) => {
  const repo = await repository(t);
  await repo.save("example.ts", original);
  await repo.commit();
  const base = await repo.git("rev-parse", "HEAD");
  await repo.save("example.ts", changed);
  await repo.commit();
  const head = await repo.git("rev-parse", "HEAD");
  await repo.git("branch", "selected", head);
  const branch = await getDiff(repo.root, { kind: "branch", base, head: "selected" });
  const commit = await getDiff(repo.root, { kind: "commit", sha: head });
  await repo.save("example.ts", "later committed version\n");
  await repo.commit();
  await repo.git("branch", "-f", "selected", "HEAD");
  for (const diff of [branch, commit]) {
    const session = new Session({ repoRoot: repo.root, diff, language: "日本語" });
    assertVersions((await session.getFileRows("F1"))!, original, changed);
  }
});

test("added and deleted files need no disk content, and renamed files retain both paths' line numbers", async (t) => {
  const repo = await repository(t);
  await repo.save("old.ts", original);
  await repo.save("deleted.ts", "deleted\n\nlast line");
  await repo.commit();
  await rename(path.join(repo.root, "old.ts"), path.join(repo.root, "renamed.ts"));
  await repo.save("renamed.ts", changed);
  await rm(path.join(repo.root, "deleted.ts"));
  await repo.save("added.ts", "added\n\nlast line\n");
  await repo.commit();
  const diff = await getDiff(repo.root, { kind: "commit", sha: "HEAD" });
  const added = diff.files.find((f) => f.status === "added")!;
  const deleted = diff.files.find((f) => f.status === "deleted")!;
  const renamed = diff.files.find((f) => f.status === "renamed")!;
  assert.ok(added && deleted && renamed);
  assertVersions(fullFileRows(added, ""), "", "added\n\nlast line\n");
  assertVersions(fullFileRows(deleted, ""), "deleted\n\nlast line", "");
  assertVersions(fullFileRows(renamed, await diff.readFile!(renamed)), original, changed);
  for (const [file, expectedPath] of [[added, "added.ts"], [deleted, "deleted.ts"], [renamed, "renamed.ts"]] as const) {
    const [block] = resolveBlocks([{ type: "code", hunk_id: file.hunks[0].id }], { repoRoot: repo.root, files: diff.files });
    assert.ok(block.type === "code");
    assert.equal(block.filePath, expectedPath);
    if (file === renamed) assert.equal(block.file, "old.ts → renamed.ts");
  }
});

test("context blocks register their own unchanged snapshot without a phantom trailing line", async (t) => {
  const repo = await repository(t);
  await repo.save("context.ts", original);
  const fullFiles = new Map<string, () => Promise<Row[]>>();
  const [block] = resolveBlocks([{ type: "context", file: "context.ts", start: 8, end: 9, notes: [{ line: 8, text: "注釈" }] }], {
    repoRoot: repo.root, files: [], fullFiles,
  });
  assert.ok(block.type === "code" && block.fileId);
  assert.equal(block.filePath, "context.ts");
  assert.deepEqual(block.rows.map((r) => r.newN), [8, 9]);
  await repo.save("context.ts", "later\n");
  const rows = await fullFiles.get(block.fileId)!();
  assert.equal(rows.length, 40);
  assertVersions(rows, original, original);
  assert.deepEqual(block.notes, [{ line: 8, text: "注釈" }]);
});

test("full files handle empty-range hunks and CRLF, and reject a mismatched snapshot", () => {
  const [file] = parseDiff("diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -2 +1,0 @@\n-removed\n");
  assertVersions(fullFileRows(file, "first\nthird\n"), "first\nremoved\nthird\n", "first\nthird\n");
  const [crlf] = parseDiff("diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n first\r\n-old\r\n+new\r\n");
  assertVersions(fullFileRows(crlf, "first\r\nnew\r\n"), "first\r\nold\r\n", "first\r\nnew\r\n");
  assert.throws(() => fullFileRows(crlf, "different\n"), /一致しません/);
});

test("working files match normalized Git patches when autocrlf is enabled", async (t) => {
  const repo = await repository(t);
  await repo.save("example.ts", original);
  await repo.commit();
  await repo.git("config", "core.autocrlf", "true");
  await repo.save("example.ts", changed.replace(/\n/g, "\r\n"));
  const diff = await getDiff(repo.root, { kind: "working" });
  const session = new Session({ repoRoot: repo.root, diff, language: "日本語" });
  assertVersions((await session.getFileRows("F1"))!, original, changed);
});

test("PR full files can load a pinned fork revision without fetching it locally", async (t) => {
  const repo = await repository(t);
  await repo.save("file #1.ts", original);
  await repo.commit();
  await repo.save("file #1.ts", changed);
  const raw = (await promisify(execFile)("git", ["diff", "--no-color"], { cwd: repo.root })).stdout;
  const revision = "f".repeat(40);
  const gh = path.join(repo.root, "gh");
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "diff") process.stdout.write(${JSON.stringify(raw)});
else if (args[0] === "pr" && args[1] === "view") console.log(JSON.stringify({title:"Fork PR", headRefOid:${JSON.stringify(revision)}, headRepositoryOwner:{login:"fork-owner"}, headRepository:{name:"fork-repo"}}));
else if (args[0] === "api" && args[1] === ${JSON.stringify(`repos/fork-owner/fork-repo/contents/file%20%231.ts?ref=${revision}`)}) process.stdout.write(${JSON.stringify(changed)});
else process.exit(1);
`;
  await writeFile(gh, script);
  await chmod(gh, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${repo.root}${path.delimiter}${previousPath}`;
  try {
    const diff = await getDiff(repo.root, { kind: "pr", number: 12 });
    const session = new Session({ repoRoot: repo.root, diff, language: "日本語" });
    assertVersions((await session.getFileRows("F1"))!, original, changed);
  } finally {
    process.env.PATH = previousPath;
  }
});

test("a failed full-file read can be retried", async () => {
  let attempts = 0;
  const file: FileDiff = { id: "F1", oldPath: "f", newPath: "f", status: "modified", additions: 0, deletions: 0, hunks: [] };
  const session = new Session({ repoRoot: process.cwd(), language: "日本語", diff: {
    title: "test", raw: "", files: [file], readFile: async () => { if (++attempts === 1) throw new Error("unavailable"); return "ok\n"; },
  } });
  await assert.rejects(session.getFileRows("F1")!, /unavailable/);
  assert.deepEqual(await session.getFileRows("F1"), textRows("ok\n"));
  assert.equal(attempts, 2);
});
