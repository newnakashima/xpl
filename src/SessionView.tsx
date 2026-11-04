import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Answer, FileDiff, Phase, PlanStep, Question, SessionEvent, Step } from "./types";
import { Markdown } from "./components/Markdown";
import { Visuals } from "./components/Visuals";
import { DiffView } from "./components/DiffView";

interface State {
  title: string;
  description?: string;
  repo: string;
  files: FileDiff[];
  overview: string;
  plan: PlanStep[];
  skipped: string[];
  steps: Step[];
  questions: Question[];
  answers: Record<string, Answer>;
  busy: boolean;
  busyLabel?: string;
  activity: string[];
  phase: Phase;
  errors: string[];
}

const init: State = {
  title: "",
  repo: "",
  files: [],
  overview: "",
  plan: [],
  skipped: [],
  steps: [],
  questions: [],
  answers: {},
  busy: false,
  activity: [],
  phase: "planning",
  errors: [],
};

function reducer(s: State, e: SessionEvent | { type: "reset" }): State {
  switch (e.type) {
    case "reset":
      return init;
    case "meta":
      return { ...s, title: e.title, description: e.description, files: e.files, repo: e.repo };
    case "busy":
      return { ...s, busy: e.busy, busyLabel: e.label, activity: e.busy ? [] : s.activity };
    case "activity":
      return { ...s, activity: [...s.activity.slice(-4), e.text] };
    case "plan":
      return { ...s, overview: e.overview, plan: e.steps, skipped: e.skipped_hunks };
    case "step": {
      const { type, ...step } = e;
      return { ...s, steps: [...s.steps.filter((x) => x.index !== step.index), step].sort((a, b) => a.index - b.index) };
    }
    case "question":
      return { ...s, questions: [...s.questions, e.question] };
    case "answer": {
      const { type, ...a } = e;
      return { ...s, answers: { ...s.answers, [a.questionId]: a } };
    }
    case "phase":
      return { ...s, phase: e.phase };
    case "error":
      return { ...s, errors: [...s.errors, e.message] };
  }
}

export function SessionView({ id, onExit }: { id: string; onExit: () => void }) {
  const [s, dispatch] = useReducer(reducer, init);
  const [view, setView] = useState<number | "qa">(0);
  const [follow, setFollow] = useState(true);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"now" | "later">("now");
  const mainRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    dispatch({ type: "reset" });
    const es = new EventSource(`/api/sessions/${id}/events`);
    es.onmessage = (m) => dispatch(JSON.parse(m.data));
    return () => es.close();
  }, [id]);

  // Follow the newest step / QA
  const lastStep = s.steps.length ? s.steps[s.steps.length - 1].index : 0;
  useEffect(() => {
    if (follow) setView(lastStep);
  }, [lastStep, follow]);
  useEffect(() => {
    if (s.phase === "final_qa" || s.phase === "finished") {
      if (s.questions.some((q) => q.mode === "later")) setView("qa");
    }
  }, [s.phase]);
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [view]);

  const step = typeof view === "number" ? s.steps.find((x) => x.index === view) : undefined;
  const total = s.plan.length;
  const isLast = s.steps.length > 0 && lastStep === total - 1;
  const laterPending = s.questions.filter((q) => q.mode === "later" && !q.answered);
  const nextQueued = useRef(false);
  useEffect(() => {
    nextQueued.current = false;
  }, [lastStep, s.phase]);

  async function next() {
    if (view !== lastStep && typeof view === "number" && view < lastStep) {
      setView(view + 1);
      return;
    }
    if (nextQueued.current || s.phase !== "stepping") return;
    nextQueued.current = true;
    setFollow(true);
    await fetch(`/api/sessions/${id}/next`, { method: "POST" });
  }

  async function ask() {
    const t = text.trim();
    if (!t) return;
    setText("");
    await fetch(`/api/sessions/${id}/questions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: t, mode }),
    });
  }

  // Keyboard: Enter / → for OK, ← for back
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
      if (e.key === "ArrowRight" || e.key === "Enter") {
        e.preventDefault();
        next();
      } else if (e.key === "ArrowLeft" && typeof view === "number" && view > 0) {
        setFollow(false);
        setView(view - 1);
      } else if (e.key === "/" || e.key === "?") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const stepQuestions = (idx: number) => s.questions.filter((q) => q.afterStep === idx && q.mode === "now");
  const shown = new Set(s.steps.map((x) => x.index));

  const okLabel = useMemo(() => {
    if (typeof view === "number" && view < lastStep) return "次のステップへ →";
    if (s.phase === "planning") return "準備中…";
    if (s.phase === "final_qa") return "質問に回答中…";
    if (s.phase === "finished") return "完了";
    if (isLast) return laterPending.length ? `OK、まとめて質問 (${laterPending.length}) →` : "OK、完了 ✓";
    return "OK、次へ →";
  }, [view, lastStep, s.phase, isLast, laterPending.length]);
  const okDisabled =
    !(typeof view === "number" && view < lastStep) && (s.phase !== "stepping" || s.busy || s.steps.length === 0);

  return (
    <div className="session">
      <header className="topbar">
        <button className="btn ghost" onClick={onExit}>
          ← 戻る
        </button>
        <div className="topbar-title">
          <span className="logo">xpl</span> {s.title}
        </div>
        <div className="topbar-stat muted">
          {s.files.length} files ·{" "}
          <span className="plus">+{s.files.reduce((a, f) => a + f.additions, 0)}</span>{" "}
          <span className="minus">-{s.files.reduce((a, f) => a + f.deletions, 0)}</span>
        </div>
      </header>

      <div className="layout">
        <aside className="sidebar">
          {s.overview && (
            <section>
              <h3>概要</h3>
              <Markdown className="small" text={s.overview} />
            </section>
          )}
          <section>
            <h3>ステップ {total ? `(${s.steps.length}/${total})` : ""}</h3>
            {!total && <div className="muted small">プラン作成中…</div>}
            <ol className="steps">
              {s.plan.map((p, i) => (
                <li
                  key={i}
                  className={`${shown.has(i) ? "done" : ""} ${view === i ? "current" : ""}`}
                  onClick={() => {
                    if (!shown.has(i)) return;
                    setFollow(i === lastStep);
                    setView(i);
                  }}
                  title={p.summary}
                >
                  <span className="num">{i + 1}</span>
                  <span className="t">{p.title}</span>
                  {stepQuestions(i).length > 0 && <span className="qbadge">Q{stepQuestions(i).length}</span>}
                </li>
              ))}
            </ol>
          </section>
          {s.questions.some((q) => q.mode === "later") && (
            <section>
              <h3 className="clickable" onClick={() => setView("qa")}>
                あとで聞く質問 ({s.questions.filter((q) => q.mode === "later").length})
              </h3>
              <ul className="later-list">
                {s.questions
                  .filter((q) => q.mode === "later")
                  .map((q) => (
                    <li key={q.id} className={q.answered ? "answered" : ""}>
                      <span className="muted">S{q.afterStep + 1}</span> {q.text}
                    </li>
                  ))}
              </ul>
            </section>
          )}
        </aside>

        <main className="main" ref={mainRef}>
          {s.errors.map((e, i) => (
            <div key={i} className="error">
              {e}
            </div>
          ))}
          {view === "qa" ? (
            <div className="qa-summary">
              <h2>まとめて質問への回答</h2>
              {s.questions
                .filter((q) => q.mode === "later" || q.afterStep >= total)
                .map((q) => (
                  <QA key={q.id} q={q} a={s.answers[q.id]} files={s.files} />
                ))}
              {s.phase === "finished" && <div className="finished">🎉 すべての解説が完了しました</div>}
            </div>
          ) : step ? (
            <article className="step" key={step.index}>
              <div className="step-head">
                <div className="step-num">
                  STEP {step.index + 1} / {total}
                </div>
                <h2>{step.title}</h2>
              </div>
              <div className={"step-body " + (step.hunk_ids.length ? "split" : "")}>
                <div className="explain">
                  <Markdown text={step.markdown} />
                  <Visuals visuals={step.visuals} />
                  {stepQuestions(step.index).map((q) => (
                    <QA key={q.id} q={q} a={s.answers[q.id]} files={s.files} />
                  ))}
                </div>
                {step.hunk_ids.length > 0 && (
                  <div className="code-pane">
                    <DiffView files={s.files} hunkIds={step.hunk_ids} ranges={step.line_ranges} />
                  </div>
                )}
              </div>
              {s.phase === "finished" && step.index === total - 1 && <div className="finished">🎉 すべての解説が完了しました</div>}
            </article>
          ) : (
            <div className="placeholder">
              <div className="spinner" />
              <div>{s.busyLabel ?? "準備中…"}</div>
              {s.description && <pre className="desc">{s.description.slice(0, 1200)}</pre>}
            </div>
          )}
        </main>
      </div>

      <footer className="actionbar">
        <div className="status">
          {s.busy ? (
            <>
              <span className="dot busy" /> {s.busyLabel}
              {s.activity.length > 0 && <span className="muted"> · {s.activity[s.activity.length - 1]}</span>}
            </>
          ) : (
            <>
              <span className="dot" /> {s.phase === "finished" ? "完了" : "待機中"}
              <span className="muted"> · Enter/→ で次へ、/ で質問</span>
            </>
          )}
        </div>
        <div className="ask">
          <textarea
            ref={inputRef}
            value={text}
            placeholder="質問があればここに（⌘/Ctrl+Enter で送信）"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                ask();
              } else if (e.key === "Escape") inputRef.current?.blur();
            }}
          />
          <div className="ask-controls">
            <div className="seg">
              <button className={mode === "now" ? "on" : ""} onClick={() => setMode("now")}>
                すぐに聞く
              </button>
              <button className={mode === "later" ? "on" : ""} onClick={() => setMode("later")}>
                あとでまとめて
              </button>
            </div>
            <button className="btn" disabled={!text.trim()} onClick={ask}>
              送信
            </button>
          </div>
        </div>
        <button className="btn primary ok" disabled={okDisabled} onClick={next}>
          {okLabel}
        </button>
      </footer>
    </div>
  );
}

function QA({ q, a, files }: { q: Question; a?: Answer; files: FileDiff[] }) {
  return (
    <div className="qa">
      <div className="q">
        <span className="qid">{q.id}</span> {q.text}
      </div>
      {a ? (
        <div className="a">
          <Markdown text={a.markdown} />
          <Visuals visuals={a.visuals} />
          {a.hunk_ids.length > 0 && <DiffView files={files} hunkIds={a.hunk_ids} />}
        </div>
      ) : (
        <div className="a muted">{q.mode === "later" ? "最後にまとめて回答します" : "回答を待っています…"}</div>
      )}
    </div>
  );
}
