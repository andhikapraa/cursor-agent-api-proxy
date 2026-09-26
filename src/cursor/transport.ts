/**
 * Raw Cursor AgentService/Run transport.
 *
 * The high-level @cursor/sdk executes Cursor's built-in tools locally. That is
 * not useful for this proxy: Axon owns tool execution and the SDK can finish a
 * turn without forwarding any assistant text. This transport speaks the
 * bidirectional Connect-RPC stream directly so every server message is
 * observed and acknowledged on the same HTTP/2 stream.
 */

import * as crypto from "node:crypto";
import * as http2 from "node:http2";
import * as zlib from "node:zlib";
import {
  buildAgentRequestBody,
  decodeAgentServerMessage,
  decodeExecServerEvent,
  decodeKvServerEvent,
  encodeExecBackgroundShellSpawnRejected,
  encodeExecDeleteRejected,
  encodeExecDiagnosticsResult,
  encodeExecFetchError,
  encodeExecGrepError,
  encodeExecLsRejected,
  encodeExecReadRejected,
  encodeExecShellRejected,
  encodeExecWriteRejected,
  encodeExecWriteShellStdinError,
  encodeKvGetBlobResult,
  encodeKvSetBlobResult,
  encodeRequestContextResponse,
  flattenMessages,
  openAIToolsToMcpDefs,
  type ChatMessage,
  type ExecServerEvent,
  type McpToolDefinition,
} from "./cursorAgentProtobuf.js";
import {
  cursorSessionManager,
  type CursorSession,
} from "./cursorSessionManager.js";
import type {
  OpenAIChatMessage,
  OpenAIChatRequest,
  OpenAITool,
  OpenAIToolCall,
} from "../types/openai.js";

export interface CursorTransportCallbacks {
  onText?: (text: string) => void;
  onReasoning?: (text: string) => void;
  onToolCall?: (call: OpenAIToolCall) => void;
}

export interface CursorTransportResult {
  text: string;
  reasoning: string;
  toolCalls: OpenAIToolCall[];
  status: "finished" | "tool_calls" | "server_end";
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface CursorTransportDependencies {
  /** Test seam for protocol tests; production uses node:http2.connect. */
  connect?: typeof http2.connect;
}

type H2Stream = http2.ClientHttp2Stream;
type H2Client = http2.ClientHttp2Session;

type OpenedStream = {
  client: H2Client;
  req: H2Stream;
  status: number;
  takeInitialBytes: () => Buffer;
  consumeError: () => Promise<Buffer>;
};

type EndReason = "turn_ended" | "kv_after_text" | "tool_calls" | "server_end" | null;
let cachedCursorToken: { token: string; expiresAt: number } | undefined;

async function resolveCursorAccessToken(apiKey: string | undefined): Promise<string | undefined> {
  if (!apiKey) return undefined;
  if (!apiKey.startsWith("crsr_")) return apiKey;
  if (cachedCursorToken && cachedCursorToken.expiresAt > Date.now() + 60_000) return cachedCursorToken.token;
  const response = await fetch("https://api2.cursor.sh/auth/exchange_user_api_key", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: "{}",
  });
  if (!response.ok) throw new Error(`Cursor API-key exchange failed: HTTP ${response.status}`);
  const data = await response.json() as { accessToken?: string };
  if (!data.accessToken) throw new Error("Cursor API-key exchange returned no access token");
  let expiresAt = Date.now() + 50 * 60_000;
  try {
    const payload = JSON.parse(Buffer.from(data.accessToken.split(".")[1]!, "base64url").toString("utf8"));
    if (Number.isFinite(payload.exp)) expiresAt = payload.exp * 1000;
  } catch {}
  cachedCursorToken = { token: data.accessToken, expiresAt };
  return data.accessToken;
}

const CURSOR_AGENT_HOST = process.env.CURSOR_AGENT_HOST?.trim() || "agentn.global.api5.cursor.sh";
const CURSOR_AGENT_PATH = "/agent.v1.AgentService/Run";
const CURSOR_STREAM_TIMEOUT_MS = Number.parseInt(process.env.CURSOR_STREAM_TIMEOUT_MS || "300000", 10);
const BUILTIN_TOOL_REJECT_REASON =
  "Tool not available in this environment. Use the MCP tools provided instead.";

function contentToText(content: OpenAIChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part.type === "text" ? part.text ?? "" : "").join("\n");
}

function normalizedTools(tools: OpenAITool[] | undefined): OpenAITool[] {
  return (tools ?? []).flatMap((tool) => {
    if (tool.type !== "function") return [];
    const fn = tool.function ?? (tool.name ? {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    } : undefined);
    return fn?.name ? [{ type: "function", function: fn }] : [];
  });
}

function systemPrompt(messages: OpenAIChatMessage[]): string | undefined {
  const value = messages
    .filter((message) => message.role === "system")
    .map((message) => contentToText(message.content))
    .filter(Boolean)
    .join("\n\n");
  return value || undefined;
}

function stableConversationId(key: string): string {
  const hex = crypto.createHash("sha256").update(key).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((Number.parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

function requestHeaders(apiKey: string | undefined): Record<string, string> {
  const requestId = crypto.randomUUID();
  const traceParent = `00-${crypto.randomBytes(16).toString("hex")}-${crypto.randomBytes(8).toString("hex")}-01`;
  const headers: Record<string, string> = {
    "connect-accept-encoding": "gzip",
    "connect-protocol-version": "1",
    "content-type": "application/connect+proto",
    "user-agent": "connect-es/1.6.1",
    "x-cursor-client-type": "cli",
    "x-cursor-client-version": "cli-1.0.0",
    "x-ghost-mode": "true",
    "x-original-request-id": requestId,
    "x-request-id": requestId,
    "backend-traceparent": traceParent,
    traceparent: traceParent,
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey.includes("::") ? apiKey.split("::").pop() : apiKey}`;
  return headers;
}

function toolsForRequest(request: OpenAIChatRequest): McpToolDefinition[] {
  return openAIToolsToMcpDefs(normalizedTools(request.tools).map((tool) => ({
    type: "function",
    function: tool.function!,
  })));
}

function writeFrame(req: H2Stream, frame: Buffer): void {
  if (req.destroyed || req.closed) throw new Error("Cursor AgentService stream is closed");
  req.write(frame);
}

function buildBuiltinRejection(event: ExecServerEvent): Buffer | null {
  switch (event.kind) {
    case "exec_request_context":
    case "exec_mcp":
      return null;
    case "exec_read":
      return encodeExecReadRejected(event.execMsgId, event.execId, event.path, BUILTIN_TOOL_REJECT_REASON);
    case "exec_write":
      return encodeExecWriteRejected(event.execMsgId, event.execId, event.path, BUILTIN_TOOL_REJECT_REASON);
    case "exec_delete":
      return encodeExecDeleteRejected(event.execMsgId, event.execId, event.path, BUILTIN_TOOL_REJECT_REASON);
    case "exec_ls":
      return encodeExecLsRejected(event.execMsgId, event.execId, event.path, BUILTIN_TOOL_REJECT_REASON);
    case "exec_grep":
      return encodeExecGrepError(event.execMsgId, event.execId, BUILTIN_TOOL_REJECT_REASON);
    case "exec_diagnostics":
      return encodeExecDiagnosticsResult(event.execMsgId, event.execId);
    case "exec_shell":
    case "exec_shell_stream":
      return encodeExecShellRejected(event.execMsgId, event.execId, event.command, event.workingDir, BUILTIN_TOOL_REJECT_REASON);
    case "exec_bg_shell":
      return encodeExecBackgroundShellSpawnRejected(event.execMsgId, event.execId, event.command, event.workingDir, BUILTIN_TOOL_REJECT_REASON);
    case "exec_fetch":
      return encodeExecFetchError(event.execMsgId, event.execId, event.url, BUILTIN_TOOL_REJECT_REASON);
    case "exec_write_shell_stdin":
      return encodeExecWriteShellStdinError(event.execMsgId, event.execId, BUILTIN_TOOL_REJECT_REASON);
  }
}

function closeH2(client: H2Client, req: H2Stream): void {
  try { req.close(); } catch {}
  try { client.close(); } catch {}
}

function openH2(
  connect: typeof http2.connect,
  body: Buffer,
  apiKey: string | undefined,
): Promise<OpenedStream> {
  const authority = `https://${CURSOR_AGENT_HOST}`;
  return new Promise((resolve, reject) => {
    let client: H2Client;
    try {
      client = connect(authority);
    } catch (error) {
      reject(error);
      return;
    }
    const earlyChunks: Buffer[] = [];
    let responseSeen = false;
    let settled = false;
    let collecting = true;
    let req: H2Stream;
    const onEarlyData = (chunk: Buffer): void => {
      if (collecting) earlyChunks.push(Buffer.from(chunk));
    };
    const fail = (error: Error): void => {
      if (!settled) {
        settled = true;
        closeH2(client, req);
        reject(error);
      }
    };
    client.once("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
    try {
      req = client.request({
        ":method": "POST",
        ":scheme": "https",
        ":authority": CURSOR_AGENT_HOST,
        ":path": CURSOR_AGENT_PATH,
        ...requestHeaders(apiKey),
      });
    } catch (error) {
      closeH2(client, {} as H2Stream);
      reject(error);
      return;
    }
    req.on("data", onEarlyData);
    req.once("response", (headers) => {
      responseSeen = true;
      if (settled) return;
      settled = true;
      const status = Number(headers[":status"] ?? 500);
      const takeInitialBytes = (): Buffer => {
        collecting = false;
        req.off("data", onEarlyData);
        return Buffer.concat(earlyChunks);
      };
      const consumeError = (): Promise<Buffer> => {
        const initial = takeInitialBytes();
        return new Promise((done) => {
          const chunks = [initial];
          const finish = (): void => {
            req.off("end", finish);
            req.off("error", onError);
            closeH2(client, req);
            done(Buffer.concat(chunks));
          };
          const onError = (): void => finish();
          req.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
          req.once("end", finish);
          req.once("error", onError);
        });
      };
      resolve({ client, req, status, takeInitialBytes, consumeError });
    });
    const onError = (error: Error): void => {
      if (!responseSeen) fail(error);
    };
    req.once("error", onError);
    try {
      // AgentService/Run is bidirectional. Do not end our side after the
      // request frame: Cursor writes context/KV/tool acknowledgements back
      // into this same stream while it generates the turn.
      req.write(body);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function parseFrames(
  buffer: Buffer,
  onFrame: (payload: Buffer) => void,
): Buffer {
  let offset = 0;
  while (offset + 5 <= buffer.length) {
    const flags = buffer[offset]!;
    const length = buffer.readUInt32BE(offset + 1);
    if (offset + 5 + length > buffer.length) break;
    const raw = buffer.subarray(offset + 5, offset + 5 + length);
    const payload = flags & 1 ? zlib.gunzipSync(raw) : raw;
    onFrame(payload);
    offset += 5 + length;
  }
  return offset > 0 ? buffer.subarray(offset) : buffer;
}

export class CursorAgentTransport {
  private readonly connect: typeof http2.connect;

  constructor(deps: CursorTransportDependencies = {}) {
    this.connect = deps.connect ?? http2.connect;
  }

  async execute(
    sessionKey: string,
    request: OpenAIChatRequest,
    callbacks: CursorTransportCallbacks = {},
  ): Promise<CursorTransportResult> {
    const conversationId = stableConversationId(sessionKey);
    const model = request.model || "claude-opus-5-5";
    const apiKey = process.env.CURSOR_API_KEY?.trim();
    const tools = toolsForRequest(request);
    const lastMessage = request.messages[request.messages.length - 1];
    let session: CursorSession | undefined;
    let stream!: OpenedStream | { client: H2Client; req: H2Stream; takeInitialBytes: () => Buffer };

    if (lastMessage?.role === "tool") session = cursorSessionManager.acquire(conversationId);
    if (session) {
      let matched = 0;
      for (const message of request.messages) {
        if (message.role !== "tool") continue;
        let callId = message.tool_call_id ?? "";
        if (!session.pendingToolCalls.has(callId)) {
          // Some Axon adapters rewrite toolu_* IDs. Pair by the declared
          // assistant call's function name when the id is unavailable.
          const assistant = [...request.messages].reverse().find((candidate) => candidate.role === "assistant");
          const callName = assistant?.tool_calls?.find((call) => call.id === callId)?.function.name;
          const candidate = [...session.pendingToolCalls.entries()].find(([, pending]) =>
            (!callName || pending.toolName === callName));
          callId = candidate?.[0] ?? callId;
        }
        if (!callId || !session.pendingToolCalls.has(callId)) continue;
        const content = contentToText(message.content);
        const pending = session.pendingToolCalls.get(callId)!;
        if (cursorSessionManager.sendToolResult(session, callId, content, false)) matched += 1;
        else throw new Error(`Unable to send Cursor tool result for ${pending.toolName}`);
      }
      if (matched > 0) {
        stream = {
          client: session.h2Client,
          req: session.h2Req,
          takeInitialBytes: () => Buffer.alloc(0),
        };
      } else {
        cursorSessionManager.close(session);
        session = undefined;
      }
    }

    if (!session) {
      const blobStore = new Map<string, Buffer>();
      const messageList = request.messages as unknown as ChatMessage[];
      const body = buildAgentRequestBody({
        modelId: model,
        userText: flattenMessages(messageList),
        conversationId,
        tools: normalizedTools(request.tools).map((tool) => ({
          type: "function",
          function: tool.function!,
        })),
        systemPrompt: systemPrompt(request.messages),
        blobStore,
      });
      const accessToken = await resolveCursorAccessToken(apiKey);
      const opened = await openH2(this.connect, body, accessToken);
      if (opened.status !== 200) {
        const errorBody = await opened.consumeError();
        throw new Error(`Cursor AgentService returned HTTP ${opened.status}: ${errorBody.toString("utf8") || "upstream error"}`);
      }
      stream = opened;
      session = cursorSessionManager.open(conversationId, opened.client, opened.req, blobStore);
    }

    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolCalls: OpenAIToolCall[] = [];
    let tokenCount = 0;
    let endReason: EndReason = null;
    const pending = new Map<string, { execMsgId: number; execId: string; toolName: string }>();
    const acked = new Set<string>();
    let sawText = false;
    let buffer = stream.takeInitialBytes();

    try {
      await new Promise<void>((resolve, reject) => {
        let done = false;
        const finish = (error?: Error): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          stream.req.off("data", onData);
          stream.req.off("end", onEnd);
          stream.req.off("error", onError);
          stream.client.off("error", onClientError);
          if (error) reject(error);
          else resolve();
        };
        const timer = setTimeout(() => finish(new Error("Cursor AgentService stream timed out")), CURSOR_STREAM_TIMEOUT_MS);
        const onClientError = (error: Error): void => finish(error);
        const onError = (error: Error): void => finish(error);
        const onEnd = (): void => {
          if (!endReason) endReason = "server_end";
          finish();
        };
        const onFrame = (payload: Buffer): void => {
          let kvEvent;
          try {
            kvEvent = decodeKvServerEvent(payload);
          } catch {
            kvEvent = null;
          }
          if (kvEvent) {
            try {
              if (kvEvent.kind === "kv_get_blob") {
                const blob = session?.blobStore.get(kvEvent.blobId.toString("hex")) ?? Buffer.alloc(0);
                writeFrame(stream.req, encodeKvGetBlobResult(kvEvent.kvId, blob, kvEvent.requestMetadata));
              } else {
                session?.blobStore.set(kvEvent.blobId.toString("hex"), kvEvent.blobData);
                writeFrame(stream.req, encodeKvSetBlobResult(kvEvent.kvId, kvEvent.requestMetadata));
              }
            } catch (error) {
              finish(error instanceof Error ? error : new Error(String(error)));
              return;
          }
          }
          let event;
          try {
            event = decodeExecServerEvent(payload);
          } catch {
            event = null;
          }
          if (event) {
            if (process.env.CURSOR_DEBUG === "1") console.error("[cursor-raw] exec", event.kind, event.kind === "exec_mcp" ? event.toolName : "");
            const dedupe = `${event.kind}:${event.execId}:${event.execMsgId}`;
            if (!acked.has(dedupe)) {
              acked.add(dedupe);
              if (event.kind === "exec_request_context") {
                // MCP definitions are carried by AgentRunRequest.mcp_tools.
                // Cursor expects an empty RequestContext success here.
                writeFrame(stream.req, encodeRequestContextResponse(event.execMsgId, event.execId, tools));
              } else if (event.kind === "exec_mcp") {
                const id = event.toolCallId || `call_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
                const call: OpenAIToolCall = {
                  id,
                  type: "function",
                  function: { name: event.toolName, arguments: JSON.stringify(event.args ?? {}) },
                };
                toolCalls.push(call);
                pending.set(id, {
                  execMsgId: event.execMsgId,
                  execId: event.execId,
                  toolName: event.toolName,
                });
                callbacks.onToolCall?.(call);
                endReason = "tool_calls";
              } else {
                const rejection = buildBuiltinRejection(event);
                if (rejection) writeFrame(stream.req, rejection);
              }
            }
          }
          let deltas: Array<{ kind: string; text?: string; tokens?: number }> = [];
          try {
            deltas = decodeAgentServerMessage(payload);
          } catch {
            deltas = [];
          }
          for (const delta of deltas) {
            if (delta.kind === "text" && delta.text) {
              textParts.push(delta.text);
              sawText = true;
              callbacks.onText?.(delta.text);
            } else if (delta.kind === "thinking" && delta.text) {
              reasoningParts.push(delta.text);
              callbacks.onReasoning?.(delta.text);
            } else if (delta.kind === "token_delta") {
              tokenCount += delta.tokens ?? 0;
            } else if (delta.kind === "turn_ended") {
              endReason = "turn_ended";
            } else if (delta.kind === "kv_server_message" && sawText) {
              endReason = "kv_after_text";
            }
          }
          if (endReason) finish();
        };
        const onData = (chunk: Buffer): void => {
          try {
            buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
            buffer = parseFrames(buffer, onFrame);
            if (endReason) finish();
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        };
        stream.client.on("error", onClientError);
        stream.req.on("data", onData);
        stream.req.once("end", onEnd);
        stream.req.once("error", onError);
        if (buffer.length > 0) onData(Buffer.alloc(0));
      });

      if (!endReason) endReason = "server_end";
      for (const [id, info] of pending) session.pendingToolCalls.set(id, info);
      if (toolCalls.length > 0) {
        cursorSessionManager.release(session, "awaiting_tool_result");
      } else {
        cursorSessionManager.close(session);
      }
    } catch (error) {
      cursorSessionManager.close(session);
      throw error;
    }

    const text = textParts.join("");
    const reasoning = reasoningParts.join("");
    if (!text && !reasoning && toolCalls.length === 0) {
      throw new Error(`Cursor AgentService ended without text, reasoning, or tool calls (${endReason ?? "no end signal"})`);
    }
    return {
      text,
      reasoning,
      toolCalls,
      status: toolCalls.length > 0 ? "tool_calls" : endReason === "server_end" ? "server_end" : "finished",
      usage: {
        inputTokens: Math.ceil(flattenMessages(request.messages as unknown as ChatMessage[]).length / 4),
        outputTokens: tokenCount || Math.ceil((text.length + reasoning.length) / 4),
      },
    };
  }

  async close(): Promise<void> {
    cursorSessionManager.reset();
  }
}

export function resetCursorTransportSessions(): void {
  cursorSessionManager.reset();
}
