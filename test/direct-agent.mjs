import assert from "node:assert/strict";
import { CursorAgentTransport, resetCursorTransportSessions } from "../dist/cursor/transport.js";

let runCount = 0;
const createAgent = async () => ({
  async send(_prompt, options) {
    runCount += 1;
    if (runCount === 1) {
      assert.equal(typeof _prompt, "object");
      assert.equal(_prompt.images?.[0]?.mimeType, "image/png");
    }
    const resultPromise = (async () => {
      const tools = options.local?.customTools ?? {};
      if (runCount === 1) {
        const tool = tools.lookup;
        assert.ok(tool, "custom tool was not registered");
        await tool.execute({ query: "demo" }, { toolCallId: "call_demo" });
        options.onDelta?.({ update: { type: "text-delta", text: "Tool result received." } });
      } else {
        options.onDelta?.({ update: { type: "text-delta", text: "Done." } });
      }
      return { status: "finished" };
    })();
    return { wait: () => resultPromise, async cancel() {} };
  },
  close() {},
});

resetCursorTransportSessions();
const transport = new CursorAgentTransport({ createAgent });
const tool = {
  type: "function",
  name: "lookup",
  description: "Look something up",
  parameters: { type: "object", properties: { query: { type: "string" } } },
};
const first = await transport.execute("test-session", {
  model: "claude-opus-5-5",
  messages: [{ role: "user", content: [
    { type: "text", text: "Use lookup." },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
  ] }],
  tools: [tool],
});
assert.equal(first.status, "tool_calls");
assert.equal(first.toolCalls[0]?.function.name, "lookup");

const second = await transport.execute("test-session", {
  model: "claude-opus-5-5",
  messages: [
    { role: "user", content: "Use lookup." },
    { role: "assistant", content: null, tool_calls: [{ ...first.toolCalls[0], id: "call_axon_alias" }] },
    { role: "tool", tool_call_id: "call_axon_alias", content: "demo result" },
  ],
  tools: [tool],
});
assert.equal(second.status, "finished");
assert.equal(second.text, "Tool result received.");
console.log("direct AgentService pause/resume test passed");
