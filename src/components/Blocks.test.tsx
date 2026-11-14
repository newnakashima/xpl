import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Blocks, CodeBlock } from "./Blocks";
import { deferred, json, mockFetch } from "../test/helpers";
import type { CodeBlock as CodeBlockT, Row } from "../types";

vi.mock("./Visuals", () => ({ Mermaid: ({ code }: { code: string }) => <pre>{code}</pre>, HtmlVisual: ({ code }: { code: string }) => <pre>{code}</pre> }));

const rows: Row[] = [
  { kind: "ctx", oldN: 1, newN: 1, text: "same" }, { kind: "del", oldN: 2, text: "before" },
  { kind: "add", newN: 2, text: "after" },
];
function block(overrides: Partial<CodeBlockT> = {}): CodeBlockT {
  return { type: "code", file: "old.ts → new.ts", filePath: "new.ts", lang: "plaintext", view: "diff", rows, highlight: [2], notes: [{ line: 2, text: "reason" }], ...overrides };
}

describe("code display", () => {
  it("escapes code and places notes and highlights on the resulting line", () => {
    const { container } = render(<CodeBlock block={block({ lang: "unknown", rows: [{ kind: "add", newN: 2, text: '<img src=x onerror="alert(1)">' }] })} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("code")?.textContent).toContain("<img");
    expect(container.querySelector(".line.hl .src")?.textContent).toContain("<img");
    expect(screen.getAllByText("reason")).toHaveLength(1);
  });

  it("splits old and new code and annotates only the new side", () => {
    const { container } = render(<CodeBlock block={block({ view: "split" })} />);
    const panes = container.querySelectorAll<HTMLElement>(".split-pane");
    expect(within(panes[0]).getByText("before")).toBeTruthy();
    expect(within(panes[0]).queryByText("after")).toBeNull();
    expect(within(panes[0]).queryByText("reason")).toBeNull();
    expect(within(panes[1]).getByText("after")).toBeTruthy();
    expect(within(panes[1]).queryByText("before")).toBeNull();
    expect(within(panes[1]).getByText("reason")).toBeTruthy();
  });

  it("keeps wrapping independent for each block, including both split panes", () => {
    const { container } = render(<Blocks blocks={[block({ view: "split" }), block()]} />);
    const toggles = screen.getAllByRole("button", { name: "コードの折り返し" });
    expect(toggles[0].getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggles[0]);
    const figures = container.querySelectorAll(".codeblock");
    expect(figures[0].classList.contains("nowrap")).toBe(true);
    expect(figures[1].classList.contains("nowrap")).toBe(false);
    fireEvent.click(toggles[0]);
    expect(figures[0].classList.contains("nowrap")).toBe(false);
  });

  it.each(["renamed.ts", "deleted.ts"])("copies the resolved relative path %s", async (filePath) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<CodeBlock block={block({ filePath })} />);
    fireEvent.click(screen.getByRole("button", { name: "パスをコピー" }));
    await screen.findByRole("button", { name: "コピーしました" });
    expect(writeText).toHaveBeenCalledWith(filePath);
  });

  it("reports clipboard failure and allows another attempt", async () => {
    const writeText = vi.fn().mockRejectedValueOnce(new Error("denied")).mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<CodeBlock block={block()} />);
    fireEvent.click(screen.getByRole("button", { name: "パスをコピー" }));
    fireEvent.click(await screen.findByRole("button", { name: "コピーできませんでした" }));
    await screen.findByRole("button", { name: "コピーしました" });
    expect(writeText).toHaveBeenCalledTimes(2);
  });
});

describe("full-file expansion", () => {
  it("loads once, shows all changes, and retains annotations and wrap when toggled", async () => {
    const fetch = mockFetch();
    const request = deferred<Response>();
    fetch.mockReturnValue(request.promise);
    const input = block({ fileId: "F/1", view: "new", rows: [rows[2]] });
    const { container } = render(<CodeBlock block={input} sessionId="s/1" />);
    fireEvent.click(screen.getByRole("button", { name: "コードの折り返し" }));
    const toggle = screen.getByRole("button", { name: "ファイルの全文表示" });
    fireEvent.click(toggle);
    expect(screen.getByRole("status").textContent).toContain("読み込んでいます");
    const fullRows = [...rows, { kind: "ctx" as const, oldN: 3, newN: 3, text: "outside excerpt" }];
    await act(async () => request.resolve(json({ rows: fullRows })));
    expect(screen.getByText("before")).toBeTruthy();
    expect(screen.getByText("outside excerpt")).toBeTruthy();
    expect(container.querySelector(".codeblock")?.classList.contains("view-diff")).toBe(true);
    expect(container.querySelector(".codeblock")?.classList.contains("nowrap")).toBe(true);
    expect(screen.getAllByText("reason")).toHaveLength(1);
    expect(fetch).toHaveBeenCalledWith("/api/sessions/s%2F1/files/F%2F1", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    fireEvent.click(toggle);
    expect(screen.queryByText("before")).toBeNull();
    expect(screen.queryByText("outside excerpt")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText("outside excerpt")).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps old view in old-file coordinates when expanded", async () => {
    mockFetch().mockResolvedValue(json({ rows }));
    render(<CodeBlock block={block({ fileId: "F1", view: "old", rows: [rows[1]] })} sessionId="s" />);
    fireEvent.click(screen.getByRole("button", { name: "ファイルの全文表示" }));
    await screen.findByText("same");
    expect(screen.queryByText("after")).toBeNull();
    expect(screen.getByText("before")).toBeTruthy();
    expect(screen.getByText("reason")).toBeTruthy();
  });

  it("reports a failed request and retries on the next expansion", async () => {
    const fetch = mockFetch().mockResolvedValueOnce(json({ error: "snapshot unavailable" }, 400)).mockResolvedValue(json({ rows }));
    render(<CodeBlock block={block({ fileId: "F1", rows: [rows[2]] })} sessionId="s" />);
    const toggle = screen.getByRole("button", { name: "ファイルの全文表示" });
    fireEvent.click(toggle);
    expect((await screen.findByRole("alert")).textContent).toBe("snapshot unavailable");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    await screen.findByText("before");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("aborts obsolete requests and resets cached content when the block changes", async () => {
    const request = deferred<Response>();
    const fetch = mockFetch().mockReturnValue(request.promise);
    const { rerender } = render(<CodeBlock block={block({ fileId: "F1", rows: [rows[2]] })} sessionId="s" />);
    fireEvent.click(screen.getByRole("button", { name: "ファイルの全文表示" }));
    const signal = fetch.mock.calls[0][1]?.signal;
    rerender(<CodeBlock block={block({ fileId: "F2", rows: [{ kind: "ctx", newN: 1, text: "new block" }] })} sessionId="s2" />);
    expect(signal?.aborted).toBe(true);
    await act(async () => request.resolve(json({ rows: [{ kind: "ctx", newN: 1, text: "stale data" }] })));
    expect(screen.queryByText("stale data")).toBeNull();
    expect(screen.getByText("new block")).toBeTruthy();
    expect(screen.getByRole("button", { name: "ファイルの全文表示" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("hides expansion for blocks without a registered file or session", () => {
    render(<Blocks blocks={[block(), block({ fileId: "F1" })]} />);
    expect(screen.queryByRole("button", { name: "ファイルの全文表示" })).toBeNull();
  });
});

it("renders prose, callouts, and both visual types", () => {
  render(<Blocks blocks={[
    { type: "text", markdown: "**explanation**" }, { type: "callout", tone: "risk", markdown: "risk detail" },
    { type: "mermaid", code: "graph TD; A-->B", title: "Flow" }, { type: "html", code: "<p>animation</p>", title: "Animation" },
  ]} />);
  expect(screen.getByText("explanation").tagName).toBe("STRONG");
  expect(screen.getByText("注意")).toBeTruthy();
  expect(screen.getByText("risk detail")).toBeTruthy();
  expect(screen.getByText("Flow")).toBeTruthy();
  expect(screen.getByText("Animation")).toBeTruthy();
});
