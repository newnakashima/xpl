#!/usr/bin/env node
// Usage: xpl [repoPath]   — builds the UI if needed, then starts the server and opens the browser.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(process.argv[2] || process.cwd());
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

if (!existsSync(path.join(root, "dist", "index.html"))) {
  const r = spawnSync(npx, ["vite", "build"], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
const port = process.env.PORT || "4777";
const child = spawn(npx, ["tsx", path.join(root, "server", "index.ts"), repo], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, PORT: port },
});
setTimeout(() => {
  const url = `http://localhost:${port}`;
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(opener, [url], { stdio: "ignore", shell: process.platform === "win32" }).on(
    "error",
    () => {},
  );
}, 1500);
child.on("exit", (c) => process.exit(c ?? 0));
