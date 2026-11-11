import { Fragment, useEffect, useMemo, useState } from "react";
import hljs from "highlight.js/lib/common";
import "highlight.js/styles/github.css";
import "./code-theme.css";
import type { Block, CodeBlock as CodeBlockT, Row } from "../types";
import { Markdown } from "./Markdown";
import { HtmlVisual, Mermaid } from "./Visuals";

function esc(s: string) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
}

function useHighlighted(rows: Row[], lang: string) {
  return useMemo(() => {
    const ok = !!hljs.getLanguage(lang);
    return rows.map((r) => {
      if (!ok || !r.text) return esc(r.text);
      try {
        return hljs.highlight(r.text, { language: lang, ignoreIllegals: true }).value;
      } catch {
        return esc(r.text);
      }
    });
  }, [rows, lang]);
}

const VIEW_LABEL: Record<CodeBlockT["view"], string> = {
  new: "変更後",
  diff: "差分",
  split: "変更前と変更後",
  old: "削除されたコード",
  context: "周辺コード（変更なし）",
};

function lineNo(r: Row, view: CodeBlockT["view"]) {
  return view === "old" ? r.oldN : r.newN ?? r.oldN;
}

function Lines({
  rows,
  html,
  view,
  block,
  side,
}: {
  rows: Row[];
  html: string[];
  view: CodeBlockT["view"];
  block: CodeBlockT;
  side?: "old" | "new";
}) {
  const hl = new Set(block.highlight);
  const notes = new Map<number, string[]>();
  for (const n of block.notes) notes.set(n.line, [...(notes.get(n.line) ?? []), n.text]);
  const showNotes = side !== "old";
  const sideNotes = view !== "split" && block.notes.length > 0;
  return (
    <div className={"lines " + (sideNotes ? "with-notes" : "")}>
      {rows.map((r, i) => {
        const n = side === "old" ? r.oldN : side === "new" ? r.newN : lineNo(r, view);
        const ns = showNotes && n != null && !(r.kind === "del" && view !== "old") ? notes.get(n) : undefined;
        const cls = ["line", `k-${r.kind}`, n != null && hl.has(n) && !(r.kind === "del" && view !== "old") ? "hl" : "", ns ? "has-note" : ""].join(" ");
        return (
          <Fragment key={i}>
            <div className={cls}>
              <span className="ln">{n ?? ""}</span>
              <span className="sign">{view === "diff" ? (r.kind === "add" ? "+" : r.kind === "del" ? "−" : " ") : ""}</span>
              <code className="src" dangerouslySetInnerHTML={{ __html: html[i] || " " }} />
              {sideNotes && <span className="note">{ns?.map((t, j) => <span key={j} className="note-pill">{t}</span>)}</span>}
            </div>
            {!sideNotes && ns && (
              <div className="note-below">
                {ns.map((t, j) => (
                  <span key={j} className="note-pill">
                    {t}
                  </span>
                ))}
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

export function CodeBlock({ block, sessionId }: { block: CodeBlockT; sessionId?: string }) {
  const [wrap, setWrap] = useState(true);
  const [showFull, setShowFull] = useState(false);
  const [fullRows, setFullRows] = useState<Row[] | null>(null);
  const [error, setError] = useState("");
  const fileId = block.fileId;
  useEffect(() => {
    setShowFull(false);
    setFullRows(null);
    setError("");
  }, [block, sessionId]);
  useEffect(() => {
    if (!showFull || fullRows || !sessionId || !fileId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(fileId)}`, { signal: controller.signal });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "全文を読み込めませんでした");
        if (!controller.signal.aborted) setFullRows(result.rows);
      } catch (error) {
        if (controller.signal.aborted) return;
        setError(error instanceof Error ? error.message : String(error));
        setShowFull(false);
      }
    })();
    return () => controller.abort();
  }, [showFull, fullRows, sessionId, fileId]);
  const expanded = showFull && fullRows !== null;
  // Full resulting-code blocks also show removed lines so all changes are visible.
  const view = expanded && block.view === "new" ? "diff" : block.view;
  const rows = useMemo(() => {
    if (!expanded) return block.rows;
    return view === "old" ? fullRows.filter((r) => r.kind !== "add") : fullRows;
  }, [expanded, fullRows, block.rows, view]);
  const html = useHighlighted(rows, block.lang);
  const indexed = rows.map((r, i) => ({ r, h: html[i] }));
  return (
    <figure className={`codeblock view-${view}${wrap ? "" : " nowrap"}`}>
      <figcaption className="cb-head">
        <span className="cb-file">{block.file}</span>
        <div className="cb-actions">
          <span className="cb-view">{expanded ? "全文 · " : ""}{VIEW_LABEL[view]}</span>
          {sessionId && block.fileId && (
            <button
              type="button"
              className="cb-full"
              aria-label="ファイルの全文表示"
              aria-pressed={showFull}
              title={showFull ? "解説の抜粋に戻す" : "ファイル全体を表示する"}
              onClick={() => { setError(""); setShowFull((value) => !value); }}
            >
              {showFull ? "抜粋表示" : "全文表示"}
            </button>
          )}
          <button
            type="button"
            className="cb-wrap"
            aria-label="コードの折り返し"
            aria-pressed={wrap}
            title={wrap ? "折り返しを無効にする" : "折り返しを有効にする"}
            onClick={() => setWrap((value) => !value)}
          >
            {wrap ? "wrap" : "nowrap"}
          </button>
        </div>
      </figcaption>
      {showFull && !fullRows && <div className="cb-status" role="status">全文を読み込んでいます…</div>}
      {error && <div className="cb-error" role="alert">{error}</div>}
      {view === "split" ? (
        <div className="split">
          <div className="split-pane">
            <div className="split-label">変更前</div>
            {(() => {
              const xs = indexed.filter((x) => x.r.kind !== "add");
              return <Lines rows={xs.map((x) => x.r)} html={xs.map((x) => x.h)} view="split" block={block} side="old" />;
            })()}
          </div>
          <div className="split-pane">
            <div className="split-label">変更後</div>
            {(() => {
              const xs = indexed.filter((x) => x.r.kind !== "del");
              return <Lines rows={xs.map((x) => x.r)} html={xs.map((x) => x.h)} view="split" block={block} side="new" />;
            })()}
          </div>
        </div>
      ) : (
        <Lines rows={rows} html={html} view={view} block={block} />
      )}
      {block.caption && <figcaption className="cb-caption">{block.caption}</figcaption>}
    </figure>
  );
}

const TONE_LABEL = { info: "補足", tip: "ヒント", risk: "注意" } as const;

export function Blocks({ blocks, sessionId }: { blocks: Block[]; sessionId?: string }) {
  return (
    <div className="blocks">
      {blocks.map((b, i) => {
        switch (b.type) {
          case "text":
            return <Markdown key={i} text={b.markdown} />;
          case "callout":
            return (
              <div key={i} className={`callout tone-${b.tone}`}>
                <span className="callout-label">{TONE_LABEL[b.tone]}</span>
                <Markdown text={b.markdown} />
              </div>
            );
          case "code":
            return <CodeBlock key={i} block={b} sessionId={sessionId} />;
          case "mermaid":
            return (
              <figure key={i} className="visual">
                {b.title && <figcaption className="visual-title">{b.title}</figcaption>}
                <Mermaid code={b.code} />
              </figure>
            );
          case "html":
            return (
              <figure key={i} className="visual">
                {b.title && <figcaption className="visual-title">{b.title}</figcaption>}
                <HtmlVisual code={b.code} />
              </figure>
            );
        }
      })}
    </div>
  );
}
