import type { FileDiff, Hunk } from "./git.js";

export interface Row {
  kind: "add" | "del" | "ctx";
  oldN?: number;
  newN?: number;
  text: string;
}

export function hunkRows(h: Hunk): Row[] {
  let o = h.oldStart;
  let n = h.newStart;
  const rows: Row[] = [];
  for (const l of h.lines) {
    const c = l[0];
    if (c === "\\") continue;
    const text = l.slice(1).replace(/\r$/, "");
    if (c === "+") rows.push({ kind: "add", newN: n++, text });
    else if (c === "-") rows.push({ kind: "del", oldN: o++, text });
    else rows.push({ kind: "ctx", oldN: o++, newN: n++, text });
  }
  return rows;
}

export function textRows(text: string): Row[] {
  // Git may normalize CRLF in patches even when the working file uses CRLF.
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines.map((text, i) => ({ kind: "ctx", oldN: i + 1, newN: i + 1, text }));
}

/** Fill gaps between hunks from the selected revision, keeping every change. */
export function fullFileRows(file: FileDiff, text: string): Row[] {
  // These patches already contain the entire file, including deleted files
  // that no longer exist in the working tree or at the head revision.
  if (file.status === "added" || file.status === "deleted") return file.hunks.flatMap(hunkRows);
  const lines = textRows(text);
  const rows: Row[] = [];
  let oldN = 1;
  let newN = 1;
  const contextUntil = (end: number) => {
    while (newN < end && newN <= lines.length) {
      rows.push({ kind: "ctx", oldN: oldN++, newN, text: lines[newN++ - 1].text });
    }
  };
  for (const h of file.hunks) {
    // For a zero-length new range, newStart points just before the deletion.
    const emptyNewRange = /^@@ -\d+(?:,\d+)? \+\d+,0 @@/.test(h.header);
    contextUntil(h.newStart + (emptyNewRange ? 1 : 0));
    for (const row of hunkRows(h)) {
      if (row.kind !== "del") {
        if (row.newN !== newN || row.text !== lines[newN - 1]?.text) {
          throw new Error(`差分とファイルの内容が一致しません: ${file.newPath}`);
        }
        newN++;
      }
      if (row.kind !== "add") oldN++;
      rows.push(row);
    }
  }
  contextUntil(lines.length + 1);
  return rows;
}
