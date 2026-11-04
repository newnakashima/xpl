import { Fragment, useMemo } from "react";
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
        const marked = view !== "new" || (r.kind === "add" && block.fileStatus !== "added");
        const cls = ["line", marked ? `k-${r.kind}` : "", n != null && hl.has(n) && !(r.kind === "del" && view !== "old") ? "hl" : "", ns ? "has-note" : ""].join(" ");
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

export function CodeBlock({ block }: { block: CodeBlockT }) {
  const html = useHighlighted(block.rows, block.lang);
  const indexed = block.rows.map((r, i) => ({ r, h: html[i] }));
  return (
    <figure className={`codeblock view-${block.view}`}>
      <figcaption className="cb-head">
        <span className="cb-file">{block.file}</span>
        <span className="cb-view">{VIEW_LABEL[block.view]}</span>
      </figcaption>
      {block.view === "split" ? (
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
        <Lines rows={block.rows} html={html} view={block.view} block={block} />
      )}
      {block.caption && <figcaption className="cb-caption">{block.caption}</figcaption>}
    </figure>
  );
}

const TONE_LABEL = { info: "補足", tip: "ヒント", risk: "注意" } as const;

export function Blocks({ blocks }: { blocks: Block[] }) {
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
            return <CodeBlock key={i} block={b} />;
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
