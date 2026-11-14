import { act, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import mermaid from "mermaid";
import { HtmlVisual, Mermaid } from "./Visuals";
import { deferred } from "../test/helpers";

vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: vi.fn() } }));
beforeEach(() => {
  vi.mocked(mermaid.render).mockReset();
});

it("strips Mermaid fences and displays the rendered SVG", async () => {
  vi.mocked(mermaid.render).mockResolvedValue({
    svg: '<svg aria-label="diagram"></svg>',
    diagramType: "flowchart",
  });
  render(<Mermaid code={"```mermaid\ngraph TD; A-->B\n```"} />);
  await act(async () => {});
  expect(mermaid.render).toHaveBeenCalledWith(
    expect.stringMatching(/^m[a-zA-Z0-9]+$/),
    "graph TD; A-->B\n",
  );
  expect(screen.getByLabelText("diagram")).toBeTruthy();
});

it("shows diagram errors alongside their source", async () => {
  vi.mocked(mermaid.render).mockRejectedValue(new Error("bad syntax\nmore detail"));
  render(<Mermaid code="invalid graph" />);
  await screen.findByText("図の描画に失敗しました: bad syntax");
  expect(screen.getByText("invalid graph")).toBeTruthy();
});

it("ignores an older diagram response after its source changes", async () => {
  const first = deferred<{ svg: string; diagramType: string }>();
  vi.mocked(mermaid.render)
    .mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce({ svg: '<svg aria-label="new"></svg>', diagramType: "flowchart" });
  const { rerender } = render(<Mermaid code="old source" />);
  rerender(<Mermaid code="new source" />);
  await act(async () => {});
  await act(async () =>
    first.resolve({ svg: '<svg aria-label="old"></svg>', diagramType: "flowchart" }),
  );
  expect(screen.getByLabelText("new")).toBeTruthy();
  expect(screen.queryByLabelText("old")).toBeNull();
});

it("sandboxes HTML visuals, restricts network access, and authenticates resize messages", () => {
  render(<HtmlVisual code="<div>animation</div>" />);
  const frame = screen.getByTitle("visual") as HTMLIFrameElement;
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  expect(frame.srcdoc).toContain("default-src 'none'");
  expect(frame.srcdoc).toContain("<div>animation</div>");
  expect(frame.style.height).toBe("420px");
  const token = JSON.parse(frame.srcdoc.match(/var t=(".*?");/)![1]);
  const send = (height: unknown, xplToken = token, source = frame.contentWindow) => {
    act(() =>
      window.dispatchEvent(new MessageEvent("message", { source, data: { height, xplToken } })),
    );
  };
  send(700, "wrong token");
  send(700, token, window);
  send("700");
  expect(frame.style.height).toBe("420px");
  send(500);
  expect(frame.style.height).toBe("504px");
  send(0);
  expect(frame.style.height).toBe("160px");
  send(2000);
  expect(frame.style.height).toBe("900px");
});
