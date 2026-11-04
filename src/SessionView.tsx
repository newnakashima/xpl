import { useEffect, useReducer, useRef, useState } from "react";
import type { Answer, Phase, PlanStep, Question, SessionEvent, Step } from "./types";
import { Markdown } from "./components/Markdown";
import { Blocks } from "./components/Blocks";

interface State {
  title: string;
  description?: string;
  fileCount: number;
  additions: number;
  deletions: number;
  overview: string;
  plan: PlanStep[];
  steps: Step[];
  questions: Question[];
  answers: Record<string, Answer>;
  waiting: boolean;
  label?: string;
  aiWorking: boolean;
  prepared: number;
  activity?: string;
  phase: Phase;
  errors: string[];
}

const init: State = {
  title: "",
  fileCount: 0,
  additions: 0,
  deletions: 0,
  overview: "",
  plan: [],
  steps: [],
  questions: [],
  answers: {},
  waiting: true,
  aiWorking: true,
  prepared: 0,
  phase: "planning",
  errors: [],
};

function reducer(s: State, e: SessionEvent | { type: "reset" }): State {
  switch (e.type) {
    case "reset":
      return init;
    case "meta":
      return { ...s, title: e.title, description: e.description, fileCount: e.fileCount, additions: e.additions, deletions: e.deletions };
    case "status":
      return { ...s, waiting: e.waiting, label: e.label, aiWorking: e.aiWorking, prepared: e.prepared };
    case "activity":
      return { ...s, activity: e.text };
    case "plan":
      return { ...s, overview: e.overview, plan: e.steps };
    case "step": {
      const { type, ...step } = e;
      return { ...s, steps: [...s.steps.filter((x) => x.index !== step.index), step].sort((a, b) => a.index - b.index) };
    }
    case "question":
      return { ...s, questions: [...s.questions, e.question] };
    case "answer": {
      const { type, ...a } = e;
      return {
        ...s,
        answers: { ...s.answers, [a.questionId]: a },
        questions: s.questions.map((q) => (q.id === a.questionId ? { ...q, answered: true } : q)),
      };
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
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"now" | "later">("now");
  const [requested, setRequested] = useState(false);
  const mainRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    dispatch({ type: "reset" });
    const es = new EventSource(`/api/sessions/${id}/events`);
    es.onmessage = (m) => dispatch(JSON.parse(m.data));
    return () => es.close();
  }, [id]);

  const lastStep = s.steps.length ? s.steps[s.steps.length - 1].index : -1;
  const total = s.plan.length;

  // A newly revealed step always becomes the view (it only arrives after OK).
  useEffect(() => {
    if (lastStep >= 0) setView(lastStep);
    setRequested(false);
  }, [lastStep]);
  useEffect(() => {
    if ((s.phase === "final_qa" || s.phase === "finished") && s.questions.some((q) => q.mode === "later")) setView("qa");
  }, [s.phase]);
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [view]);

  const step = typeof view === "number" ? s.steps.find((x) => x.index === view) : undefined;
  const reviewing = typeof view === "number" && view < lastStep;
  const isLast = lastStep >= 0 && lastStep === total - 1;
  const laterPending = s.questions.filter((q) => q.mode === "later" && !q.answered);

  async function next() {
    if (reviewing) return setView((view as number) + 1);
    if (view === "qa" || requested || s.phase !== "stepping" || lastStep < 0) return;
    setRequested(true);
    await fetch(`/api/sessions/${id}/next`, { method: "POST" });
    if (isLast) setRequested(false);
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
      if (e.key === "ArrowRight" || e.key === "Enter") {
        e.preventDefault();
        next();
      } else if (e.key === "ArrowLeft") {
        if (view === "qa") setView(lastStep);
        else if (typeof view === "number" && view > 0) setView(view - 1);
      } else if (e.key === "/" || e.key === "?") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const stepQuestions = (idx: number) => s.questions.filter((q) => q.afterStep === idx && q.mode === "now");

  let okLabel = "OK、次へ →";
  if (reviewing) okLabel = "次のステップへ →";
  else if (s.phase === "planning" || lastStep < 0) okLabel = "準備中…";
  else if (s.phase === "final_qa") okLabel = "質問に回答中…";
  else if (s.phase === "finished") okLabel = "完了";
  else if (requested) okLabel = "準備中…";
  else if (isLast) okLabel = laterPending.length ? `OK、まとめて質問 (${laterPending.length}) →` : "OK、完了 ✓";
  const okDisabled = !reviewing && (s.phase !== "stepping" || lastStep < 0 || requested || view === "qa");

  // group plan by section
  const sections: { name: string; items: { p: PlanStep; i: number }[] }[] = [];
  s.plan.forEach((p, i) => {
    const last = sections[sections.length - 1];
    if (last && last.name === p.section) last.items.push({ p, i });
    else sections.push({ name: p.section, items: [{ p, i }] });
  });

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
          {s.fileCount} files · <span className="plus">+{s.additions}</span> <span className="minus">-{s.deletions}</span>
        </div>
      </header>

      {total > 0 && (
        <div className="progress">
          <div className="progress-bar" style={{ width: `${((lastStep + 1) / total) * 100}%` }} />
        </div>
      )}

      <div className="layout">
        <aside className="sidebar">
          {s.overview && (
            <section>
              <h3>概要</h3>
              <Markdown className="small" text={s.overview} />
            </section>
          )}
          <section>
            <h3>ステップ {total ? `${lastStep + 1} / ${total}` : ""}</h3>
            {!total && <div className="muted small">プラン作成中…</div>}
            {sections.map((sec, si) => (
              <div key={si} className="section">
                <div className="section-name">{sec.name}</div>
                <ol className="steps">
                  {sec.items.map(({ p, i }) => {
                    const shown = i <= lastStep;
                    return (
                      <li
                        key={i}
                        className={`${shown ? "done" : ""} ${view === i ? "current" : ""}`}
                        onClick={() => shown && setView(i)}
                      >
                        <span className="num">{i + 1}</span>
                        <span className="t">{p.title}</span>
                        {stepQuestions(i).length > 0 && <span className="qbadge">Q{stepQuestions(i).length}</span>}
                      </li>
                    );
                  })}
                </ol>
              </div>
            ))}
          </section>
          {s.questions.some((q) => q.mode === "later") && (
            <section>
              <h3 className="clickable" onClick={() => (s.phase === "final_qa" || s.phase === "finished") && setView("qa")}>
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
          <div className="column">
            {s.errors.map((e, i) => (
              <div key={i} className="error">
                {e}
              </div>
            ))}
            {view === "qa" ? (
              <div className="qa-summary">
                <h2>まとめて質問への回答</h2>
                {s.questions
                  .filter((q) => q.mode === "later")
                  .map((q) => (
                    <QA key={q.id} q={q} a={s.answers[q.id]} />
                  ))}
                {s.phase === "finished" && <div className="finished">すべての解説が完了しました</div>}
              </div>
            ) : step ? (
              <article className="step" key={step.index}>
                <div className="step-num">
                  {s.plan[step.index]?.section} · {step.index + 1} / {total}
                </div>
                <h2>{step.title}</h2>
                <Blocks blocks={step.blocks} />
                {stepQuestions(step.index).map((q) => (
                  <QA key={q.id} q={q} a={s.answers[q.id]} />
                ))}
                {s.phase === "finished" && step.index === total - 1 && <div className="finished">すべての解説が完了しました</div>}
              </article>
            ) : (
              <div className="placeholder">
                <div className="spinner" />
                <div>{s.label ?? "準備中…"}</div>
                {s.activity && <div className="muted small">{s.activity}</div>}
              </div>
            )}
          </div>
        </main>
      </div>

      <footer className="actionbar">
        <div className="status">
          {s.waiting ? (
            <>
              <span className="dot busy" /> {s.label}
              {s.activity && <span className="muted"> · {s.activity}</span>}
            </>
          ) : (
            <>
              <span className="dot" /> {s.phase === "finished" ? "完了" : "待機中"}
              {s.aiWorking && s.phase === "stepping" && <span className="muted"> · 次のステップを先読み中</span>}
              {!s.aiWorking && s.prepared > 0 && <span className="muted"> · {s.prepared} ステップ準備済み</span>}
              <span className="muted"> · Enter/→ 次へ　← 戻る　/ 質問</span>
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

function QA({ q, a }: { q: Question; a?: Answer }) {
  return (
    <div className="qa">
      <div className="q">
        <span className="qid">{q.id}</span> {q.text}
      </div>
      {a ? (
        <div className="a">
          <Blocks blocks={a.blocks} />
        </div>
      ) : (
        <div className="a muted">{q.mode === "later" ? "最後にまとめて回答します" : "回答を待っています…"}</div>
      )}
    </div>
  );
}
