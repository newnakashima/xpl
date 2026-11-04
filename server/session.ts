import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { query, tool, createSdkMcpServer, type SDKUserMessage, type Query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { annotatedDiff, type DiffResult } from "./git.js";
import { initialPrompt, systemPrompt, LIMITS, proseLimits } from "./prompt.js";
import { BlockSchema, BlockError, measure, resolveBlocks, type Block } from "./blocks.js";

export type LineRange = { hunk_id: string; start: number; end: number };

export interface PlanStep {
  section: string;
  title: string;
  hunk_ids: string[];
  line_ranges: LineRange[];
}

export interface Question {
  id: string;
  text: string;
  mode: "now" | "later";
  afterStep: number;
  answered: boolean;
}

export interface Step {
  index: number;
  title: string;
  blocks: Block[];
}

export type Phase = "planning" | "stepping" | "final_qa" | "finished";

export type SessionEvent =
  | { type: "meta"; title: string; description?: string; repo: string; fileCount: number; additions: number; deletions: number }
  | { type: "status"; waiting: boolean; label?: string; aiWorking: boolean; prepared: number }
  | { type: "activity"; text: string }
  | { type: "plan"; overview: string; steps: PlanStep[]; skipped_hunks: string[] }
  | ({ type: "step" } & Step)
  | { type: "question"; question: Question }
  | { type: "answer"; questionId: string; blocks: Block[] }
  | { type: "phase"; phase: Phase }
  | { type: "error"; message: string };

type TurnKind = "plan" | "prepare" | "question" | "final";
interface Turn {
  kind: TurnKind;
  text: string;
  prepIndex?: number;
  questionId?: string;
}

/** How many steps to prepare ahead of the one being read. */
const LOOKAHEAD = Math.max(0, Number(process.env.XPL_LOOKAHEAD ?? 2));

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
  questions: Question[] = [];

  /** Index of the step the human is currently reading (-1 = none yet). */
  private currentStep = -1;
  /** Human pressed OK (or session started) and wants currentStep+1 as soon as it is ready. */
  private wantNext = true;
  /** Steps prepared by the AI but not yet revealed. */
  private prepared = new Map<number, Step>();
  private nextToPrepare = 0;
  private presentedThisTurn = 0;
  private rejections = new Map<number, number>();
  private prepFailures = new Map<number, number>();

  private turn: Turn | null = null;
  private queue: Turn[] = [];
  private input = new Channel<SDKUserMessage>();
  private q?: Query;
  private hunkIds: Set<string>;
  private planRejected = false;

  constructor(private opts: SessionOptions) {
    super();
    this.setMaxListeners(100);
    this.hunkIds = new Set(opts.diff.files.flatMap((f) => f.hunks.map((h) => h.id)));
  }

  /* ---------- events ---------- */

  private emitEvent(e: SessionEvent) {
    this.events.push(e);
    this.emit("event", e);
  }

  private setPhase(p: Phase) {
    this.phase = p;
    this.emitEvent({ type: "phase", phase: p });
    this.updateStatus();
  }

  private lastStatus = "";
  private updateStatus() {
    let label: string | undefined;
    const pendingQ = [this.turn, ...this.queue].find((t) => t?.kind === "question");
    if (this.phase === "planning") label = "差分を読んで解説プランを作成中…";
    else if (this.phase === "final_qa") label = "まとめて質問に回答中…";
    else if (pendingQ) label = `質問 ${pendingQ.questionId} に回答中…`;
    else if (this.phase === "stepping" && this.wantNext && !this.prepared.has(this.currentStep + 1))
      label = `ステップ ${this.currentStep + 2} を準備中…`;
    const status: SessionEvent = {
      type: "status",
      waiting: !!label,
      label,
      aiWorking: !!this.turn,
      prepared: this.prepared.size,
    };
    const key = JSON.stringify(status);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    this.emitEvent(status);
  }

  /* ---------- turn scheduling ---------- */

  private enqueue(t: Turn, front = false) {
    if (front) {
      // questions go before prefetch work, but keep FIFO among questions
      const i = this.queue.findIndex((x) => x.kind !== "question");
      if (i < 0) this.queue.push(t);
      else this.queue.splice(i, 0, t);
    } else this.queue.push(t);
    this.pump();
  }

  private pump() {
    if (!this.turn) {
      const next = this.queue.shift();
      if (next) {
        this.turn = next;
        this.presentedThisTurn = 0;
        this.input.push({ type: "user", message: { role: "user", content: next.text }, parent_tool_use_id: null });
      }
    }
    this.updateStatus();
  }

  private schedulePrefetch() {
    if (this.phase !== "stepping") return;
    const inFlight = [this.turn, ...this.queue].some((t) => t?.kind === "prepare");
    if (inFlight) return;
    const k = this.nextToPrepare;
    if (k >= this.plan.length || k > this.currentStep + LOOKAHEAD) return;
    const s = this.plan[k];
    const scope = [
      s.hunk_ids.length ? `hunks: ${s.hunk_ids.join(", ")}` : "no code (overview/visual)",
      s.line_ranges.length ? `ranges: ${s.line_ranges.map((r) => `${r.hunk_id}:${r.start}-${r.end}`).join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("; ");
    this.enqueue({
      kind: "prepare",
      prepIndex: k,
      text: `Prepare step ${k + 1}/${this.plan.length} (index ${k}) — [${s.section}] "${s.title}" (${scope}). Call present_step once, then end your turn.`,
    });
  }

  private tryReveal() {
    if (this.phase !== "stepping" || !this.wantNext) return;
    const step = this.prepared.get(this.currentStep + 1);
    if (!step) return;
    this.prepared.delete(step.index);
    this.currentStep = step.index;
    this.wantNext = false;
    this.emitEvent({ type: "step", ...step });
    this.schedulePrefetch();
    this.updateStatus();
  }

  /* ---------- MCP tools ---------- */

  private buildMcp() {
    const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
    const err = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
    const { files } = this.opts.diff;
    const ctx = { files, repoRoot: this.opts.repoRoot };
    const prose = proseLimits(this.opts.language);

    return createSdkMcpServer({
      name: "xpl",
      version: "0.2.0",
      alwaysLoad: true,
      tools: [
        tool(
          "get_diff",
          "Return the annotated diff for the given files and/or hunks.",
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
          `Submit the ordered plan of small steps (each ≤ ~${LIMITS.stepCodeLines} lines of code). Call once.`,
          {
            overview: z.string().describe("2-3 sentence summary of the whole change"),
            steps: z
              .array(
                z.object({
                  section: z.string().describe("Short group name, e.g. 'データモデル'"),
                  title: z.string().describe("Short step title"),
                  hunk_ids: z.array(z.string()).describe("Hunks shown in this step ([] for overview/visual-only)"),
                  line_ranges: z
                    .array(z.object({ hunk_id: z.string(), start: z.number().int(), end: z.number().int() }))
                    .optional()
                    .describe("Sub-ranges (new-file lines) when only part of a hunk belongs to this step"),
                })
              )
              .min(1),
            skipped_hunks: z.array(z.string()).optional().describe("Trivial hunks intentionally not explained"),
          },
          async ({ overview, steps, skipped_hunks }) => {
            if (this.phase !== "planning") return err("Plan already accepted.");
            const covered = new Set([...steps.flatMap((s) => s.hunk_ids), ...(skipped_hunks ?? [])]);
            const missing = [...this.hunkIds].filter((h) => !covered.has(h));
            if (missing.length && !this.planRejected && missing.length > Math.max(3, this.hunkIds.size * 0.1)) {
              this.planRejected = true;
              return err(
                `Not covered by any step nor skipped_hunks: ${missing.join(", ")}. Call submit_plan again covering them (or skip if trivial).`
              );
            }
            const valid = (ids: string[]) => ids.filter((id) => this.hunkIds.has(id));
            this.plan = steps.map((s) => ({
              section: s.section,
              title: s.title,
              hunk_ids: valid(s.hunk_ids),
              line_ranges: (s.line_ranges ?? []).filter((r) => this.hunkIds.has(r.hunk_id)),
            }));
            this.emitEvent({ type: "plan", overview, steps: this.plan, skipped_hunks: skipped_hunks ?? [] });
            this.setPhase("stepping");
            return ok(`Plan accepted (${steps.length} steps). Now call present_step for index 0, then end your turn.`);
          }
        ),
        tool(
          "present_step",
          `Provide ONE step. Budget: ≤${LIMITS.stepCodeLines} code lines, ~${prose.soft} prose chars. Then end your turn.`,
          {
            index: z.number().int().describe("0-based step index"),
            title: z.string(),
            blocks: z.array(BlockSchema).min(1),
          },
          async (a) => {
            if (this.phase !== "stepping") return err("No step is being requested now.");
            const allowed = this.turn?.kind === "prepare" || this.turn?.kind === "plan";
            if (!allowed) return err("Do not present steps now; answer the question instead.");
            if (this.presentedThisTurn > 0) return err("Only one step per turn. End your turn now.");
            if (a.index !== this.nextToPrepare) return err(`Prepare step index ${this.nextToPrepare} (not ${a.index}).`);
            let blocks: Block[];
            try {
              blocks = resolveBlocks(a.blocks, ctx);
            } catch (e) {
              if (e instanceof BlockError) return err(e.message + " — fix and call present_step again.");
              throw e;
            }
            const m = measure(blocks);
            const tries = this.rejections.get(a.index) ?? 0;
            if (tries < 2 && (m.codeLines > LIMITS.stepCodeLinesHard || m.prose > prose.hard)) {
              this.rejections.set(a.index, tries + 1);
              return err(
                `Too big for one step: ${m.codeLines} code lines (max ${LIMITS.stepCodeLinesHard}), ~${m.prose} prose chars (max ${prose.hard}). ` +
                  `Show fewer lines (use start/end), move detail into line notes, cut prose. Call present_step again for index ${a.index}.`
              );
            }
            this.presentedThisTurn++;
            this.prepared.set(a.index, { index: a.index, title: a.title, blocks });
            this.nextToPrepare++;
            this.tryReveal();
            this.updateStatus();
            return ok("Saved. End your turn now.");
          }
        ),
        tool(
          "answer_question",
          "Answer a question from the human. One call per question. Keep it focused; same block types as steps.",
          {
            question_id: z.string(),
            blocks: z.array(BlockSchema).min(1),
          },
          async (a) => {
            const qn = this.questions.find((q) => q.id === a.question_id);
            if (!qn) return err(`Unknown question id ${a.question_id}`);
            let blocks: Block[];
            try {
              blocks = resolveBlocks(a.blocks, ctx);
            } catch (e) {
              if (e instanceof BlockError) return err(e.message + " — fix and call answer_question again.");
              throw e;
            }
            const m = measure(blocks);
            if (!qn.answered && (m.codeLines > LIMITS.answerCodeLinesHard || m.prose > prose.answerHard) && !this.rejections.has(-1 - this.questions.indexOf(qn))) {
              this.rejections.set(-1 - this.questions.indexOf(qn), 1);
              return err(`Answer too long (${m.codeLines} code lines, ~${m.prose} chars). Make it more concise and call again.`);
            }
            qn.answered = true;
            this.emitEvent({ type: "answer", questionId: qn.id, blocks });
            return ok("Answer displayed.");
          }
        ),
      ],
    });
  }

  /* ---------- lifecycle ---------- */

  async start() {
    const { diff, repoRoot } = this.opts;
    this.emitEvent({
      type: "meta",
      title: diff.title,
      description: diff.description,
      repo: repoRoot,
      fileCount: diff.files.length,
      additions: diff.files.reduce((a, f) => a + f.additions, 0),
      deletions: diff.files.reduce((a, f) => a + f.deletions, 0),
    });
    if (!diff.files.length) {
      this.emitEvent({ type: "error", message: "差分がありません。" });
      this.setPhase("finished");
      return;
    }

    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "xpl/0.2.0" };
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

    this.enqueue({ kind: "plan", text: initialPrompt(diff) });
    this.consume().catch((e) => {
      this.emitEvent({ type: "error", message: String(e?.message ?? e) });
      this.turn = null;
      this.updateStatus();
    });
  }

  private async consume() {
    for await (const msg of this.q!) {
      if (msg.type === "assistant") {
        for (const block of msg.message.content as any[]) {
          if (block.type !== "tool_use") continue;
          const input = block.input ?? {};
          const name: string = block.name;
          const text =
            name === "Read"
              ? `Read ${rel(input.file_path, this.opts.repoRoot)}`
              : name === "Grep"
                ? `Grep "${input.pattern}"`
                : name === "Glob"
                  ? `Glob ${input.pattern}`
                  : name === "mcp__xpl__get_diff"
                    ? `diff ${[...(input.file_ids ?? []), ...(input.hunk_ids ?? [])].join(", ")}`
                    : "";
          if (text) this.emitEvent({ type: "activity", text });
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
    const finished = this.turn;
    this.turn = null;
    if (finished?.kind === "prepare" && finished.prepIndex === this.nextToPrepare) {
      // The AI ended the turn without producing the step; schedulePrefetch retries (bounded).
      const n = (this.prepFailures.get(finished.prepIndex) ?? 0) + 1;
      this.prepFailures.set(finished.prepIndex, n);
      if (n >= 3) {
        this.emitEvent({ type: "error", message: `ステップ ${finished.prepIndex + 1} の生成に失敗しました。` });
        this.prepared.set(finished.prepIndex, {
          index: finished.prepIndex,
          title: this.plan[finished.prepIndex].title,
          blocks: [{ type: "callout", tone: "risk", markdown: "このステップは生成できませんでした。質問欄から内容を尋ねてください。" }],
        });
        this.nextToPrepare++;
        this.tryReveal();
      }
    }
    if (this.phase === "final_qa" && !this.queue.some((t) => t.kind === "final" || t.kind === "question")) {
      this.setPhase("finished");
    }
    this.schedulePrefetch();
    this.pump();
  }

  /** Human pressed OK. */
  next() {
    if (this.phase !== "stepping" || this.wantNext) return;
    if (this.currentStep + 1 < this.plan.length) {
      this.wantNext = true;
      this.tryReveal();
      this.schedulePrefetch();
      this.updateStatus();
      return;
    }
    const later = this.questions.filter((q) => q.mode === "later" && !q.answered);
    if (!later.length) {
      this.setPhase("finished");
      return;
    }
    this.setPhase("final_qa");
    const list = later.map((q) => `- [${q.id}] (asked at step ${q.afterStep + 1}) ${q.text}`).join("\n");
    this.enqueue({
      kind: "final",
      text: `All steps are done. Answer each of these deferred questions with answer_question (one call per question):\n${list}`,
    });
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
    if (mode === "later" && (this.phase === "planning" || this.phase === "stepping")) return;
    if (this.phase === "finished") this.setPhase("final_qa");
    const where =
      this.currentStep >= 0 ? ` while reading step ${this.currentStep + 1} "${this.plan[this.currentStep]?.title}"` : "";
    this.enqueue(
      {
        kind: "question",
        questionId: qn.id,
        text: `Question [${qn.id}] from the human${where}:\n${text}\n\nAnswer with answer_question (question_id "${qn.id}"), then end your turn. Do not present steps.`,
      },
      true
    );
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
