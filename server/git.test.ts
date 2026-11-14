import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { annotatedDiff, displayPath, fileSummary, getDiff, getRepoInfo, parseDiff, resolveRepoRoot } from "./git.js";

async function repository(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "xpl-git-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = async (...args: string[]) => (await promisify(execFile)("git", args, {
    cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  })).stdout.trim();
  await git("init", "-b", "main");
  await git("config", "user.name", "Fixture Author");
  await git("config", "user.email", "fixture@example.com");
  await git("config", "commit.gpgsign", "false");
  await git("config", "core.autocrlf", "false");
  const save = async (file: string, content: string | Buffer) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  };
  const commit = async (message = "fixture") => { await git("add", "."); await git("commit", "-m", message); return git("rev-parse", "HEAD"); };
  // Keep gh offline, regardless of credentials or remotes on the developer's machine.
  const bin = path.join(root, ".git", "test-bin");
  await mkdir(bin);
  const gh = path.join(bin, "gh");
  const setGh = async (body: string) => { await writeFile(gh, `#!${process.execPath}\n${body}\n`); await chmod(gh, 0o755); };
  await setGh('console.error("fixture: GitHub unavailable"); process.exit(1);');
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previous}`;
  t.after(() => { process.env.PATH = previous; });
  return { root, git, save, commit, setGh };
}

const patch = [
  "preamble ignored", "diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts",
  "@@ -3,3 +3,4 @@ function example()", " unchanged", "-old", "+new", "+extra", " tail",
  "@@ -20 +21 @@", "---literal deletion", "+++literal addition", "\\ No newline at end of file", "",
].join("\n");

test("parseDiff preserves hunk IDs, line offsets, content resembling headers, and EOF markers", () => {
  assert.deepEqual(parseDiff(""), []);
  const [file] = parseDiff(patch);
  assert.deepEqual(file, {
    id: "F1", oldPath: "src/a.ts", newPath: "src/a.ts", status: "modified", additions: 3, deletions: 2,
    hunks: [
      { id: "F1H1", header: "@@ -3,3 +3,4 @@ function example()", oldStart: 3, newStart: 3, lines: [" unchanged", "-old", "+new", "+extra", " tail"] },
      { id: "F1H2", header: "@@ -20 +21 @@", oldStart: 20, newStart: 21, lines: ["---literal deletion", "+++literal addition", "\\ No newline at end of file"] },
    ],
  });
});

test("parseDiff distinguishes additions, deletions, renames, binary files, and mode-only changes", () => {
  const files = parseDiff([
    "diff --git a/new.ts b/new.ts", "new file mode 100644", "--- /dev/null", "+++ b/new.ts", "@@ -0,0 +1 @@", "+new",
    "diff --git a/gone.ts b/gone.ts", "deleted file mode 100644", "--- a/gone.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-gone",
    'diff --git "a/old name.ts" "b/new name.ts"', "similarity index 100%", "rename from old name.ts", "rename to new name.ts",
    "diff --git a/image.png b/image.png", "Binary files a/image.png and b/image.png differ",
    "diff --git a/run.sh b/run.sh", "old mode 100644", "new mode 100755", "",
  ].join("\n"));
  assert.deepEqual(files.map((f) => [f.id, f.status, displayPath(f), f.hunks.length]), [
    ["F1", "added", "new.ts", 1], ["F2", "deleted", "gone.ts", 1],
    ["F3", "renamed", "old name.ts → new name.ts", 0], ["F4", "binary", "image.png", 0], ["F5", "modified", "run.sh", 0],
  ]);
  assert.equal(files[0].hunks[0].oldStart, 0);
  assert.equal(files[1].hunks[0].newStart, 0);
});

test("annotatedDiff numbers only resulting lines and fileSummary keeps hunk references", () => {
  const files = parseDiff(patch);
  assert.equal(annotatedDiff(files), [
    "=== [F1] src/a.ts (modified, +3 -2) ===", "--- [F1H1] @@ -3,3 +3,4 @@ function example()",
    "    3  unchanged", "      -old", "    4 +new", "    5 +extra", "    6  tail",
    "--- [F1H2] @@ -20 +21 @@", "      ---literal deletion", "   21 +++literal addition", "      \\ No newline at end of file",
  ].join("\n"));
  assert.equal(annotatedDiff(files, () => false), "");
  assert.equal(fileSummary(files), "[F1] src/a.ts (modified, +3 -2, hunks: F1H1, F1H2)");
  assert.equal(annotatedDiff(parseDiff("diff --git a/i b/i\nBinary files a/i and b/i differ\n")), "=== [F1] i (binary, +0 -0) ===\n(binary file)");
});

test("working diffs combine staged, unstaged, and untracked changes while honoring gitignore", async (t) => {
  const repo = await repository(t);
  await repo.save("staged.ts", "before\n");
  await repo.save("unstaged.ts", "before\n");
  await repo.save(".gitignore", "ignored.txt\n");
  await repo.commit();
  await repo.save("staged.ts", "staged\n");
  await repo.git("add", "staged.ts");
  await repo.save("unstaged.ts", "unstaged\n");
  await repo.save("untracked name.ts", "untracked\n");
  await repo.save("ignored.txt", "ignored\n");
  const diff = await getDiff(repo.root, { kind: "working" });
  assert.deepEqual(diff.files.map((f) => displayPath(f)).sort(), ["staged.ts", "unstaged.ts", "untracked name.ts"]);
  assert.deepEqual(diff.files.map((f) => [f.additions, f.deletions]), [[1, 1], [1, 1], [1, 0]]);
  assert.match(diff.title, /Working tree/);
});

test("working diffs work before the first commit and skip oversized untracked files", async (t) => {
  const repo = await repository(t);
  await repo.save("staged.ts", "staged\n");
  await repo.git("add", "staged.ts");
  await repo.save("untracked.ts", "untracked\n");
  await repo.save("huge.txt", Buffer.alloc(2 * 1024 * 1024 + 1, "a"));
  const diff = await getDiff(repo.root, { kind: "working" });
  assert.deepEqual(diff.files.map((f) => [displayPath(f), f.status]), [["staged.ts", "added"], ["untracked.ts", "added"]]);
});

test("generated and lock files are excluded, reported, and remaining hunk IDs are contiguous", async (t) => {
  const repo = await repository(t);
  const excluded = ["package-lock.json", "nested/yarn.lock", "dist/app.js", "coverage/index.html", "app.min.js", "app.js.map"];
  for (const name of [...excluded, "src/app.ts", "src/yarn.lock.ts"]) await repo.save(name, "content\n");
  const diff = await getDiff(repo.root, { kind: "working" });
  assert.deepEqual(diff.files.map((f) => [f.id, displayPath(f), f.hunks[0].id]), [
    ["F1", "src/app.ts", "F1H1"], ["F2", "src/yarn.lock.ts", "F2H1"],
  ]);
  assert.match(diff.description!, /Auto-excluded/);
  for (const name of excluded) assert.ok(diff.description!.includes(name), name);
});

test("branch comparisons use the merge base and default to HEAD", async (t) => {
  const repo = await repository(t);
  await repo.save("common.ts", "common\n");
  await repo.commit("common ancestor");
  await repo.git("branch", "feature");
  await repo.save("base-only.ts", "base change\n");
  await repo.commit("base advanced");
  await repo.git("checkout", "feature");
  await repo.save("feature.ts", "feature change\n");
  await repo.commit("add feature");
  const diff = await getDiff(repo.root, { kind: "branch", base: "main" });
  assert.equal(diff.title, "main...HEAD");
  assert.deepEqual(diff.files.map(displayPath), ["feature.ts"]);
  assert.match(diff.description!, /add feature/);
  assert.doesNotMatch(diff.description!, /base advanced/);
});

test("commit diffs include metadata and support the repository's first commit", async (t) => {
  const repo = await repository(t);
  await repo.save("initial.ts", "first\n");
  const sha = await repo.commit("initial subject\n\nDetailed rationale.");
  const diff = await getDiff(repo.root, { kind: "commit", sha });
  assert.match(diff.title, /^Commit [0-9a-f]+ initial subject$/);
  assert.match(diff.description!, /Detailed rationale\./);
  assert.deepEqual(diff.files.map((f) => [displayPath(f), f.status]), [["initial.ts", "added"]]);
});

test("repository info resolves nested paths and preserves Git information when gh fails", async (t) => {
  const repo = await repository(t);
  await repo.save("src/a.ts", "before\n");
  const sha = await repo.commit("known subject");
  await repo.git("branch", "feature");
  await repo.save("src/a.ts", "after\n");
  await repo.save("new.ts", "new\n");
  const nested = path.join(repo.root, "src");
  assert.equal(await resolveRepoRoot(nested), await resolveRepoRoot(repo.root));
  const info = await getRepoInfo(nested);
  assert.equal(info.currentBranch, "main");
  assert.deepEqual(info.branches, ["feature", "main"]);
  assert.equal(info.defaultBase, "main");
  assert.equal(info.commits[0].sha, sha);
  assert.equal(info.commits[0].subject, "known subject");
  assert.equal(info.commits[0].author, "Fixture Author");
  assert.equal(info.workingSummary, "1 changed, 1 untracked");
  assert.deepEqual(info.prs, []);
  assert.match(info.prError!, /GitHub unavailable/);
});

test("repository info maps PR authors and prioritizes origin/main as the default base", async (t) => {
  const repo = await repository(t);
  await repo.save("a", "a\n");
  await repo.commit();
  await repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  await repo.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  await repo.setGh(`console.log(JSON.stringify([{number:7,title:"Example",headRefName:"feature",author:{login:"alice"}},{number:8,title:"Deleted author",headRefName:"other"}]));`);
  const info = await getRepoInfo(repo.root);
  assert.equal(info.defaultBase, "origin/main");
  assert.ok(!info.branches.includes("origin/HEAD"));
  assert.deepEqual(info.prs, [
    { number: 7, title: "Example", headRefName: "feature", author: "alice" },
    { number: 8, title: "Deleted author", headRefName: "other", author: "" },
  ]);
  assert.equal(info.prError, undefined);
});

test("invalid repositories and revisions fail with useful command errors", async (t) => {
  const repo = await repository(t);
  const outside = await mkdtemp(path.join(tmpdir(), "xpl-not-git-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await assert.rejects(resolveRepoRoot(outside), /git rev-parse.*failed/);
  await assert.rejects(getDiff(repo.root, { kind: "commit", sha: "missing" }), /missing.*failed/);
  await assert.rejects(getDiff(repo.root, { kind: "pr", number: 7 }), /gh pr diff 7.*failed/);
});
