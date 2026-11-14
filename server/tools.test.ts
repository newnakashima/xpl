import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { tool } from "./tools.js";

test("tools validate before invoking handlers and pass parsed defaults and transformed values", async () => {
  const received: unknown[] = [];
  const definition = tool("example", "example tool", { name: z.string().trim(), count: z.number().int().default(2) }, async (input) => {
    received.push(input);
    return { content: [{ type: "text", text: "saved" }] };
  });
  assert.throws(() => definition.handler({ name: 42 }), z.ZodError);
  assert.deepEqual(received, []);
  assert.deepEqual(await definition.handler({ name: " value ", extra: "ignored" }), { content: [{ type: "text", text: "saved" }] });
  assert.deepEqual(received, [{ name: "value", count: 2 }]);
  const schema = z.toJSONSchema(definition.inputSchema);
  assert.equal(schema.type, "object");
});

test("tools preserve handler errors for the transport to report", async () => {
  const failure = new Error("read failed");
  const definition = tool("broken", "broken tool", {}, async () => { throw failure; });
  await assert.rejects(definition.handler({}), (error) => error === failure);
});
