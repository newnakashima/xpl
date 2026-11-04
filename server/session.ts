import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { query, tool, createSdkMcpServer, type SDKUserMessage, type Query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { annotatedDiff, displayPath, type DiffResult } from "./git.js";
import { initialPrompt, systemPrompt } from "./prompt.js";

export type Visual = { kind: "mermaid" | "html"; title?: string; code: string; caption?: string };
export type LineRange = { hunk_id: string; start: number; end: number };

export interface PlanStep {
  title: string;
  summary: string;
  hunk_ids: string[];
}

export interface Question {
  id: string;
  text: string;
  mode: "now" | "later";
  afterStep: number;
  answered: boolean;
}

export type SessionEvent =
  | { type: "meta"; title: string; description?: string; files: DiffResult["files"]; repo: string }
  | { type: "busy"; busy: boolean; label?: string }
  | { type: "activity"; text: string }
  | { type: "plan"; overview: string; steps: PlanStep[]; skipped_hunks: string[] }
  | {
      type: "step";
      index: number;
      title: string;
      markdown: string;
      visuals: Visual[];
      hunk_ids: string[];
      line_ranges: LineRange[];
    }
  | { type: "question"; question: Question }
  | { type: "answer"; questionId: string; markdown: string; visuals: Visual[]; hunk_ids: string[] }
  | { type: "phase"; phase: Phase }
  | { type: "error"; message: string };

type Phase = "planning" | "stepping" | "final_qa" | "finished";

const VisualSchema = z.object({
  kind: z.enum(["mermaid", "html"]),
  title: z.string().optional(),
  code: z.string().describe("Mermaid source or a self-contained HTML fragment"),
  caption: z.string().optional(),
});

/** A simple push-based async iterable for streaming input into the SDK. */
class Channel<T> implements AsyncIterable<T> {
  private buf: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;
  push(v: T) {
    const w = this.waiters.shift();
    if (w) w({ value: v, done: false });
    else this.buf.push(v);
  }
  close() {
    this.closed = true;
    for (const w of this.waiters) w({ value: undefined as any, done: true });
    this.waiters = [];
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.buf.length) return Promise.resolve({ value: this.buf.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as any, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
    };
  }
}

export interface SessionOptions {
  repoRoot: string;
  diff: DiffResult;
  language: string;
  model?: string;
}

export class Session extends EventEmitter {
  id = randomUUID();
  events: SessionEvent[] = [];
  phase: Phase = "planning";
  plan: PlanStep[] = [];
  shownSteps = new Set<number>();
  currentStep = -1;
  questions: Question[] = [];
  busy = false;
  private input = new Channel<SDKUserMessage>();
  private pending: { text: string; label: string; onSend?: () => void }[] = [];
  private q?: Query;
  private hunkIds: Set<string>;
  private planRejected = false;

  constructor(private opts: SessionOptions) {
    super();
    this.setMaxListeners(100);
    this.hunkIds = new Set(opts.diff.files.flatMap((f) => f.hunks.map((h) => h.id)));
  }

  private emitEvent(e: SessionEvent) {
    this.events.push(e);
    this.emit("event", e);
  }

  private setBusy(busy: boolean, label?: string) {
    this.busy = busy;
    this.emitEvent({ type: "busy", busy, label });
  }

  private setPhase(p: Phase) {
    this.phase = p;
    this.emitEvent({ type: "phase", phase: p });
  }

  private enqueue(text: string, label: string, onSend?: () => void) {
    this.pending.push({ text, label, onSend });
    this.pump();
  }

  private pump() {
    if (this.busy) return;
    const next = this.pending.shift();
    if (!next) return;
    this.setBusy(true, next.label);
    next.onSend?.();
    this.input.push({
      type: "user",
      message: { role: "user", content: next.text },
      parent_tool_use_id: null,
    });
  }

  private validHunks(ids: string[]) {
    return ids.filter((id) => this.hunkIds.has(id));
  }

  private buildMcp() {
    const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
    const err = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
    const { files } = this.opts.diff;

    return createSdkMcpServer({
      name: "xpl",
      version: "0.1.0",
      alwaysLoad: true,
      tools: [
        tool(
          "get_diff",
          "Return the annotated diff for the given files and/or hunks. Use when the diff was not inlined, or to re-read parts.",
          {
            file_ids: z.array(z.string()).optional().describe('e.g. ["F1","F3"]'),
            hunk_ids: z.array(z.string()).optional().describe('e.g. ["F2H1"]'),
          },
          async ({ file_ids, hunk_ids }) => {
            const fileSet = new Set(file_ids ?? []);
            const hunkSet = new Set(hunk_ids ?? []);
            const selected = files
              .map((f) => {
                if (fileSet.has(f.id)) return f;
                const hs = f.hunks.filter((h) => hunkSet.has(h.id));
                return hs.length ? { ...f, hunks: hs } : null;
              })
              .filter(Boolean) as typeof files;
            if (!selected.length) return err("No matching files/hunks.");
            const text = annotatedDiff(selected);
            const LIMIT = 100_000;
            return ok(text.length > LIMIT ? text.slice(0, LIMIT) + "\n... (truncated; request fewer files)" : text);
          }
        ),
        tool(
          "submit_plan",
          "Submit the ordered explanation plan. Call exactly once, before the first present_step.",
          {
            overview: z.string().describe("2-4 sentence summary of the whole change (markdown)"),
            steps: z
              .array(
                z.object({
                  title: z.string(),
                  summary: z.string().describe("One line describing what this step covers"),
                  hunk_ids: z.array(z.string()),
                })
              )
              .min(1),
            skipped_hunks: z.array(z.string()).optional().describe("Trivial hunks intentionally not explained"),
          },
          async ({ overview, steps, skipped_hunks }) => {
            const covered = new Set([...steps.flatMap((s) => s.hunk_ids), ...(skipped_hunks ?? [])]);
            const missing = [...this.hunkIds].filter((h) => !covered.has(h));
            if (missing.length && !this.planRejected && missing.length > Math.max(3, this.hunkIds.size * 0.1)) {
              // Reject once so the model fixes coverage.
              this.planRejected = true;
              return err(
                `These hunks are not covered by any step nor skipped_hunks: ${missing.join(
                  ", "
                )}. Call submit_plan again covering them (or list them in skipped_hunks if trivial).`
              );
            }
            this.plan = steps.map((s) => ({ ...s, hunk_ids: this.validHunks(s.hunk_ids) }));
            this.emitEvent({ type: "plan", overview, steps: this.plan, skipped_hunks: skipped_hunks ?? [] });
            this.setPhase("stepping");
            this.emitEvent({ type: "busy", busy: true, label: "ステップ 1 を作成中…" });
            return ok(`Plan accepted with ${steps.length} steps. Now call present_step for step 1 (index 0).`);
          }
        ),
        tool(
          "present_step",
          "Show ONE step of the explanation to the human. After calling this, end your turn and wait.",
          {
            index: z.number().int().describe("0-based step index in the plan"),
            title: z.string(),
            markdown: z.string().describe("The explanation (markdown)"),
            hunk_ids: z.array(z.string()).describe("Hunks to display alongside"),
            line_ranges: z
              .array(z.object({ hunk_id: z.string(), start: z.number().int(), end: z.number().int() }))
              .optional()
              .describe("Optional focus ranges (new-file line numbers) within hunks"),
            visuals: z.array(VisualSchema).optional(),
          },
          async (a) => {
            if (this.phase === "planning") return err("Call submit_plan first.");
            const expected = this.currentStep + 1;
            if (this.shownSteps.has(a.index)) return err(`Step ${a.index} was already shown. Wait for the human.`);
            if (a.index !== expected) return err(`Present step index ${expected} now (not ${a.index}).`);
            if (this.shownSteps.size > this.stepBudget) return err("Only one step per turn. End your turn now.");
            this.shownSteps.add(a.index);
            this.currentStep = a.index;
            this.emitEvent({
              type: "step",
              index: a.index,
              title: a.title,
              markdown: a.markdown,
              visuals: a.visuals ?? [],
              hunk_ids: this.validHunks(a.hunk_ids),
              line_ranges: a.line_ranges ?? [],
            });
            return ok("Displayed to the human. End your turn now and wait for OK or a question.");
          }
        ),
        tool(
          "answer_question",
          "Answer a question from the human. One call per question.",
          {
            question_id: z.string(),
            markdown: z.string(),
            hunk_ids: z.array(z.string()).optional(),
            visuals: z.array(VisualSchema).optional(),
          },
          async (a) => {
            const qn = this.questions.find((q) => q.id === a.question_id);
            if (!qn) return err(`Unknown question id ${a.question_id}`);
            qn.answered = true;
            this.emitEvent({
              type: "answer",
              questionId: qn.id,
              markdown: a.markdown,
              visuals: a.visuals ?? [],
              hunk_ids: this.validHunks(a.hunk_ids ?? []),
            });
            return ok("Answer displayed.");
          }
        ),
      ],
    });
  }

  /** Max number of steps allowed to be shown so far (enforces one step per turn). */
  private stepBudget = 0;

  async start() {
    const { diff, repoRoot } = this.opts;
    this.emitEvent({ type: "meta", title: diff.title, description: diff.description, files: diff.files, repo: repoRoot });
    if (!diff.files.length) {
      this.emitEvent({ type: "error", message: "差分がありません。" });
      this.setPhase("finished");
      return;
    }

    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "xpl/0.1.0" };
    // Use the user's Claude subscription (claude login) rather than an API key unless explicitly opted in.
    if (!process.env.XPL_USE_API_KEY) delete env.ANTHROPIC_API_KEY;

    const xplTools = ["get_diff", "submit_plan", "present_step", "answer_question"].map((t) => `mcp__xpl__${t}`);
    this.q = query({
      prompt: this.input,
      options: {
        cwd: repoRoot,
        model: this.opts.model || process.env.XPL_MODEL || undefined,
        systemPrompt: systemPrompt(this.opts.language),
        tools: ["Read", "Grep", "Glob"],
        allowedTools: ["Read", "Grep", "Glob", ...xplTools],
        permissionMode: "dontAsk",
        settingSources: [],
        mcpServers: { xpl: this.buildMcp() },
        env,
      },
    });

    this.stepBudget = 0;
    this.enqueue(initialPrompt(diff), "差分を分析して解説プランを作成中…");
    this.consume().catch((e) => {
      this.emitEvent({ type: "error", message: String(e?.message ?? e) });
      this.setBusy(false);
    });
  }

  private async consume() {
    for await (const msg of this.q!) {
      if (msg.type === "assistant") {
        for (const block of msg.message.content as any[]) {
          if (block.type === "tool_use") {
            const name: string = block.name;
            const input = block.input ?? {};
            if (name === "Read") this.emitEvent({ type: "activity", text: `Read ${rel(input.file_path, this.opts.repoRoot)}` });
            else if (name === "Grep") this.emitEvent({ type: "activity", text: `Grep "${input.pattern}"` });
            else if (name === "Glob") this.emitEvent({ type: "activity", text: `Glob ${input.pattern}` });
            else if (name === "mcp__xpl__get_diff")
              this.emitEvent({ type: "activity", text: `diff ${[...(input.file_ids ?? []), ...(input.hunk_ids ?? [])].join(", ")}` });
            else if (name === "mcp__xpl__submit_plan") this.emitEvent({ type: "activity", text: "プランを作成" });
            else if (name === "mcp__xpl__present_step") this.emitEvent({ type: "activity", text: "ステップを表示" });
          }
        }
      } else if (msg.type === "result") {
        if (msg.subtype !== "success" || (msg as any).is_error) {
          const detail = (msg as any).result || (msg as any).errors?.join("\n") || msg.subtype;
          this.emitEvent({ type: "error", message: `AI turn failed: ${detail}` });
        }
        this.onTurnEnd();
      }
    }
  }

  private onTurnEnd() {
    this.setBusy(false);
    if (this.phase === "final_qa" && !this.pending.length) {
      this.setPhase("finished");
    }
    this.pump();
  }

  /** Human pressed OK. */
  next() {
    if (this.phase !== "stepping") return;
    // Don't double-queue
    if (this.pending.some((p) => p.label.startsWith("ステップ"))) return;
    const nextIdx = this.currentStep + 1;
    if (nextIdx < this.plan.length) {
      this.enqueue(
        `OK. Present step ${nextIdx + 1} (index ${nextIdx}): "${this.plan[nextIdx].title}" with present_step, then end your turn.`,
        `ステップ ${nextIdx + 1} を準備中…`,
        () => (this.stepBudget = nextIdx)
      );
      return;
    }
    // All steps done
    const later = this.questions.filter((q) => q.mode === "later" && !q.answered);
    if (later.length) {
      this.setPhase("final_qa");
      const list = later.map((q) => `- [${q.id}] (asked during step ${q.afterStep + 1}) ${q.text}`).join("\n");
      this.enqueue(
        `All steps are done. The human saved these questions for the end. Answer each one with answer_question (one call per question), revisiting the relevant code as needed:\n${list}`,
        "まとめて質問に回答中…"
      );
    } else {
      this.setPhase("finished");
    }
  }

  ask(text: string, mode: "now" | "later") {
    const qn: Question = {
      id: `Q${this.questions.length + 1}`,
      text,
      mode,
      afterStep: Math.max(0, this.currentStep),
      answered: false,
    };
    this.questions.push(qn);
    this.emitEvent({ type: "question", question: qn });
    if (mode === "now" || this.phase === "final_qa" || this.phase === "finished") {
      if (this.phase === "finished") this.setPhase("final_qa");
      const stepInfo =
        this.currentStep >= 0 ? `while viewing step ${this.currentStep + 1} "${this.plan[this.currentStep]?.title}"` : "";
      this.enqueue(
        `Question [${qn.id}] from the human ${stepInfo}:\n${text}\n\nAnswer it with answer_question (question_id "${qn.id}"). Do NOT present the next step; end your turn after answering.`,
        `質問 ${qn.id} に回答中…`
      );
    }
  }

  close() {
    this.input.close();
    this.q?.close();
  }
}

function rel(p: string | undefined, root: string) {
  if (!p) return "";
  return p.startsWith(root) ? p.slice(root.length + 1) : p;
}

export { displayPath };
