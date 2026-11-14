import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { Markdown } from "./Markdown";

it("renders Markdown while sanitizing executable HTML and unsafe links", () => {
  const { container } = render(<Markdown text={'**safe**\n\n[docs](https://example.com)\n\n<script>alert(1)</script><img src="x" onerror="alert(1)"><a href="javascript:alert(1)">unsafe</a>'} />);
  expect(screen.getByText("safe").tagName).toBe("STRONG");
  expect(screen.getByRole("link", { name: "docs" }).getAttribute("href")).toBe("https://example.com");
  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector("img")?.getAttribute("onerror")).toBeNull();
  expect(screen.getByText("unsafe").getAttribute("href")).toBeNull();
});

it("updates sanitized content when the text changes", () => {
  const { rerender } = render(<Markdown text="old" className="overview" />);
  rerender(<Markdown text="`new`" className="overview" />);
  expect(screen.queryByText("old")).toBeNull();
  expect(screen.getByText("new").tagName).toBe("CODE");
  expect(screen.getByText("new").closest(".overview")).toBeTruthy();
});
