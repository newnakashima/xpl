import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { json, mockFetch } from "./test/helpers";

vi.mock("react-dom/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-dom/client")>();
  return { ...original, createRoot: vi.fn(original.createRoot) };
});
vi.mock("./Setup", () => ({ Setup: ({ onStart }: { onStart: (id: string) => void }) => <button onClick={() => onStart("new-session")}>Start explanation</button> }));
vi.mock("./SessionView", () => ({ SessionView: ({ id, onExit }: { id: string; onExit: () => void }) => <div><p>{id}</p><button onClick={onExit}>Exit explanation</button></div> }));

it("restores sessions from the URL, releases them on exit, and records newly selected sessions", async () => {
  const fetch = mockFetch().mockResolvedValue(json({ ok: true }));
  const container = document.createElement("div");
  container.id = "root";
  document.body.append(container);
  history.replaceState(null, "", "/?s=restored-session");
  try {
    await act(async () => { await import("./main"); });
    expect(screen.getByText("restored-session")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Exit explanation" }));
    await screen.findByRole("button", { name: "Start explanation" });
    expect(fetch).toHaveBeenCalledWith("/api/sessions/restored-session", { method: "DELETE", keepalive: true });
    expect(location.search).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Start explanation" }));
    await screen.findByText("new-session");
    await waitFor(() => expect(location.search).toBe("?s=new-session"));
    fireEvent.click(screen.getByRole("button", { name: "Exit explanation" }));
    expect(fetch).toHaveBeenLastCalledWith("/api/sessions/new-session", { method: "DELETE", keepalive: true });
  } finally {
    const root = vi.mocked(createRoot).mock.results[0]?.value;
    act(() => root?.unmount());
    container.remove();
    history.replaceState(null, "", "/");
  }
});
