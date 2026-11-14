import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { SessionView } from "./SessionView";
import { deferred, json, mockFetch } from "./test/helpers";
import type { SessionEvent } from "./types";

vi.mock("./components/Blocks", () => ({ Blocks: ({ blocks }: { blocks: { type: string; markdown?: string }[] }) => <div>{blocks.map((b, i) => <p key={i}>{b.markdown}</p>)}</div> }));

class MockEventSource {
  static CLOSED = 2;
  static instances: MockEventSource[] = [];
  readyState = 1;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn(() => { this.readyState = MockEventSource.CLOSED; });
  constructor(public url: string) { MockEventSource.instances.push(this); }
  emit(...events: SessionEvent[]) {
    act(() => { for (const event of events) this.onmessage?.({ data: JSON.stringify(event) }); });
  }
}

beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
});

function setup() {
  const fetch = mockFetch().mockResolvedValue(json({ ok: true }));
  const onExit = vi.fn();
  const view = render(<SessionView id="session-1" onExit={onExit} />);
  const events = MockEventSource.instances[0];
  const step = (index: number) => events.emit({ type: "step", index, title: `Step ${index}`, blocks: [{ type: "text", markdown: `Explanation ${index}` }] });
  const ready = () => {
    events.emit(
      { type: "meta", title: "Example change", repo: "/repo", fileCount: 2, additions: 3, deletions: 1 },
      { type: "plan", overview: "Rationale", skipped_hunks: [], steps: [0, 1].map((i) => ({ section: "Implementation", title: `Step ${i}`, hunk_ids: [], line_ranges: [] })) },
      { type: "phase", phase: "stepping" },
      { type: "status", waiting: false, aiWorking: false, prepared: 1 },
    );
    step(0);
  };
  return { ...view, events, fetch, onExit, step, ready };
}

it("connects to SSE, shows the plan and metadata, and closes the connection on unmount", () => {
  const h = setup();
  expect(h.events.url).toBe("/api/sessions/session-1/events");
  h.ready();
  expect(screen.getByText("Example change")).toBeTruthy();
  expect(screen.getByText("Rationale")).toBeTruthy();
  expect(screen.getByText("2 ファイル")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Step 0" })).toBeTruthy();
  expect((screen.getByRole("button", { name: /2\s*Step 1/ }) as HTMLButtonElement).disabled).toBe(true);
  h.unmount();
  expect(h.events.close).toHaveBeenCalledOnce();
});

it("requests the next step once and automatically displays it when it arrives", async () => {
  const h = setup();
  h.ready();
  fireEvent.click(screen.getByRole("button", { name: /OK、次へ/ }));
  const pending = screen.getByRole("button", { name: /次のステップを準備しています/ });
  expect((pending as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(pending);
  expect(h.fetch).toHaveBeenCalledOnce();
  expect(h.fetch).toHaveBeenCalledWith("/api/sessions/session-1/next", { method: "POST" });
  h.step(1);
  expect(screen.getByRole("heading", { name: "Step 1" })).toBeTruthy();
  expect((screen.getByRole("button", { name: /OK、解説を終える/ }) as HTMLButtonElement).disabled).toBe(false);
});

it("reviews previous steps locally and returns to the latest without advancing the server", () => {
  const h = setup();
  h.ready();
  h.step(1);
  fireEvent.keyDown(document.body, { key: "ArrowLeft" });
  expect(screen.getByRole("heading", { name: "Step 0" })).toBeTruthy();
  fireEvent.keyDown(document.body, { key: "ArrowRight" });
  expect(screen.getByRole("heading", { name: "Step 1" })).toBeTruthy();
  expect(h.fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /1\s*Step 0/ }));
  expect(screen.getByRole("heading", { name: "Step 0" })).toBeTruthy();
});

it("asks about the viewed step and clears only the submitted text", async () => {
  const h = setup();
  h.ready();
  h.step(1);
  fireEvent.keyDown(document.body, { key: "ArrowLeft" });
  const input = screen.getByRole("textbox", { name: "質問" });
  fireEvent.change(input, { target: { value: "  Why this change?  " } });
  fireEvent.click(screen.getByRole("button", { name: "質問する" }));
  await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(""));
  expect(JSON.parse(h.fetch.mock.calls[0][1]!.body as string)).toEqual({ text: "Why this change?", mode: "now", afterStep: 0 });
});

it("keeps new text typed while an earlier question is in flight", async () => {
  const h = setup();
  h.ready();
  const response = deferred<Response>();
  h.fetch.mockReturnValue(response.promise);
  const input = screen.getByRole("textbox", { name: "質問" });
  fireEvent.change(input, { target: { value: "first" } });
  fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
  fireEvent.change(input, { target: { value: "new draft" } });
  await act(async () => response.resolve(json({ ok: true })));
  expect((input as HTMLTextAreaElement).value).toBe("new draft");
});

it("preserves a failed question's draft and displays the server error", async () => {
  const h = setup();
  h.ready();
  h.fetch.mockResolvedValue(json({ error: "question rejected" }, 400));
  const input = screen.getByRole("textbox", { name: "質問" });
  fireEvent.change(input, { target: { value: "draft" } });
  fireEvent.click(screen.getByRole("button", { name: "質問する" }));
  expect((await screen.findByRole("alert")).textContent).toBe("question rejected");
  expect((input as HTMLTextAreaElement).value).toBe("draft");
});

it("submits deferred questions and opens their answers after all steps", async () => {
  const h = setup();
  h.ready();
  fireEvent.click(screen.getByRole("button", { name: "最後にまとめて" }));
  fireEvent.change(screen.getByRole("textbox", { name: "質問" }), { target: { value: "Later question" } });
  fireEvent.click(screen.getByRole("button", { name: "書き留める" }));
  await waitFor(() => expect(h.fetch).toHaveBeenCalledOnce());
  expect(JSON.parse(h.fetch.mock.calls[0][1]!.body as string).mode).toBe("later");
  h.events.emit({ type: "question", question: { id: "Q1", text: "Later question", mode: "later", afterStep: 0, answered: false } });
  h.step(1);
  expect(screen.getByRole("button", { name: /まとめた質問 1 件へ/ })).toBeTruthy();
  h.events.emit({ type: "phase", phase: "final_qa" });
  expect(screen.getByRole("heading", { name: "質問への回答" })).toBeTruthy();
  h.events.emit({ type: "answer", questionId: "Q1", blocks: [{ type: "text", markdown: "Final answer" }] }, { type: "phase", phase: "finished" });
  expect(screen.getByText("Final answer")).toBeTruthy();
  expect(screen.getByText("すべてのステップを読み終えました。")).toBeTruthy();
});

it("shows immediate questions with answers on their associated step", () => {
  const h = setup();
  h.ready();
  h.events.emit({ type: "question", question: { id: "Q1", text: "Immediate question", mode: "now", afterStep: 0, answered: false } });
  expect(screen.getByText("回答を書いています…")).toBeTruthy();
  h.events.emit({ type: "answer", questionId: "Q1", blocks: [{ type: "text", markdown: "Immediate answer" }] });
  expect(screen.queryByText("回答を書いています…")).toBeNull();
  expect(within(screen.getByRole("article")).getByText("Immediate answer")).toBeTruthy();
  h.step(1);
  expect(screen.queryByText("Immediate answer")).toBeNull();
});

it("focuses questions using slash and ignores step shortcuts while typing or pressing a button", () => {
  const h = setup();
  h.ready();
  fireEvent.keyDown(document.body, { key: "/" });
  const input = screen.getByRole("textbox", { name: "質問" });
  expect(document.activeElement).toBe(input);
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.keyDown(screen.getByRole("button", { name: /OK、次へ/ }), { key: "Enter" });
  expect(h.fetch).not.toHaveBeenCalled();
});

it("keeps reconnecting streams alive but disables actions after a permanent connection failure", () => {
  const h = setup();
  h.ready();
  h.events.readyState = 0;
  act(() => h.events.onerror?.());
  expect(screen.queryByRole("alert")).toBeNull();
  h.events.readyState = MockEventSource.CLOSED;
  act(() => h.events.onerror?.());
  expect(screen.getByRole("alert").textContent).toContain("セッションに接続できません");
  expect((screen.getByRole("textbox", { name: "質問" }) as HTMLTextAreaElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: /解説は中断されました/ }) as HTMLButtonElement).disabled).toBe(true);
});

it("shows agent errors and replaces pending answer text after the session fails", () => {
  const h = setup();
  h.ready();
  h.events.emit(
    { type: "question", question: { id: "Q1", text: "Pending question", mode: "now", afterStep: 0, answered: false } },
    { type: "error", message: "connection lost" }, { type: "phase", phase: "failed" },
  );
  expect(screen.getByRole("alert").textContent).toBe("connection lost");
  expect(screen.getByText("中断したため回答できませんでした")).toBeTruthy();
});

it("replaces duplicate step events and orders replayed steps by their indices", () => {
  const h = setup();
  h.ready();
  h.step(1);
  h.events.emit({ type: "step", index: 0, title: "Updated step 0", blocks: [{ type: "text", markdown: "Updated explanation" }] });
  expect(screen.getByRole("heading", { name: "Step 1" })).toBeTruthy();
  fireEvent.keyDown(document.body, { key: "ArrowLeft" });
  expect(screen.getByRole("heading", { name: "Updated step 0" })).toBeTruthy();
  expect(screen.queryByText("Explanation 0")).toBeNull();
});

it("exits through the selection button", () => {
  const h = setup();
  fireEvent.click(screen.getByRole("button", { name: "差分を選び直す" }));
  expect(h.onExit).toHaveBeenCalledOnce();
});
