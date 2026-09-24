import assert from "node:assert/strict";
import { extractModel, openaiToCli } from "../dist/adapter/openai-to-cli.js";

const aliases = {
  "claude-opus-5-5": "claude-opus-5-5[context=1m,effort=high,fast=false]",
  "claude-opus-5-5-fast": "claude-opus-5-5[context=1m,effort=high,fast=true]",
  "composer-2.5": "composer-2.5",
  "composer-2.5-fast": "composer-2.5-fast",
  "grok-4.6": "cursor-grok-4.6-high",
  "grok-4.6-fast": "cursor-grok-4.6-high-fast",
  "grok-4.7": "grok-4.7-high",
  "grok-4.7-fast": "grok-4.7-high-fast",
};

for (const [alias, resolved] of Object.entries(aliases)) {
  assert.equal(extractModel(alias), resolved, alias);
}

assert.equal(
  openaiToCli({
    model: "claude-opus-5-5-fast",
    reasoning_effort: "low",
    messages: [{ role: "user", content: "test" }],
  }).model,
  "claude-opus-5-5[context=1m,effort=low,fast=true]",
);

assert.throws(() => extractModel("gpt-5.3-codex"), /Unsupported Cursor model/);
assert.throws(
  () => openaiToCli({ model: "claude-opus-5-5", reasoning_effort: "none", messages: [{ role: "user", content: "test" }] }),
  /Unsupported reasoning effort/,
);

console.log("model mapping tests passed");
