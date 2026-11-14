import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { Setup } from "./Setup";
import { deferred, json, mockFetch } from "./test/helpers";
import type { RepoInfo } from "./types";

const info: RepoInfo = {
  root: "/repo", currentBranch: "feature", branches: ["main", "feature"], defaultBase: "main", workingSummary: "1 changed, 2 untracked",
  commits: [{ sha: "a".repeat(40), subject: "Change", author: "Author", date: "today" }],
  prs: [{ number: 7, title: "PR title", headRefName: "feature", author: "alice" }],
};

async function setup(repo = info) {
  const fetch = mockFetch().mockResolvedValueOnce(json({ defaultRepo: "/repo/subdir" })).mockResolvedValueOnce(json(repo));
  const onStart = vi.fn();
  render(<Setup onStart={onStart} />);
  await waitFor(() => expect((screen.getByRole("button", { name: "解説を始める" }) as HTMLButtonElement).disabled).toBe(false));
  return { fetch, onStart };
}

it("loads the configured repo, encodes paths, and shows its working summary", async () => {
  const { fetch } = await setup();
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(["/api/config", "/api/repo?path=%2Frepo%2Fsubdir"]);
  expect((screen.getByLabelText("リポジトリ") as HTMLInputElement).value).toBe("/repo/subdir");
  expect(screen.getByText("今の変更: 1 changed, 2 untracked")).toBeTruthy();
});

it.each([
  ["作業中の変更", { kind: "working" }],
  ["ブランチ比較", { kind: "branch", base: "main" }],
  ["コミット", { kind: "commit", sha: "a".repeat(40) }],
  ["Pull Request", { kind: "pr", number: 7 }],
])("starts %s with the selected diff and canonical repository root", async (name, source) => {
  const { fetch, onStart } = await setup();
  fireEvent.click(screen.getByRole("radio", { name: new RegExp(`^${name}`) }));
  fireEvent.change(screen.getByLabelText("言語"), { target: { value: "English" } });
  fireEvent.change(screen.getByLabelText("Codex モデル"), { target: { value: "chosen-model" } });
  fetch.mockResolvedValueOnce(json({ id: "session-1" }));
  fireEvent.click(screen.getByRole("button", { name: "解説を始める" }));
  await waitFor(() => expect(onStart).toHaveBeenCalledWith("session-1"));
  const [url, options] = fetch.mock.calls.at(-1)!;
  expect(url).toBe("/api/sessions");
  expect(options?.method).toBe("POST");
  expect(JSON.parse(options!.body as string)).toEqual({ repoPath: "/repo", source, language: "English", model: "chosen-model" });
});

it("lets users choose explicit branch endpoints", async () => {
  const { fetch } = await setup();
  fireEvent.click(screen.getByRole("radio", { name: /ブランチ比較/ }));
  fireEvent.change(screen.getByLabelText("比較元"), { target: { value: "origin/main" } });
  fireEvent.change(screen.getByLabelText("比較先"), { target: { value: "feature" } });
  fetch.mockResolvedValue(json({ id: "s" }));
  fireEvent.click(screen.getByRole("button", { name: "解説を始める" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  expect(JSON.parse(fetch.mock.calls[2][1]!.body as string).source).toEqual({ kind: "branch", base: "origin/main", head: "feature" });
});

it("allows manual PR selection when the GitHub list is unavailable", async () => {
  const { fetch } = await setup({ ...info, prs: [], prError: "offline" });
  fireEvent.click(screen.getByRole("radio", { name: /Pull Request/ }));
  expect(screen.getByText(/一覧を取得できませんでした/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("PR 番号"), { target: { value: "42" } });
  fetch.mockResolvedValue(json({ id: "s" }));
  fireEvent.click(screen.getByRole("button", { name: "解説を始める" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  expect(JSON.parse(fetch.mock.calls[2][1]!.body as string).source).toEqual({ kind: "pr", number: 42 });
});

it("keeps start disabled until repo information is loaded", async () => {
  const repo = deferred<Response>();
  mockFetch().mockResolvedValueOnce(json({ defaultRepo: "/repo" })).mockReturnValueOnce(repo.promise);
  render(<Setup onStart={vi.fn()} />);
  expect((screen.getByRole("button", { name: "解説を始める" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => repo.resolve(json(info)));
  expect((screen.getByRole("button", { name: "解説を始める" }) as HTMLButtonElement).disabled).toBe(false);
});

it("disables duplicate starts and restores the button after a server error", async () => {
  const { fetch, onStart } = await setup();
  const request = deferred<Response>();
  fetch.mockReturnValue(request.promise);
  fireEvent.click(screen.getByRole("button", { name: "解説を始める" }));
  const busy = screen.getByRole("button", { name: "差分を取得しています…" });
  expect((busy as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(busy);
  expect(fetch).toHaveBeenCalledTimes(3);
  await act(async () => request.resolve(json({ error: "invalid revision" }, 400)));
  expect(screen.getByText("invalid revision")).toBeTruthy();
  expect((screen.getByRole("button", { name: "解説を始める" }) as HTMLButtonElement).disabled).toBe(false);
  expect(onStart).not.toHaveBeenCalled();
});

it("displays configuration and repository errors without enabling start", async () => {
  mockFetch().mockResolvedValue(json({}, 500));
  const view = render(<Setup onStart={vi.fn()} />);
  await screen.findByText(/設定を読み込めませんでした/);
  expect((screen.getByRole("button", { name: "解説を始める" }) as HTMLButtonElement).disabled).toBe(true);
  view.unmount();
  mockFetch().mockResolvedValueOnce(json({ defaultRepo: "/invalid" })).mockResolvedValueOnce(json({ error: "not a repository" }, 400));
  render(<Setup onStart={vi.fn()} />);
  await screen.findByText("not a repository");
  expect((screen.getByRole("button", { name: "解説を始める" }) as HTMLButtonElement).disabled).toBe(true);
});

it("reloads a changed path using Enter and URL-encodes special characters", async () => {
  const { fetch } = await setup();
  fetch.mockResolvedValue(json(info));
  const input = screen.getByLabelText("リポジトリ");
  fireEvent.change(input, { target: { value: "/repo #two" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(fetch).toHaveBeenLastCalledWith("/api/repo?path=%2Frepo%20%23two"));
});
