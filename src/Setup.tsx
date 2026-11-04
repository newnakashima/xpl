import { useEffect, useState } from "react";
import type { DiffSource, RepoInfo } from "./types";

type Kind = DiffSource["kind"];

export function Setup({ onStart }: { onStart: (id: string) => void }) {
  const [repoPath, setRepoPath] = useState("");
  const [info, setInfo] = useState<RepoInfo | null>(null);
  const [infoError, setInfoError] = useState("");
  const [kind, setKind] = useState<Kind>("working");
  const [base, setBase] = useState("");
  const [head, setHead] = useState("");
  const [sha, setSha] = useState("");
  const [pr, setPr] = useState("");
  const [language, setLanguage] = useState("日本語");
  const [model, setModel] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((c) => {
        setRepoPath(c.defaultRepo);
        load(c.defaultRepo);
      });
  }, []);

  async function load(p: string) {
    setInfo(null);
    setInfoError("");
    const r = await fetch("/api/repo?path=" + encodeURIComponent(p));
    const j = await r.json();
    if (!r.ok) return setInfoError(j.error);
    setInfo(j);
    setBase((b) => b || j.defaultBase || j.branches[0] || "");
    setSha((s) => s || j.commits[0]?.sha || "");
    if (j.prs[0]) setPr((x) => x || String(j.prs[0].number));
  }

  async function start() {
    setError("");
    let source: DiffSource;
    if (kind === "working") source = { kind };
    else if (kind === "branch") source = { kind, base, head: head || undefined };
    else if (kind === "commit") source = { kind, sha };
    else source = { kind, number: Number(pr) };
    setStarting(true);
    try {
      const r = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoPath: info?.root ?? repoPath, source, language, model }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      onStart(j.id);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setStarting(false);
    }
  }

  const tabs: { k: Kind; label: string; hint: string }[] = [
    { k: "working", label: "作業ツリー", hint: "git diff HEAD + untracked" },
    { k: "branch", label: "ブランチ比較", hint: "base...HEAD" },
    { k: "commit", label: "コミット", hint: "git show" },
    { k: "pr", label: "Pull Request", hint: "gh pr diff" },
  ];

  return (
    <div className="setup">
      <div className="setup-card">
        <h1>
          <span className="logo">xpl</span> 差分をステップごとに理解する
        </h1>
        <p className="lead">AIが差分を読み、図やアニメーションを交えて少しずつ解説します。OKで次へ、疑問はその場でもあとでまとめてでも。</p>

        <label className="field">
          <span>リポジトリ</span>
          <div className="row">
            <input value={repoPath} onChange={(e) => setRepoPath(e.target.value)} onKeyDown={(e) => e.key === "Enter" && load(repoPath)} />
            <button className="btn" onClick={() => load(repoPath)}>
              読み込み
            </button>
          </div>
        </label>
        {infoError && <div className="error">{infoError}</div>}
        {info && (
          <div className="repo-meta">
            {info.root} · <b>{info.currentBranch}</b>
          </div>
        )}

        <div className="field">
          <span>解説する差分</span>
          <div className="tabs">
            {tabs.map((t) => (
              <button key={t.k} className={"tab " + (kind === t.k ? "active" : "")} onClick={() => setKind(t.k)}>
                <div>{t.label}</div>
                <small>{t.hint}</small>
              </button>
            ))}
          </div>
          <div className="source-opts">
            {kind === "working" && <div className="muted">{info ? `現在の変更: ${info.workingSummary}` : ""}</div>}
            {kind === "branch" && (
              <div className="row">
                <label className="inline">
                  base
                  <input list="branches" value={base} onChange={(e) => setBase(e.target.value)} />
                </label>
                <span className="muted">...</span>
                <label className="inline">
                  head
                  <input list="branches" value={head} placeholder="HEAD" onChange={(e) => setHead(e.target.value)} />
                </label>
                <datalist id="branches">
                  {info?.branches.map((b) => (
                    <option key={b} value={b} />
                  ))}
                </datalist>
              </div>
            )}
            {kind === "commit" && (
              <select value={sha} onChange={(e) => setSha(e.target.value)}>
                {info?.commits.map((c) => (
                  <option key={c.sha} value={c.sha}>
                    {c.sha.slice(0, 8)} {c.subject} — {c.author}, {c.date}
                  </option>
                ))}
              </select>
            )}
            {kind === "pr" && (
              <div>
                {info?.prs.length ? (
                  <select value={pr} onChange={(e) => setPr(e.target.value)}>
                    {info.prs.map((p) => (
                      <option key={p.number} value={p.number}>
                        #{p.number} {p.title} ({p.headRefName}, @{p.author})
                      </option>
                    ))}
                  </select>
                ) : null}
                <label className="inline">
                  PR番号
                  <input value={pr} onChange={(e) => setPr(e.target.value)} placeholder="123" />
                </label>
                {info?.prError && !info.prs.length && <div className="muted small">gh: {info.prError.slice(0, 200)}</div>}
              </div>
            )}
          </div>
        </div>

        <div className="row">
          <label className="field grow">
            <span>解説の言語</span>
            <select value={language} onChange={(e) => setLanguage(e.target.value)}>
              <option>日本語</option>
              <option>English</option>
            </select>
          </label>
          <label className="field grow">
            <span>モデル</span>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">デフォルト</option>
              <option value="opus">Opus</option>
              <option value="sonnet">Sonnet</option>
              <option value="haiku">Haiku</option>
            </select>
          </label>
        </div>

        {error && <div className="error">{error}</div>}
        <button className="btn primary big" disabled={!info || starting} onClick={start}>
          {starting ? "差分を取得中…" : "解説を始める"}
        </button>
        <p className="muted small">Claude Code にログイン済みのサブスクリプションを使用します（未ログインなら <code>claude</code> を起動して <code>/login</code>）。AIは読み取り専用ツールのみ使います。</p>
      </div>
    </div>
  );
}
