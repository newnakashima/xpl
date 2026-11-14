import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function launcher(t: TestContext, built: boolean) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "xpl-cli-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "bin"));
  const entry = path.join(root, "bin", "xpl.mjs");
  await copyFile(fileURLToPath(new URL("../bin/xpl.mjs", import.meta.url)), entry);
  if (built) {
    await mkdir(path.join(root, "dist"));
    await writeFile(path.join(root, "dist", "index.html"), "fixture");
  }
  const log = path.join(root, "calls.jsonl");
  const npx = path.join(root, "bin", "npx");
  await writeFile(npx, `#!${process.execPath}
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args, cwd: process.cwd(), port: process.env.PORT}) + "\\n");
process.exit(Number(args[0] === "vite" ? process.env.TEST_BUILD_EXIT || 0 : process.env.TEST_SERVER_EXIT || 0));
`);
  // The shim is extensionless; ensure Node treats it as an ES module.
  await writeFile(path.join(root, "package.json"), '{"type":"module"}');
  await chmod(npx, 0o755);
  // Never let a regression in launcher timing open an actual browser.
  for (const opener of ["open", "xdg-open"]) {
    const target = path.join(root, "bin", opener);
    await writeFile(target, `#!${process.execPath}\nprocess.exit(0);\n`);
    await chmod(target, 0o755);
  }
  const run = async (args: string[] = [], env: NodeJS.ProcessEnv = {}) => {
    let code = 0;
    try {
      await promisify(execFile)(process.execPath, [entry, ...args], {
        cwd: root, timeout: 5000,
        env: { ...process.env, PORT: "", PATH: `${path.join(root, "bin")}${path.delimiter}${process.env.PATH}`, ...env },
      });
    } catch (error: any) { if (typeof error.code !== "number") throw error; code = error.code; }
    const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    return { code, calls };
  };
  return { root, run };
}

test("CLI builds a missing UI, resolves the repository argument, and passes the chosen port", async (t) => {
  const cli = await launcher(t, false);
  const { code, calls } = await cli.run(["relative repo"], { PORT: "4888" });
  assert.equal(code, 0);
  assert.deepEqual(calls.map((call) => call.args), [
    ["vite", "build"], ["tsx", path.join(cli.root, "server", "index.ts"), path.join(cli.root, "relative repo")],
  ]);
  assert.equal(calls[1].port, "4888");
  assert.ok(calls.every((call) => call.cwd === cli.root));
});

test("CLI reuses an existing build and defaults to the current directory and port", async (t) => {
  const cli = await launcher(t, true);
  const { code, calls } = await cli.run();
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["tsx", path.join(cli.root, "server", "index.ts"), cli.root]);
  assert.equal(calls[0].port, "4777");
});

test("CLI stops on a build failure and propagates its exit code", async (t) => {
  const cli = await launcher(t, false);
  const { code, calls } = await cli.run([], { TEST_BUILD_EXIT: "7" });
  assert.equal(code, 7);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["vite", "build"]);
});

test("CLI propagates server failures to its caller", async (t) => {
  const cli = await launcher(t, true);
  const { code } = await cli.run([], { TEST_SERVER_EXIT: "9" });
  assert.equal(code, 9);
});
