import { useEffect, useId, useRef, useState } from "react";
import mermaid from "mermaid";
import type { Visual } from "../types";

mermaid.initialize({
  startOnLoad: false,
  theme: "base",
  securityLevel: "strict",
  fontFamily: "ui-sans-serif, system-ui, sans-serif",
  themeVariables: {
    primaryColor: "#eef2ff",
    primaryBorderColor: "#6366f1",
    primaryTextColor: "#1e1b4b",
    lineColor: "#64748b",
    secondaryColor: "#f0fdf4",
    tertiaryColor: "#fff7ed",
  },
});

function Mermaid({ code }: { code: string }) {
  const id = "m" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string>("");
  useEffect(() => {
    let alive = true;
    const src = code.replace(/^```(?:mermaid)?\s*/i, "").replace(/```\s*$/, "");
    mermaid
      .render(id, src)
      .then((r) => alive && setSvg(r.svg))
      .catch((e) => {
        alive && setError(String(e?.message ?? e));
        document.getElementById("d" + id)?.remove();
      });
    return () => {
      alive = false;
    };
  }, [code, id]);
  if (error)
    return (
      <div className="visual-error">
        <div>図の描画に失敗しました: {error.split("\n")[0]}</div>
        <pre>{code}</pre>
      </div>
    );
  return <div className="mermaid-box" dangerouslySetInnerHTML={{ __html: svg }} />;
}

const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:";

function HtmlVisual({ code }: { code: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(420);
  const token = useId();
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source === ref.current?.contentWindow && e.data?.xplToken === token && typeof e.data.height === "number") {
        setHeight(Math.min(Math.max(e.data.height + 4, 160), 900));
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [token]);
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}">
<style>html,body{margin:0;padding:12px;font-family:ui-sans-serif,system-ui,sans-serif;color:#0f172a;background:#fff;box-sizing:border-box}</style>
</head><body>${code}
<script>(function(){var t=${JSON.stringify(token)};function s(){parent.postMessage({xplToken:t,height:document.documentElement.scrollHeight},"*")}
new ResizeObserver(s).observe(document.documentElement);window.addEventListener("load",s);s();})();</script></body></html>`;
  return (
    <iframe
      ref={ref}
      className="html-visual"
      sandbox="allow-scripts"
      srcDoc={doc}
      style={{ height }}
      title="visual"
    />
  );
}

export function Visuals({ visuals }: { visuals: Visual[] }) {
  if (!visuals.length) return null;
  return (
    <div className="visuals">
      {visuals.map((v, i) => (
        <figure key={i} className="visual">
          {v.title && <figcaption className="visual-title">{v.title}</figcaption>}
          {v.kind === "mermaid" ? <Mermaid code={v.code} /> : <HtmlVisual code={v.code} />}
          {v.caption && <figcaption className="visual-caption">{v.caption}</figcaption>}
        </figure>
      ))}
    </div>
  );
}
