import type React from "react";
import { useState } from "react";
import type { FileDiff, Hunk, LineRange } from "../types";

interface Row {
  kind: "add" | "del" | "ctx" | "meta";
  oldN?: number;
  newN?: number;
  text: string;
}

function rowsOf(h: Hunk): Row[] {
  let o = h.oldStart;
  let n = h.newStart;
  return h.lines.map((l) => {
    const c = l[0];
    const text = l.slice(1);
    if (c === "+") return { kind: "add", newN: n++, text };
    if (c === "-") return { kind: "del", oldN: o++, text };
    if (c === "\\") return { kind: "meta", text: l };
    return { kind: "ctx", oldN: o++, newN: n++, text };
  });
}

function inRanges(r: Row, ranges: LineRange[], prevNew: number) {
  // deleted lines are attributed to the next new line position
  const n = r.newN ?? prevNew;
  return ranges.some((x) => n >= x.start && n <= x.end);
}

function HunkView({ hunk, ranges }: { hunk: Hunk; ranges: LineRange[] }) {
  const [expanded, setExpanded] = useState(false);
  const rows = rowsOf(hunk);
  const focused: boolean[] = [];
  let prevNew = hunk.newStart;
  for (const r of rows) {
    focused.push(ranges.length ? inRanges(r, ranges, prevNew) : true);
    if (r.newN) prevNew = r.newN + 1;
  }
  const hasFocus = ranges.length > 0;
  const CONTEXT = 2;
  const visible = rows.map((_, i) => {
    if (!hasFocus || expanded) return true;
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(rows.length - 1, i + CONTEXT); k++) if (focused[k]) return true;
    return false;
  });

  const out: React.ReactElement[] = [];
  let hidden = 0;
  const flushHidden = (key: string) => {
    if (hidden) {
      const count = hidden;
      out.push(
        <tr key={key} className="row-gap" onClick={() => setExpanded(true)}>
          <td colSpan={3}>⋯ {count} 行を表示</td>
        </tr>
      );
      hidden = 0;
    }
  };
  rows.forEach((r, i) => {
    if (!visible[i]) {
      hidden++;
      return;
    }
    flushHidden("g" + i);
    out.push(
      <tr key={i} className={`row-${r.kind} ${hasFocus && focused[i] ? "row-focus" : ""}`}>
        <td className="ln">{r.oldN ?? ""}</td>
        <td className="ln">{r.newN ?? ""}</td>
        <td className="code">
          <span className="sign">{r.kind === "add" ? "+" : r.kind === "del" ? "-" : " "}</span>
          {r.text}
        </td>
      </tr>
    );
  });
  flushHidden("gend");

  return (
    <div className="hunk">
      <div className="hunk-header">
        <span className="hunk-id">{hunk.id}</span> {hunk.header.replace(/^(@@[^@]*@@)/, "$1")}
      </div>
      <table className="diff-table">
        <tbody>{out}</tbody>
      </table>
    </div>
  );
}

export function DiffView({
  files,
  hunkIds,
  ranges = [],
}: {
  files: FileDiff[];
  hunkIds: string[];
  ranges?: LineRange[];
}) {
  const wanted = new Set(hunkIds);
  const groups = files
    .map((f) => ({ f, hunks: f.hunks.filter((h) => wanted.has(h.id)) }))
    .filter((g) => g.hunks.length);
  if (!groups.length) return null;
  // Keep the order the AI listed hunks in (by first occurrence of each file)
  const order = new Map<string, number>();
  hunkIds.forEach((id, i) => {
    const fid = id.split("H")[0];
    if (!order.has(fid)) order.set(fid, i);
  });
  groups.sort((a, b) => (order.get(a.f.id) ?? 0) - (order.get(b.f.id) ?? 0));
  return (
    <div className="diff-view">
      {groups.map(({ f, hunks }) => (
        <div key={f.id} className="diff-file">
          <div className="diff-file-header">
            <span className={`badge badge-${f.status}`}>{statusLabel[f.status]}</span>
            <span className="path">{f.status === "renamed" ? `${f.oldPath} → ${f.newPath}` : f.status === "deleted" ? f.oldPath : f.newPath}</span>
            <span className="stat">
              <span className="plus">+{f.additions}</span> <span className="minus">-{f.deletions}</span>
            </span>
          </div>
          {hunks.map((h) => (
            <HunkView key={h.id} hunk={h} ranges={ranges.filter((r) => r.hunk_id === h.id)} />
          ))}
        </div>
      ))}
    </div>
  );
}

const statusLabel: Record<FileDiff["status"], string> = {
  added: "新規",
  deleted: "削除",
  modified: "変更",
  renamed: "移動",
  binary: "バイナリ",
};
