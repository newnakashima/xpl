export interface Hunk {
  id: string;
  header: string;
  oldStart: number;
  newStart: number;
  lines: string[];
}

export interface FileDiff {
  id: string;
  oldPath: string;
  newPath: string;
  status: "added" | "deleted" | "modified" | "renamed" | "binary";
  additions: number;
  deletions: number;
  hunks: Hunk[];
}

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
export interface Step {
  index: number;
  title: string;
  markdown: string;
  visuals: Visual[];
  hunk_ids: string[];
  line_ranges: LineRange[];
}
export interface Answer {
  questionId: string;
  markdown: string;
  visuals: Visual[];
  hunk_ids: string[];
}
export type Phase = "planning" | "stepping" | "final_qa" | "finished";

export type SessionEvent =
  | { type: "meta"; title: string; description?: string; files: FileDiff[]; repo: string }
  | { type: "busy"; busy: boolean; label?: string }
  | { type: "activity"; text: string }
  | { type: "plan"; overview: string; steps: PlanStep[]; skipped_hunks: string[] }
  | ({ type: "step" } & Step)
  | { type: "question"; question: Question }
  | ({ type: "answer" } & Answer)
  | { type: "phase"; phase: Phase }
  | { type: "error"; message: string };

export type DiffSource =
  | { kind: "working" }
  | { kind: "branch"; base: string; head?: string }
  | { kind: "commit"; sha: string }
  | { kind: "pr"; number: number };

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
