import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
