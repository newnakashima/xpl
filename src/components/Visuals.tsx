import { useEffect, useId, useRef, useState } from "react";
import mermaid from "mermaid";

mermaid.initialize({
  startOnLoad: false,
  theme: "base",
  securityLevel: "strict",
  fontFamily: '"IBM Plex Sans JP", "Hiragino Sans", sans-serif',
  themeVariables: {
    fontSize: "14px",
    background: "#ffffff",
    primaryColor: "#ffffff",
    primaryBorderColor: "#1b5e86",
    primaryTextColor: "#262a30",
    secondaryColor: "#e7eff4",
    secondaryBorderColor: "#1b5e86",
    tertiaryColor: "#f4f5f2",
    tertiaryBorderColor: "#a4a8ad",
    lineColor: "#6e737a",
    textColor: "#262a30",
    noteBkgColor: "#fff7cc",
    noteBorderColor: "#d9b21f",
    noteTextColor: "#262a30",
    actorBkg: "#ffffff",
    actorBorder: "#1b5e86",
    actorLineColor: "#a4a8ad",
    signalColor: "#262a30",
    signalTextColor: "#262a30",
    clusterBkg: "#f4f5f2",
    clusterBorder: "#dde0dc",
    edgeLabelBackground: "#ffffff",
  },
});

export function Mermaid({ code }: { code: string }) {
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
        if (alive) setError(String(e?.message ?? e));
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

export function HtmlVisual({ code }: { code: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(420);
  const token = useId();
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (
        e.source === ref.current?.contentWindow &&
        e.data?.xplToken === token &&
        typeof e.data.height === "number"
      ) {
        setHeight(Math.min(Math.max(e.data.height + 4, 160), 900));
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [token]);
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}">
<style>html,body{margin:0;padding:12px;font-family:"Hiragino Sans","Noto Sans JP",system-ui,sans-serif;color:#262a30;background:#fff;box-sizing:border-box}</style>
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
