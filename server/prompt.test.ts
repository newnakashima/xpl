import assert from "node:assert/strict";
import { test } from "node:test";
import { initialPrompt, INLINE_DIFF_LIMIT, proseLimits, systemPrompt } from "./prompt.js";
import { parseDiff } from "./git.js";

test("prompts use language-specific budgets and include the selected language", () => {
  for (const lang of ["日本語", "中文", "한국어", "Japanese", "Chinese", "Korean"]) {
    assert.deepEqual(proseLimits(lang), { soft: 200, hard: 360, answerHard: 900 });
  }
  for (const lang of ["English", "Français"]) {
    assert.deepEqual(proseLimits(lang), { soft: 450, hard: 850, answerHard: 2000 });
    assert.ok(systemPrompt(lang).includes(`Write all prose in ${lang}`));
  }
});

test("small initial prompts include metadata, context, file IDs, and annotated code", () => {
  const files = parseDiff(
    "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
  );
  const prompt = initialPrompt({
    title: "Selected change",
    description: "Rationale",
    files,
    raw: "",
  });
  assert.match(prompt, /# Diff to explain: Selected change/);
  assert.match(prompt, /## Context\nRationale/);
  assert.match(prompt, /## Files \(1\)/);
  assert.match(prompt, /\[F1H1\]/);
  assert.match(prompt, /    1 \+new/);
});

test("large prompts retain the file index, omit oversized code, and bound contextual metadata", () => {
  const content = "x".repeat(INLINE_DIFF_LIMIT + 1);
  const files = parseDiff(`diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+${content}\n`);
  const prompt = initialPrompt({
    title: "Large",
    description: "d".repeat(8000) + "SHOULD_BE_TRUNCATED",
    files,
    raw: "",
  });
  assert.match(prompt, /not inlined/);
  assert.match(prompt, /get_diff/);
  assert.match(prompt, /\[F1\].*F1H1/);
  assert.ok(!prompt.includes(content));
  assert.ok(!prompt.includes("SHOULD_BE_TRUNCATED"));
});
