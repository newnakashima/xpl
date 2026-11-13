import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { displayPath, type FileDiff, type Hunk } from "./git.js";
import { hunkRows, textRows, type Row } from "./file-rows.js";
export type { Row } from "./file-rows.js";

/* ---------- Schema the AI writes ---------- */

const Note = z.object({
  line: z.number().int().describe("Line number the note attaches to (new-file numbers; old-file numbers for view 'old')"),
  text: z.string().describe("Very short annotation (one phrase)"),
});

export const BlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), markdown: z.string().describe("1-3 short sentences or bullets") }),
  z.object({
    type: z.literal("callout"),
    tone: z.enum(["info", "tip", "risk"]),
    markdown: z.string().describe("One short sentence"),
  }),
  z.object({
    type: z.literal("code"),
    hunk_id: z.string(),
    start: z.number().int().optional().describe("First line (new-file numbers; old-file for view 'old'). Omit for whole hunk"),
    end: z.number().int().optional(),
    view: z
      .enum(["new", "diff", "split", "old"])
      .optional()
      .describe("new = resulting code with added lines marked (best for additions); diff = unified; split = before | after side by side (best for rewrites); old = removed code"),
    highlight: z.array(z.number().int()).optional().describe("Lines to emphasize"),
    notes: z.array(Note).optional().describe("Inline annotations next to specific lines — prefer these over prose"),
    caption: z.string().optional(),
  }),
  z.object({
    type: z.literal("context"),
    file: z.string().describe("Repo-relative path of unchanged surrounding code (e.g. a caller)"),
    start: z.number().int(),
    end: z.number().int(),
    highlight: z.array(z.number().int()).optional(),
    notes: z.array(Note).optional(),
    caption: z.string().optional(),
  }),
  z.object({ type: z.literal("mermaid"), code: z.string(), title: z.string().optional() }),
  z.object({
    type: z.literal("html"),
    code: z.string().describe("Self-contained HTML/SVG/CSS/JS fragment, no network"),
    title: z.string().optional(),
  }),
]);
export type BlockInput = z.infer<typeof BlockSchema>;

/* ---------- Resolved blocks sent to the UI ---------- */

export type Block =
  | { type: "text"; markdown: string }
  | { type: "callout"; tone: "info" | "tip" | "risk"; markdown: string }
  | {
      type: "code";
      file: string;
      filePath: string;
      lang: string;
      view: "new" | "diff" | "split" | "old" | "context";
      rows: Row[];
      highlight: number[];
      notes: { line: number; text: string }[];
      caption?: string;
      fileStatus?: FileDiff["status"];
      fileId?: string;
    }
  | { type: "mermaid"; code: string; title?: string }
  | { type: "html"; code: string; title?: string };

const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift", php: "php",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp", scala: "scala", sh: "bash", zsh: "bash",
  sql: "sql", json: "json", yml: "yaml", yaml: "yaml", toml: "ini", md: "markdown", html: "xml", vue: "xml",
  xml: "xml", css: "css", scss: "scss", dart: "dart", lua: "lua", ex: "elixir", exs: "elixir",
};
export function langOf(file: string) {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  return EXT_LANG[ext] ?? "plaintext";
}

export interface ResolveCtx {
  files: FileDiff[];
  repoRoot: string;
  fullFiles?: Map<string, () => Promise<Row[]>>;
}

export class BlockError extends Error {}

export function resolveBlocks(input: BlockInput[], ctx: ResolveCtx): Block[] {
  const hunks = new Map<string, { f: FileDiff; h: Hunk }>();
  for (const f of ctx.files) for (const h of f.hunks) hunks.set(h.id, { f, h });

  return input.map((b): Block => {
    switch (b.type) {
      case "text":
      case "callout":
      case "mermaid":
      case "html":
        return b;
      case "code": {
        const hit = hunks.get(b.hunk_id);
        if (!hit) throw new BlockError(`Unknown hunk_id ${b.hunk_id}`);
        const all = hunkRows(hit.h);
        const pureDeletion = !all.some((r) => r.kind !== "del");
        let view = b.view ?? (all.some((r) => r.kind === "del") ? "diff" : "new");
        if (pureDeletion) view = "old";
        const useOld = view === "old";
        let rows: Row[];
        if (view === "new") rows = all.filter((r) => r.kind !== "del");
        else if (view === "old") rows = all.filter((r) => r.kind !== "add");
        else rows = all;
        if (b.start != null || b.end != null) {
          const s = b.start ?? -Infinity;
          const e = b.end ?? Infinity;
          // deleted rows are attributed to the position of the next new line
          let attributed = hit.h.newStart;
          rows = rows.filter((r) => {
            const n = useOld ? r.oldN! : r.newN ?? attributed;
            if (r.newN != null) attributed = r.newN + 1;
            return n >= s && n <= e;
          });
          if (!rows.length) throw new BlockError(`Range ${b.start}-${b.end} selects no lines in ${b.hunk_id}`);
        }
        return {
          type: "code",
          file: displayPath(hit.f),
          filePath: hit.f.status === "deleted" ? hit.f.oldPath : hit.f.newPath,
          lang: langOf(hit.f.newPath || hit.f.oldPath),
          view,
          rows,
          highlight: b.highlight ?? [],
          notes: b.notes ?? [],
          caption: b.caption,
          fileStatus: hit.f.status,
          fileId: ctx.fullFiles?.has(hit.f.id) ? hit.f.id : undefined,
        };
      }
      case "context": {
        const abs = path.resolve(ctx.repoRoot, b.file);
        if (!abs.startsWith(ctx.repoRoot + path.sep)) throw new BlockError(`File outside repo: ${b.file}`);
        let text: string;
        try {
          text = fs.readFileSync(abs, "utf8");
        } catch {
          throw new BlockError(`Cannot read ${b.file}`);
        }
        const allRows = textRows(text);
        const s = Math.max(1, b.start);
        const e = Math.min(allRows.length, b.end);
        if (e < s) throw new BlockError(`Bad range for ${b.file}`);
        const rows = allRows.slice(s - 1, e);
        // Each context block retains exactly the file it was resolved against.
        const fileId = ctx.fullFiles ? `context-${ctx.fullFiles.size}` : undefined;
        if (fileId) ctx.fullFiles?.set(fileId, async () => allRows);
        return {
          type: "code",
          file: b.file,
          filePath: path.relative(ctx.repoRoot, abs),
          lang: langOf(b.file),
          view: "context",
          rows,
          highlight: b.highlight ?? [],
          notes: b.notes ?? [],
          caption: b.caption,
          fileId,
        };
      }
    }
  });
}

export function measure(blocks: Block[]) {
  let codeLines = 0;
  let prose = 0;
  for (const b of blocks) {
    if (b.type === "code") {
      if (b.view === "split") {
        const left = b.rows.filter((r) => r.kind !== "add").length;
        const right = b.rows.filter((r) => r.kind !== "del").length;
        codeLines += Math.max(left, right);
      } else codeLines += b.rows.length;
      prose += b.notes.reduce((a, n) => a + n.text.length, 0) * 0.5;
      prose += (b.caption?.length ?? 0);
    } else if (b.type === "text" || b.type === "callout") prose += b.markdown.length;
  }
  return { codeLines, prose: Math.round(prose) };
}
