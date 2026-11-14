import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Session } from "./session.js";
import { SessionRegistry } from "./sessions.js";

function session() {
  return new Session({
    repoRoot: process.cwd(),
    language: "日本語",
    diff: { title: "test", raw: "", files: [] },
  });
}

test("an abandoned session releases its agent after the reconnect grace period", async () => {
  const registry = new SessionRegistry(20);
  const s = session();
  registry.add(s);
  const disconnect = registry.subscribe(s.id);
  await delay(50);
  assert.equal(s.isClosed, false);
  disconnect();
  await delay(50);
  assert.equal(registry.get(s.id), undefined);
  assert.equal(s.isClosed, true);
});

test("reconnecting or keeping another tab open prevents premature agent cleanup", async () => {
  const registry = new SessionRegistry(20);
  const s = session();
  registry.add(s);
  const first = registry.subscribe(s.id);
  first();
  const second = registry.subscribe(s.id);
  const third = registry.subscribe(s.id);
  second();
  second(); // Releasing the same connection twice must not close another tab.
  await delay(50);
  assert.equal(s.isClosed, false);
  third();
  await delay(50);
  assert.equal(s.isClosed, true);
});

test("sessions whose browser never connects are eventually released", async () => {
  const registry = new SessionRegistry(20);
  const s = session();
  registry.add(s);
  await delay(50);
  assert.equal(registry.get(s.id), undefined);
  assert.equal(s.isClosed, true);
});

test("explicit deletion and shutdown release connected sessions immediately", () => {
  const registry = new SessionRegistry();
  const first = session();
  const second = session();
  registry.add(first);
  registry.add(second);
  const disconnect = registry.subscribe(first.id);
  registry.delete(first.id);
  disconnect();
  assert.equal(first.isClosed, true);
  assert.equal(second.isClosed, false);
  registry.close();
  assert.equal(second.isClosed, true);
  assert.equal(registry.get(second.id), undefined);
});
