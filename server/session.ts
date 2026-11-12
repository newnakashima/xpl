import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { z } from "zod";
import { annotatedDiff, type DiffResult } from "./git.js";
import { initialPrompt, systemPrompt, LIMITS, proseLimits } from "./prompt.js";
import { BlockSchema, BlockError, measure, resolveBlocks, type Block } from "./blocks.js";
import { CodexAgent, CodexTurnError } from "./codex.js";
import { tool } from "./tools.js";
import { fullFileRows, type Row } from "./file-rows.js";

export function resolveModel(model?: string): string | undefined {
  return model?.trim() || process.env.XPL_CODEX_MODEL || undefined;
}

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

export type Phase = "planning" | "stepping" | "final_qa" | "finished" | "failed";

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
  attempts?: number;
}

/** How many steps to prepare ahead of the one being read. */
const LOOKAHEAD = Math.max(0, Number(process.env.XPL_LOOKAHEAD ?? 2));

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

  /** Index of the latest revealed step (-1 = none yet); the UI may be reviewing an earlier one. */
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
  private codex?: CodexAgent;
  private closed = false;
  get isClosed() { return this.closed; }
  private hunkIds: Set<string>;
  private planRejected = false;
  private fullFiles = new Map<string, () => Promise<Row[]>>();
  private fullFileCache = new Map<string, Promise<Row[]>>();

  constructor(private opts: SessionOptions) {
    super();
    this.setMaxListeners(100);
    this.hunkIds = new Set(opts.diff.files.flatMap((f) => f.hunks.map((h) => h.id)));
    const readFile = opts.diff.readFile;
    if (readFile) for (const file of opts.diff.files) {
      if (file.status === "binary") continue;
      this.fullFiles.set(file.id, async () => fullFileRows(file,
        file.status === "added" || file.status === "deleted" ? "" : await readFile(file)));
    }
  }

  getFileRows(fileId: string): Promise<Row[]> | undefined {
    const load = this.fullFiles.get(fileId);
    if (!load) return undefined;
    let result = this.fullFileCache.get(fileId);
    if (!result) {
      result = load().catch((error) => {
        this.fullFileCache.delete(fileId);
        throw error;
      });
      this.fullFileCache.set(fileId, result);
    }
    return result;
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
    if (this.closed) return;
    if (!this.turn && this.codex) {
      const next = this.queue.shift();
      if (next) {
        this.turn = next;
        this.presentedThisTurn = 0;
        void this.codex.run(next.text).then(() => {
          if (!this.closed) this.onTurnEnd();
        }).catch((error) => {
          if (error instanceof CodexTurnError) this.onTurnEnd(error.message);
          else this.fail(error);
        });
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

  /* ---------- explanation tools ---------- */

  private buildTools() {
    const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
    const err = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
    const { files } = this.opts.diff;
    const ctx = { files, repoRoot: this.opts.repoRoot, fullFiles: this.fullFiles };
    const prose = proseLimits(this.opts.language);

    return [
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
            overview: z.string().describe("2-3 sentences on the problem being solved and why this approach addresses it; label inferred rationale"),
            steps: z
              .array(
                z.object({
                  section: z.string().describe("Short group name, e.g. 'データモデル'"),
                  title: z.string().describe("Short step title emphasizing the purpose or rationale"),
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
      ];
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

    this.codex = new CodexAgent({
      cwd: repoRoot,
      model: resolveModel(this.opts.model),
      instructions: systemPrompt(this.opts.language),
      tools: this.buildTools(),
      onActivity: (text) => this.emitEvent({ type: "activity", text }),
      onError: (error) => this.fail(error),
    });
    await this.codex.start();
    this.enqueue({ kind: "plan", text: initialPrompt(diff) });
  }

  private fail(error: unknown) {
    if (this.closed) return;
    this.emitEvent({ type: "error", message: String(error instanceof Error ? error.message : error) });
    this.close();
    this.turn = null;
    this.queue = [];
    this.setPhase("failed");
  }

  private onTurnEnd(error?: string) {
    if (this.closed) return;
    const finished = this.turn;
    this.turn = null;
    if (error) this.emitEvent({ type: "error", message: `AI turn failed: ${error}` });
    const missingPlan = finished?.kind === "plan" && this.phase === "planning";
    const missingAnswer = finished?.kind === "question"
      ? this.questions.some((q) => q.id === finished.questionId && !q.answered)
      : finished?.kind === "final" && this.questions.some((q) => q.mode === "later" && !q.answered);
    if (finished && (missingPlan || missingAnswer)) {
      const attempts = (finished.attempts ?? 0) + 1;
      if (attempts >= 3) {
        this.fail(new Error(missingPlan ? "解説プランを作成できませんでした。" : "質問への回答を生成できませんでした。"));
      } else {
        this.enqueue({ ...finished, attempts }, true);
      }
      return;
    }
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
    if (this.closed) return;
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

  ask(text: string, mode: "now" | "later", afterStep?: number) {
    if (this.closed) return false;
    if (afterStep !== undefined && (!Number.isInteger(afterStep) || afterStep < 0 || afterStep > this.currentStep)) {
      throw new RangeError("質問するステップは表示済みのステップを指定してください。");
    }
    const qn: Question = {
      id: `Q${this.questions.length + 1}`,
      text,
      mode,
      afterStep: afterStep ?? Math.max(0, this.currentStep),
      answered: false,
    };
    this.questions.push(qn);
    this.emitEvent({ type: "question", question: qn });
    if (mode === "later" && (this.phase === "planning" || this.phase === "stepping")) return true;
    if (this.phase === "finished") this.setPhase("final_qa");
    const where =
      this.currentStep >= 0 ? ` while reading step ${qn.afterStep + 1} "${this.plan[qn.afterStep]?.title}"` : "";
    this.enqueue(
      {
        kind: "question",
        questionId: qn.id,
        text: `Question [${qn.id}] from the human${where}:\n${text}\n\nAnswer with answer_question (question_id "${qn.id}"), then end your turn. Do not present steps.`,
      },
      true
    );
    return true;
  }

  close() {
    this.closed = true;
    this.codex?.close();
  }
}
