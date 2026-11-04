export interface Row {
  kind: "add" | "del" | "ctx";
  oldN?: number;
  newN?: number;
  text: string;
}

export interface CodeBlock {
  type: "code";
  file: string;
  lang: string;
  view: "new" | "diff" | "split" | "old" | "context";
  rows: Row[];
  highlight: number[];
  notes: { line: number; text: string }[];
  caption?: string;
  fileStatus?: string;
}

export type Block =
  | { type: "text"; markdown: string }
  | { type: "callout"; tone: "info" | "tip" | "risk"; markdown: string }
  | CodeBlock
  | { type: "mermaid"; code: string; title?: string }
  | { type: "html"; code: string; title?: string };

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
export interface Answer {
  questionId: string;
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
