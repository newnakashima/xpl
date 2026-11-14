import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";

const execFileP = promisify(execFile);

export type DiffSource =
  | { kind: "working" } // git diff HEAD + untracked files
  | { kind: "branch"; base: string; head?: string } // base...head (default HEAD)
  | { kind: "commit"; sha: string }
  | { kind: "pr"; number: number };

export interface Hunk {
  id: string; // e.g. "F2H1"
  header: string; // @@ -a,b +c,d @@ ...
  oldStart: number;
  newStart: number;
  lines: string[]; // raw lines including leading +/-/space
}

export interface FileDiff {
  id: string; // e.g. "F2"
  oldPath: string;
  newPath: string;
  status: "added" | "deleted" | "modified" | "renamed" | "binary";
  additions: number;
  deletions: number;
  hunks: Hunk[];
}

export interface DiffResult {
  title: string;
  description?: string;
  files: FileDiff[];
  raw: string;
  /** Full resulting file at the same revision as the diff (working files are snapshotted). */
  readFile?: (file: FileDiff) => Promise<string>;
}

const MAX_BUFFER = 256 * 1024 * 1024;

async function run(cmd: string, args: string[], cwd: string, okCodes = [0]): Promise<string> {
  try {
    const { stdout } = await execFileP(cmd, args, { cwd, maxBuffer: MAX_BUFFER });
    return stdout;
  } catch (e: any) {
    if (typeof e.code === "number" && okCodes.includes(e.code)) return e.stdout ?? "";
    const msg = (e.stderr || e.message || String(e)).toString().trim();
    throw new Error(`${cmd} ${args.join(" ")} failed: ${msg}`);
  }
}

const git = (cwd: string, args: string[], okCodes?: number[]) => run("git", args, cwd, okCodes);

export async function resolveRepoRoot(p: string): Promise<string> {
  const abs = path.resolve(p);
  const out = await git(abs, ["rev-parse", "--show-toplevel"]);
  return out.trim();
}

export interface RepoInfo {
  root: string;
  currentBranch: string;
  branches: string[];
  defaultBase?: string;
  commits: { sha: string; subject: string; author: string; date: string }[];
  prs: { number: number; title: string; headRefName: string; author: string }[];
  prError?: string;
  workingSummary: string;
}

export async function getRepoInfo(p: string): Promise<RepoInfo> {
  const root = await resolveRepoRoot(p);
  const currentBranch = (
    await git(root, ["rev-parse", "--abbrev-ref", "HEAD"], [0, 128]).catch(() => "")
  ).trim();
  const branchesOut = await git(root, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
    "refs/remotes",
  ]).catch(() => "");
  const branches = branchesOut
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !s.endsWith("/HEAD") && s !== "origin");
  const defaultBase = [
    "origin/main",
    "main",
    "origin/master",
    "master",
    "origin/develop",
    "develop",
  ].find((b) => branches.includes(b));
  const logOut = await git(root, ["log", "-n", "40", "--format=%H%x1f%s%x1f%an%x1f%ar"]).catch(
    () => "",
  );
  const commits = logOut
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [sha, subject, author, date] = l.split("\x1f");
      return { sha, subject, author, date };
    });
  let prs: RepoInfo["prs"] = [];
  let prError: string | undefined;
  try {
    const out = await run(
      "gh",
      ["pr", "list", "--limit", "50", "--json", "number,title,headRefName,author"],
      root,
    );
    prs = JSON.parse(out).map((p: any) => ({
      number: p.number,
      title: p.title,
      headRefName: p.headRefName,
      author: p.author?.login ?? "",
    }));
  } catch (e: any) {
    prError = e.message;
  }
  const status = await git(root, ["status", "--short"]).catch(() => "");
  const lines = status.split("\n").filter(Boolean);
  const untracked = lines.filter((l) => l.startsWith("??")).length;
  const workingSummary = `${lines.length - untracked} changed, ${untracked} untracked`;
  return { root, currentBranch, branches, defaultBase, commits, prs, prError, workingSummary };
}

async function hasHead(root: string) {
  try {
    await git(root, ["rev-parse", "--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

export async function getDiff(repoPath: string, source: DiffSource): Promise<DiffResult> {
  const root = await resolveRepoRoot(repoPath);
  const common = ["--no-color", "--no-ext-diff", "-M", "--unified=3"];
  let raw = "";
  let title = "";
  let description: string | undefined;
  let readFile: DiffResult["readFile"];

  switch (source.kind) {
    case "working": {
      if (await hasHead(root)) {
        raw = await git(root, ["diff", ...common, "HEAD"]);
      } else {
        raw = await git(root, ["diff", ...common, "--cached"]);
      }
      const untracked = (await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]))
        .split("\0")
        .filter(Boolean);
      for (const f of untracked) {
        // skip huge files
        try {
          const st = await fs.stat(path.join(root, f));
          if (st.size > 2 * 1024 * 1024) continue;
        } catch {
          continue;
        }
        raw += await git(root, ["diff", ...common, "--no-index", "--", "/dev/null", f], [0, 1]);
      }
      title = "Working tree changes (incl. untracked)";
      break;
    }
    case "branch": {
      const head = source.head || "HEAD";
      const revision = (await git(root, ["rev-parse", "--verify", `${head}^{commit}`])).trim();
      raw = await git(root, ["diff", ...common, `${source.base}...${revision}`]);
      readFile = (file) => git(root, ["show", `${revision}:${file.newPath}`]);
      title = `${source.base}...${head}`;
      const log = await git(root, ["log", "--format=- %s", `${source.base}..${head}`]).catch(
        () => "",
      );
      if (log.trim()) description = `Commits:\n${log}`;
      break;
    }
    case "commit": {
      const revision = (
        await git(root, ["rev-parse", "--verify", `${source.sha}^{commit}`])
      ).trim();
      raw = await git(root, ["show", ...common, "--format=", revision]);
      readFile = (file) => git(root, ["show", `${revision}:${file.newPath}`]);
      const meta = await git(root, ["show", "-s", "--format=%h %s%n%n%b", source.sha]);
      title = `Commit ${meta.split("\n")[0]}`;
      description = meta;
      break;
    }
    case "pr": {
      raw = await run("gh", ["pr", "diff", String(source.number), "--color=never"], root);
      const meta = JSON.parse(
        await run(
          "gh",
          [
            "pr",
            "view",
            String(source.number),
            "--json",
            "title,body,headRefName,baseRefName,headRefOid,headRepository,headRepositoryOwner",
          ],
          root,
        ),
      );
      readFile = async (file) => {
        try {
          return await git(root, ["show", `${meta.headRefOid}:${file.newPath}`]);
        } catch {
          // PR heads (including forks) need not be checked out or fetched locally.
          const repository = `${meta.headRepositoryOwner.login}/${meta.headRepository.name}`;
          const filePath = file.newPath.split("/").map(encodeURIComponent).join("/");
          return run(
            "gh",
            [
              "api",
              `repos/${repository}/contents/${filePath}?ref=${meta.headRefOid}`,
              "-H",
              "Accept: application/vnd.github.raw+json",
            ],
            root,
          );
        }
      };
      title = `PR #${source.number}: ${meta.title}`;
      description = `${meta.baseRefName} <- ${meta.headRefName}\n\n${meta.body ?? ""}`;
      break;
    }
  }
  const all = parseDiff(raw);
  const files = all.filter((f) => !isNoise(displayPath(f)));
  const skipped = all.filter((f) => isNoise(displayPath(f)));
  if (skipped.length) {
    description =
      `${description ?? ""}\n\n(Auto-excluded generated/lock files: ${skipped.map(displayPath).join(", ")})`.trim();
  }
  files.forEach((f, i) => {
    const id = `F${i + 1}`;
    f.hunks.forEach((h, j) => (h.id = `${id}H${j + 1}`));
    f.id = id;
  });
  if (source.kind === "working") {
    // The user may keep editing while reading. Do not mix those later edits
    // into the diff or its line numbers when they open the full file.
    const snapshots = new Map<string, string | Error>();
    await Promise.all(
      files
        .filter((f) => f.status !== "deleted" && f.status !== "added" && f.status !== "binary")
        .map(async (file) => {
          try {
            const abs = path.join(root, file.newPath);
            const stat = await fs.lstat(abs);
            snapshots.set(
              file.id,
              stat.isSymbolicLink() ? await fs.readlink(abs) : await fs.readFile(abs, "utf8"),
            );
          } catch {
            snapshots.set(file.id, new Error(`ファイルを読み込めません: ${file.newPath}`));
          }
        }),
    );
    readFile = async (file) => {
      const snapshot = snapshots.get(file.id);
      if (snapshot instanceof Error) throw snapshot;
      if (snapshot === undefined) throw new Error(`ファイルを読み込めません: ${file.newPath}`);
      return snapshot;
    };
  }
  return { title, description, files, raw, readFile };
}

const NOISE = [
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum|uv\.lock)$/,
  /(^|\/)(dist|build|out|\.next|coverage)\//,
  /\.min\.(js|css)$/,
  /\.map$/,
];
function isNoise(p: string) {
  return NOISE.some((r) => r.test(p));
}

export function parseDiff(raw: string): FileDiff[] {
  const files: FileDiff[] = [];
  const lines = raw.split("\n");
  let cur: FileDiff | null = null;
  let hunk: Hunk | null = null;

  const unquote = (s: string) => {
    s = s.trim();
    if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
    return s;
  };
  const stripPrefix = (s: string) => {
    s = unquote(s);
    if (s === "/dev/null") return s;
    return s.replace(/^[ab]\//, "");
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      hunk = null;
      cur = {
        id: `F${files.length + 1}`,
        oldPath: "",
        newPath: "",
        status: "modified",
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      const m = line.match(/^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/);
      if (m) {
        cur.oldPath = m[1];
        cur.newPath = m[2];
      }
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (!hunk) {
      if (line.startsWith("--- ")) {
        const p = stripPrefix(line.slice(4));
        if (p === "/dev/null") cur.status = "added";
        else cur.oldPath = p;
        continue;
      }
      if (line.startsWith("+++ ")) {
        const p = stripPrefix(line.slice(4));
        if (p === "/dev/null") cur.status = "deleted";
        else cur.newPath = p;
        continue;
      }
      if (line.startsWith("new file mode")) cur.status = "added";
      else if (line.startsWith("deleted file mode")) cur.status = "deleted";
      else if (line.startsWith("rename from ")) {
        cur.status = "renamed";
        cur.oldPath = line.slice(12);
      } else if (line.startsWith("rename to ")) cur.newPath = line.slice(10);
      else if (line.startsWith("Binary files")) cur.status = "binary";
    }
    if (line.startsWith("@@")) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      hunk = {
        id: `${cur.id}H${cur.hunks.length + 1}`,
        header: line,
        oldStart: m ? Number(m[1]) : 0,
        newStart: m ? Number(m[2]) : 0,
        lines: [],
      };
      cur.hunks.push(hunk);
      continue;
    }
    if (hunk) {
      if (line.startsWith("+")) cur.additions++;
      else if (line.startsWith("-")) cur.deletions++;
      else if (!line.startsWith(" ") && !line.startsWith("\\")) continue;
      hunk.lines.push(line);
    }
  }
  for (const f of files) {
    if (f.status === "added" && !f.newPath) f.newPath = f.oldPath;
    if (f.status === "deleted" && !f.oldPath) f.oldPath = f.newPath;
  }
  return files;
}

export function displayPath(f: FileDiff) {
  if (f.status === "renamed") return `${f.oldPath} → ${f.newPath}`;
  return f.status === "deleted" ? f.oldPath : f.newPath;
}

/** Render diff with hunk IDs so the model can reference them. */
export function annotatedDiff(files: FileDiff[], only?: (f: FileDiff) => boolean): string {
  const out: string[] = [];
  for (const f of files) {
    if (only && !only(f)) continue;
    out.push(`=== [${f.id}] ${displayPath(f)} (${f.status}, +${f.additions} -${f.deletions}) ===`);
    if (f.status === "binary") {
      out.push("(binary file)");
      continue;
    }
    for (const h of f.hunks) {
      out.push(`--- [${h.id}] ${h.header}`);
      let oldN = h.oldStart;
      let newN = h.newStart;
      for (const l of h.lines) {
        // Prefix with new-file line numbers for easier referencing
        if (l.startsWith("+")) out.push(`${String(newN++).padStart(5)} ${l}`);
        else if (l.startsWith("-")) {
          oldN++;
          out.push(`      ${l}`);
        } else if (l.startsWith("\\")) out.push(`      ${l}`);
        else {
          oldN++;
          out.push(`${String(newN++).padStart(5)} ${l}`);
        }
      }
    }
  }
  return out.join("\n");
}

export function fileSummary(files: FileDiff[]): string {
  return files
    .map(
      (f) =>
        `[${f.id}] ${displayPath(f)} (${f.status}, +${f.additions} -${f.deletions}, hunks: ${f.hunks
          .map((h) => h.id)
          .join(", ")})`,
    )
    .join("\n");
}
