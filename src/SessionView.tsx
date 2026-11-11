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
      return { ...s, phase: e.phase, ...(e.phase === "failed" ? { waiting: false, aiWorking: false } : {}) };
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
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        dispatch({ type: "error", message: "セッションに接続できません。差分を選び直してください。" });
        dispatch({ type: "phase", phase: "failed" });
      }
    };
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
    if (!t || s.phase === "failed") return;
    try {
      const response = await fetch(`/api/sessions/${id}/questions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: t, mode, afterStep: step?.index }),
      });
      if (!response.ok) throw new Error((await response.json()).error);
      // Keep anything typed while the request was in flight.
      setText((current) => (current.trim() === t ? "" : current));
    } catch (error) {
      dispatch({ type: "error", message: String(error instanceof Error ? error.message : error) });
    }
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

  let okLabel = "OK、次へ";
  if (reviewing) okLabel = "次のステップへ";
  else if (s.phase === "failed") okLabel = "解説は中断されました";
  else if (s.phase === "planning" || lastStep < 0) okLabel = "解説を準備しています";
  else if (s.phase === "final_qa") okLabel = "質問に回答しています";
  else if (s.phase === "finished") okLabel = "解説は終わりました";
  else if (requested) okLabel = "次のステップを準備しています";
  else if (isLast) okLabel = laterPending.length ? `OK、まとめた質問 ${laterPending.length} 件へ` : "OK、解説を終える";
  const okDisabled = !reviewing && (s.phase !== "stepping" || lastStep < 0 || requested || view === "qa");

  // group plan by section
  const sections: { name: string; items: { p: PlanStep; i: number }[] }[] = [];
  s.plan.forEach((p, i) => {
    const last = sections[sections.length - 1];
    if (last && last.name === p.section) last.items.push({ p, i });
    else sections.push({ name: p.section, items: [{ p, i }] });
  });

  const laterQs = s.questions.filter((q) => q.mode === "later");
  const canOpenQa = s.phase === "final_qa" || s.phase === "finished";
  const finished = (
    <div className="finished">
      <p>すべてのステップを読み終えました。</p>
      <button className="btn" onClick={onExit}>
        別の差分を読む
      </button>
    </div>
  );

  return (
    <div className="session">
      <header className="topbar">
        <button className="btn ghost" onClick={onExit} title="差分の選択画面に戻る">
          差分を選び直す
        </button>
        <div className="topbar-title">
          <span className="logo">xpl</span>
          <span className="t" title={s.title}>
            {s.title}
          </span>
        </div>
        {s.fileCount > 0 && (
          <div className="topbar-stat">
            <span>{s.fileCount} ファイル</span>
            <span className="plus">+{s.additions}</span>
            <span className="minus">−{s.deletions}</span>
          </div>
        )}
      </header>

      <div className="layout">
        <aside className="sidebar">
          {s.overview && (
            <section>
              <h3>この変更について</h3>
              <Markdown className="small overview" text={s.overview} />
            </section>
          )}
          <section>
            <h3>
              <span>解説の順番</span>
              {total > 0 && (
                <span className="count">
                  {lastStep + 1} / {total}
                </span>
              )}
            </h3>
            {!total && <div className="muted small">変更を読んで、解説の順番を考えています…</div>}
            <div className="route">
              {sections.map((sec, si) => (
                <div key={si} className="section">
                  {sec.name && (
                    <div className={"section-name " + (sec.items[0].i <= lastStep ? "reached" : "")}>{sec.name}</div>
                  )}
                  <ol className="steps">
                    {sec.items.map(({ p, i }) => {
                      const shown = i <= lastStep;
                      const nq = stepQuestions(i).length;
                      return (
                        <li
                          key={i}
                          className={[shown ? "reached" : "", i + 1 <= lastStep ? "next-reached" : "", view === i ? "current" : ""].join(" ")}
                        >
                          <button className="step-link" disabled={!shown} onClick={() => setView(i)} aria-current={view === i ? "step" : undefined}>
                            <span className="num">{i + 1}</span>
                            <span className="t">{p.title}</span>
                            {nq > 0 && (
                              <span className="qbadge" title={`このステップでの質問 ${nq} 件`}>
                                Q{nq}
                              </span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                </div>
              ))}
            </div>
          </section>
          {laterQs.length > 0 && (
            <section>
              <h3>
                <span>最後にまとめて聞く質問</span>
                <span className="count">{laterQs.length}</span>
              </h3>
              <ul className="later-list">
                {laterQs.map((q) => (
                  <li key={q.id} className={q.answered ? "answered" : ""}>
                    <span className="from">ステップ{q.afterStep + 1}</span>
                    <span className="txt">{q.text}</span>
                  </li>
                ))}
              </ul>
              {canOpenQa && (
                <p>
                  <button className="link-btn" onClick={() => setView("qa")}>
                    回答を読む
                  </button>
                </p>
              )}
            </section>
          )}
        </aside>

        <main className="main" ref={mainRef}>
          <div className="column">
            {s.errors.map((e, i) => (
              <div key={i} className="error" role="alert">
                {e}
              </div>
            ))}
            {s.phase === "failed" && (
              <div className="finished">
                <p>解説を中断しました。差分を選び直して再開してください。</p>
                <button className="btn" onClick={onExit}>差分を選び直す</button>
              </div>
            )}
            {view === "qa" ? (
              <div className="qa-summary">
                <div className="step-kicker">
                  <span className="sec">まとめて聞いた質問</span>
                  <span className="pos">{laterQs.length} 件</span>
                </div>
                <h2>質問への回答</h2>
                {laterQs.map((q) => (
                  <QA key={q.id} q={q} a={s.answers[q.id]} failed={s.phase === "failed"} />
                ))}
                {s.phase === "finished" && finished}
              </div>
            ) : step ? (
              <article className="step" key={step.index}>
                <div className="step-kicker">
                  {s.plan[step.index]?.section && <span className="sec">{s.plan[step.index].section}</span>}
                  <span className="pos">
                    ステップ {step.index + 1} / {total}
                  </span>
                </div>
                <h2>{step.title}</h2>
                <Blocks blocks={step.blocks} />
                {stepQuestions(step.index).map((q) => (
                  <QA key={q.id} q={q} a={s.answers[q.id]} failed={s.phase === "failed"} />
                ))}
                {s.phase === "finished" && step.index === total - 1 && !laterQs.length && finished}
              </article>
            ) : s.phase !== "failed" ? (
              <div className="placeholder" aria-live="polite">
                <div className="loader" />
                <div className="label">{s.label ?? "解説を準備しています"}</div>
                {s.activity && <div className="small">{s.activity}</div>}
                {s.description && <div className="desc">{s.description}</div>}
              </div>
            ) : null}
          </div>
        </main>
      </div>

      <footer className="actionbar">
        <div className="status" aria-live="polite">
          {s.waiting ? (
            <>
              <span className="now">
                <span className="dot busy" /> {s.label ?? "処理しています"}
              </span>
              {s.activity && <span>{s.activity}</span>}
            </>
          ) : (
            <>
              <span className="now">
                <span className="dot" /> {s.phase === "failed" ? "中断" : s.phase === "finished" ? "完了" : "あなたの番です"}
              </span>
              {s.aiWorking && s.phase === "stepping" && <span>次のステップを先に用意しています</span>}
              {!s.aiWorking && s.prepared > 0 && <span>{s.prepared} ステップ用意済み</span>}
            </>
          )}
          <span className="keys">
            <span>
              <kbd>Enter</kbd> 次へ
            </span>
            <span>
              <kbd>←</kbd> 前へ
            </span>
            <span>
              <kbd>/</kbd> 質問
            </span>
          </span>
        </div>
        <div className="ask">
          <textarea
            disabled={s.phase === "failed"}
            ref={inputRef}
            value={text}
            aria-label="質問"
            placeholder={mode === "now" ? "わからないところを質問する（⌘Enter で送信）" : "最後にまとめて聞きたいことを書いておく（⌘Enter で送信）"}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                ask();
              } else if (e.key === "Escape") inputRef.current?.blur();
            }}
          />
          <div className="ask-controls">
            <div className="seg" role="group" aria-label="質問するタイミング">
              <button className={mode === "now" ? "on" : ""} aria-pressed={mode === "now"} onClick={() => setMode("now")}>
                今すぐ聞く
              </button>
              <button className={mode === "later" ? "on" : ""} aria-pressed={mode === "later"} onClick={() => setMode("later")}>
                最後にまとめて
              </button>
            </div>
            <button className="btn" disabled={!text.trim() || s.phase === "failed"} onClick={ask}>
              {mode === "now" ? "質問する" : "書き留める"}
            </button>
          </div>
        </div>
        <button className="btn primary ok" disabled={okDisabled} onClick={next}>
          <span>{okLabel}</span>
          <kbd>Enter</kbd>
        </button>
      </footer>
    </div>
  );
}

function QA({ q, a, failed }: { q: Question; a?: Answer; failed?: boolean }) {
  return (
    <div className="qa">
      <div className="q">
        <span className="qid">{q.id}</span>
        <span>{q.text}</span>
      </div>
      {a ? (
        <div className="a">
          <Blocks blocks={a.blocks} />
        </div>
      ) : (
        <div className="a pending">{failed ? "中断したため回答できませんでした" : q.mode === "later" ? "すべてのステップのあとに回答します" : "回答を書いています…"}</div>
      )}
    </div>
  );
}
