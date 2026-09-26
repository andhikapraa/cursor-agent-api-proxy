import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  buildAgentRequestBody,
  decodeProtobufValue,
  iterateConnectFrames,
  jsonSchemaToProtobufValue,
  openAIToolsToMcpDefs,
  wrapConnectFrame,
} from "../dist/cursor/cursorAgentProtobuf.js";
import { CursorAgentTransport, resetCursorTransportSessions } from "../dist/cursor/transport.js";

const enc = new TextEncoder();
const fieldBytes = (field, bytes) => {
  const value = Buffer.from(bytes);
  return Buffer.concat([Buffer.from([field << 3 | 2, value.length]), value]);
};
const fieldString = (field, value) => fieldBytes(field, enc.encode(value));
const fieldMessage = (field, value) => fieldBytes(field, value);
const fieldVarint = (field, value) => Buffer.from([field << 3, value]);

class FakeStream extends EventEmitter {
  destroyed = false;
  closed = false;
  writes = [];
  write(value) {
    this.writes.push(Buffer.from(value));
    return true;
  }
  close() {
    this.closed = true;
  }
}

class FakeClient extends EventEmitter {
  stream = new FakeStream();
  close() {
    this.closed = true;
  }
  request() {
    return this.stream;
  }
}

function serverTextFrame(text) {
  const textDelta = fieldString(1, text);
  const interaction = fieldMessage(1, textDelta);
  return wrapConnectFrame(fieldMessage(1, interaction));
}

function serverTurnEndedFrame() {
  const interaction = fieldVarint(14, 1);
  return wrapConnectFrame(fieldMessage(1, interaction));
}

function requestContextFrame() {
  const execMessage = Buffer.concat([fieldVarint(1, 7), fieldMessage(10, Buffer.alloc(0))]);
  return wrapConnectFrame(fieldMessage(2, execMessage));
}

function mcpFrame() {
  const value = jsonSchemaToProtobufValue("ok");
  const argsEntry = Buffer.concat([fieldString(1, "answer"), fieldBytes(2, value)]);
  const mcpArgs = Buffer.concat([
    fieldString(3, "cursor-call-id"),
    fieldString(5, "lookup"),
    fieldMessage(2, argsEntry),
  ]);
  const execMessage = Buffer.concat([
    fieldVarint(1, 9),
    fieldString(15, "cursor-exec-id"),
    fieldMessage(11, mcpArgs),
  ]);
  return wrapConnectFrame(fieldMessage(2, execMessage));
}

const plainFrame = wrapConnectFrame(Buffer.from("plain"), true);
const [decoded] = [...iterateConnectFrames(plainFrame)];
assert.equal(decoded.payload.toString(), "plain", "gzip Connect framing round-trips");
assert.equal(decodeProtobufValue(jsonSchemaToProtobufValue({ ok: true })).ok, true);
const defs = openAIToolsToMcpDefs([{
  type: "function",
  function: { name: "lookup", description: "Look up", parameters: { type: "object" } },
}]);
assert.equal(defs[0].name, "lookup");
assert.equal(defs[0].providerIdentifier, "omniroute");
const requestFrame = [...iterateConnectFrames(buildAgentRequestBody({
  modelId: "claude-opus-5-5",
  conversationId: "conversation",
  userText: "hello",
  tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
}))][0];
assert.ok(requestFrame?.payload.length > 0, "AgentRunRequest is framed");

const client = new FakeClient();
const transport = new CursorAgentTransport({
  connect: () => {
    queueMicrotask(() => {
      client.stream.emit("response", { ":status": 200 });
      queueMicrotask(() => {
        client.stream.emit("data", Buffer.concat([
          requestContextFrame(),
          serverTextFrame("hello"),
          serverTurnEndedFrame(),
        ]));
      });
    });
    return client;
  },
});
const textDeltas = [];
const textResult = await transport.execute("protocol-text", {
  messages: [{ role: "user", content: "hello" }],
}, { onText: (value) => textDeltas.push(value) });
assert.equal(textResult.text, "hello");
assert.deepEqual(textDeltas, ["hello"]);
assert.ok(client.stream.writes.length >= 2, "request context is acknowledged on H2 stream");

resetCursorTransportSessions();
const toolClient = new FakeClient();
const originalToolWrite = toolClient.stream.write.bind(toolClient.stream);
toolClient.stream.write = (value) => {
  const result = originalToolWrite(value);
  if (toolClient.stream.writes.length > 1) {
    queueMicrotask(() => toolClient.stream.emit("data", Buffer.concat([
      serverTextFrame("done"),
      serverTurnEndedFrame(),
    ])));
  }
  return result;
};
const toolTransport = new CursorAgentTransport({
  connect: () => {
    queueMicrotask(() => {
      toolClient.stream.emit("response", { ":status": 200 });
      queueMicrotask(() => toolClient.stream.emit("data", mcpFrame()));
    });
    return toolClient;
  },
});
const toolResult = await toolTransport.execute("protocol-tool", {
  tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
  messages: [{ role: "user", content: "lookup" }],
});
assert.equal(toolResult.status, "tool_calls");
assert.equal(toolResult.toolCalls[0].function.name, "lookup");
assert.equal(toolResult.toolCalls[0].function.arguments, JSON.stringify({ answer: "ok" }));
assert.equal(toolClient.stream.closed, false, "tool-call stream remains open for continuation");
const continuation = await toolTransport.execute("protocol-tool", {
  tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
  messages: [
    { role: "user", content: "lookup" },
    { role: "assistant", content: null, tool_calls: toolResult.toolCalls },
    { role: "tool", tool_call_id: toolResult.toolCalls[0].id, content: "found" },
  ],
});
assert.equal(continuation.text, "done");
assert.equal(continuation.status, "finished");
resetCursorTransportSessions();
console.log("raw protocol smoke tests passed");
