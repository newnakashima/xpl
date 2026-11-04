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
  const [provider, setProvider] = useState<"claude" | "codex">("claude");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/config")
      .then(async (r) => {
        if (!r.ok) throw new Error("設定を読み込めませんでした。サーバーの設定を確認してください。");
        return r.json();
      })
      .then((c) => {
        setRepoPath(c.defaultRepo);
        setProvider(c.defaultProvider ?? "claude");
        return load(c.defaultRepo);
      })
      .catch((e) => setError(e.message));
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
        body: JSON.stringify({ repoPath: info?.root ?? repoPath, source, language, model, provider }),
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

  const tabs: { k: Kind; label: string; desc: string; cmd: string }[] = [
    { k: "working", label: "作業中の変更", desc: "コミット前の変更と未追跡ファイル", cmd: "git diff HEAD" },
    { k: "branch", label: "ブランチ比較", desc: "ブランチで加えた変更をまとめて読む", cmd: "base...head" },
    { k: "commit", label: "コミット", desc: "1 つのコミットの変更を読む", cmd: "git show" },
    { k: "pr", label: "Pull Request", desc: "GitHub の Pull Request を読む", cmd: "gh pr diff" },
  ];

  return (
    <div className="setup">
      <div className="setup-inner">
        <header className="setup-head">
          <span className="logo">xpl</span>
          <h1>どの差分を読みますか？</h1>
          <p className="lead">AI が差分を読んで、理解しやすい順に少しずつ解説します。1 ステップ読んだら OK で次へ。わからないところはその場で聞けます。</p>
        </header>

        <div className="form-row">
          <label className="label" htmlFor="repo">
            リポジトリ
          </label>
          <div>
            <div className="row">
              <input
                id="repo"
                value={repoPath}
                spellCheck={false}
                onChange={(e) => setRepoPath(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && load(repoPath)}
              />
              <button className="btn" onClick={() => load(repoPath)}>
                読み込む
              </button>
            </div>
            {infoError && <div className="error">{infoError}</div>}
            {info && (
              <div className="repo-meta">
                {info.root !== repoPath.replace(/\/+$/, "") && <span className="path">{info.root}</span>}
                <span>
                  ブランチ <b>{info.currentBranch}</b>
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="form-row">
          <div className="label" id="source-label">
            読む差分
          </div>
          <div>
            <div className="sources" role="radiogroup" aria-labelledby="source-label">
              {tabs.map((t) => (
                <label key={t.k} className={"source " + (kind === t.k ? "on" : "")}>
                  <input type="radio" name="source" checked={kind === t.k} onChange={() => setKind(t.k)} />
                  <span className="name">{t.label}</span>
                  <span className="desc">{t.desc}</span>
                  <span className="cmd">{t.cmd}</span>
                </label>
              ))}
            </div>
            <div className="source-opts">
              {kind === "working" && <div className="muted">{info ? `今の変更: ${info.workingSummary}` : ""}</div>}
              {kind === "branch" && (
                <div className="row">
                  <label className="inline">
                    比較元
                    <input list="branches" value={base} spellCheck={false} onChange={(e) => setBase(e.target.value)} />
                  </label>
                  <label className="inline">
                    比較先
                    <input list="branches" value={head} spellCheck={false} placeholder="HEAD" onChange={(e) => setHead(e.target.value)} />
                  </label>
                  <datalist id="branches">
                    {info?.branches.map((b) => (
                      <option key={b} value={b} />
                    ))}
                  </datalist>
                </div>
              )}
              {kind === "commit" && (
                <select value={sha} onChange={(e) => setSha(e.target.value)} aria-label="コミット">
                  {info?.commits.map((c) => (
                    <option key={c.sha} value={c.sha}>
                      {c.sha.slice(0, 8)}　{c.subject}（{c.author}, {c.date}）
                    </option>
                  ))}
                </select>
              )}
              {kind === "pr" && (
                <>
                  {info?.prs.length ? (
                    <select value={pr} onChange={(e) => setPr(e.target.value)} aria-label="Pull Request">
                      {info.prs.map((p) => (
                        <option key={p.number} value={p.number}>
                          #{p.number}　{p.title}（{p.headRefName}, @{p.author}）
                        </option>
                      ))}
                    </select>
                  ) : null}
                  <label className="inline">
                    PR 番号
                    <input value={pr} inputMode="numeric" onChange={(e) => setPr(e.target.value)} placeholder="123" />
                  </label>
                  {info?.prError && !info.prs.length && (
                    <div className="muted">
                      Pull Request の一覧を取得できませんでした。番号を直接入力するか、<code>gh auth login</code> を実行してください。
                      <br />
                      <span className="small">{info.prError.slice(0, 200)}</span>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        <div className="form-row">
          <div className="label">解説のしかた</div>
          <div className="prefs">
            <label>
              AI
              <select value={provider} onChange={(e) => { setProvider(e.target.value as "claude" | "codex"); setModel(""); }}>
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
              </select>
            </label>
            <label>
              言語
              <select value={language} onChange={(e) => setLanguage(e.target.value)}>
                <option>日本語</option>
                <option>English</option>
              </select>
            </label>
            <label>
              モデル
              {provider === "codex" ? (
                <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="Codex の既定モデル" aria-label="Codex モデル" spellCheck={false} />
              ) : <select value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="">既定</option>
                <option value="opus">Opus</option>
                <option value="sonnet">Sonnet</option>
                <option value="haiku">Haiku</option>
              </select>}
            </label>
          </div>
        </div>

        {error && <div className="error">{error}</div>}
        <div className="setup-actions">
          <button className="btn primary" disabled={!info || starting} onClick={start}>
            {starting ? "差分を取得しています…" : "解説を始める"}
          </button>
        </div>
        <p className="setup-note">
          {provider === "codex"
            ? <>Codex CLI のログイン情報で動きます。未ログインなら <code>codex login</code> を実行してください。</>
            : <>Claude Code にログインしているサブスクリプションで動きます。未ログインなら <code>claude</code> を起動して <code>/login</code> してください。</>}
          {" "}AI はファイルを読むだけで、変更はしません。
        </p>
      </div>
    </div>
  );
}
