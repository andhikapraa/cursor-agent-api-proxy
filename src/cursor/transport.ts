/** Direct local @cursor/sdk transport with OpenAI tool-call continuation. */

import { Agent } from "@cursor/sdk";
import type { SDKAgent, SDKUserMessage, SendOptions, Run, RunResult } from "@cursor/sdk";
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
  status: RunResult["status"] | "tool_calls";
  usage?: { inputTokens?: number; outputTokens?: number };
}

interface DeferredToolResult {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface PendingToolCall {
  call: OpenAIToolCall;
  deferred: DeferredToolResult;
}

interface SessionState {
  key: string;
  agent: SDKAgent;
  run?: Run;
  customTools: Record<string, any>;
  pending: Map<string, PendingToolCall>;
  pendingSignal?: Promise<void>;
  pendingNotified: boolean;
  resolvePendingSignal?: () => void;
  text: string;
  reasoning: string;
  toolCalls: OpenAIToolCall[];
  callbacks: CursorTransportCallbacks;
  model: string;
}

export interface CursorTransportDependencies {
  createAgent?: (options: Parameters<typeof Agent.create>[0]) => Promise<SDKAgent>;
}

const BUILTIN_TOOL_NAMES = new Set([
  "run_terminal_cmd", "read_file", "edit_file", "codebase_search", "list_dir",
  "grep_search", "file_search", "delete_file", "web_search", "reapply",
  "fetch_rules", "diff_history",
]);

const sessions = new Map<string, SessionState>();
const defaultCreateAgent = (options: Parameters<typeof Agent.create>[0]): Promise<SDKAgent> =>
  Agent.create(options);

function contentToText(content: OpenAIChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
}

type CursorImage = NonNullable<SDKUserMessage["images"]>[number];

function contentToImages(content: OpenAIChatMessage["content"]): CursorImage[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part): CursorImage[] => {
    const url = part.type === "image_url" ? part.image_url?.url : undefined;
    if (!url) return [];
    const dataUrl = url.match(/^data:([^;,]+);base64,(.+)$/s);
    return dataUrl
      ? [{ mimeType: dataUrl[1]!, data: dataUrl[2]! }]
      : [{ url }];
  });
}

function messagesToSdkMessage(messages: OpenAIChatMessage[]): string | SDKUserMessage {
  const text = messages.map((message) => {
    const content = contentToText(message.content);
    if (message.role === "tool") return `[Tool result ${message.tool_call_id ?? ""}]\\n${content}`;
    if (message.role === "assistant" && message.tool_calls?.length) {
      const calls = message.tool_calls.map((call) => `${call.function.name}(${call.function.arguments})`).join(", ");
      return `[Assistant]\\n${content}\\n[Tool calls: ${calls}]`;
    }
    return `[${message.role[0].toUpperCase()}${message.role.slice(1)}]\\n${content}`;
  }).join("\\n\\n");
  const images = messages.flatMap((message) => contentToImages(message.content));
  return images.length > 0 ? { text, images } : text;
}
function modelSelection(request: OpenAIChatRequest): { id: string; params?: Array<{ id: string; value: string }> } {
  const effort = request.reasoning?.effort ?? request.reasoning_effort;
  if (!effort) return { id: "claude-opus-5-5" };
  return { id: "claude-opus-5-5", params: [{ id: "effort", value: effort }] };
}

function customToolsFor(session: SessionState, tools: OpenAITool[] | undefined): SessionState["customTools"] {
  const result: SessionState["customTools"] = {};
  for (const tool of tools ?? []) {
    const definition = tool.function ?? tool;
    const name = definition.name;
    if (tool.type !== "function" || !name) continue;
    result[name] = {
      description: definition.description,
      inputSchema: definition.parameters,
      execute: async (args: Record<string, unknown>, context: { toolCallId?: string }) => {
        const callId = context.toolCallId ?? `call_${Date.now().toString(36)}`;
        const call: OpenAIToolCall = {
          id: callId,
          type: "function",
          function: { name, arguments: JSON.stringify(args ?? {}) },
        };
        const existing = session.pending.get(callId);
        if (existing) return new Promise((resolve, reject) => {
          existing.deferred = { resolve, reject };
        });
        let resolve!: (value: unknown) => void;
        let reject!: (error: Error) => void;
        const resultPromise = new Promise<unknown>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        session.pending.set(callId, { call, deferred: { resolve, reject } });
        session.toolCalls.push(call);
        session.callbacks.onToolCall?.(call);
        session.pendingNotified = true;
        if (session.resolvePendingSignal) {
          const notify = session.resolvePendingSignal;
          session.resolvePendingSignal = undefined;
          queueMicrotask(notify);
        }
        return resultPromise;
      },
    };
  }
  return result;
}
function resetTurn(session: SessionState, callbacks: CursorTransportCallbacks): void {
  session.text = "";
  session.reasoning = "";
  session.toolCalls = [];
  session.callbacks = callbacks;
  session.pendingNotified = false;
  session.pendingSignal = undefined;
  session.resolvePendingSignal = undefined;
}

function waitForPending(session: SessionState): Promise<void> {
  if (session.pendingNotified) return Promise.resolve();
  if (!session.pendingSignal) {
    session.pendingSignal = new Promise<void>((resolve) => {
      session.resolvePendingSignal = resolve;
    });
  }
  return session.pendingSignal;
}

function updateFromDelta(session: SessionState, update: { type?: string; text?: string }): void {
  if (update.type === "text-delta" && update.text) {
    session.text += update.text;
    session.callbacks.onText?.(update.text);
  } else if (update.type === "thinking-delta" && update.text) {
    session.reasoning += update.text;
    session.callbacks.onReasoning?.(update.text);
  }
}

function resolveToolResults(session: SessionState, messages: OpenAIChatMessage[]): number {
  const resolveOne = (pending: PendingToolCall, message: OpenAIChatMessage): void => {
    pending.deferred.resolve({
      content: [{ type: "text", text: contentToText(message.content) }],
      isError: false,
    });
    session.pending.delete(pending.call.id);
  };
  let resolved = 0;
  for (const message of messages) {
    if (message.role !== "tool" || !message.tool_call_id) continue;
    const pending = session.pending.get(message.tool_call_id);
    if (!pending) continue;
    resolveOne(pending, message);
    resolved += 1;
  }

  // Axon may rewrite Cursor's toolu_* IDs to OpenAI call_* IDs. Pair the
  // latest assistant tool-call batch with the following tool results by name.
  const assistantIndex = messages.map((message) => message.role).lastIndexOf("assistant");
  const assistant = assistantIndex >= 0 ? messages[assistantIndex] : undefined;
  const calls = assistant?.tool_calls ?? [];
  const results = assistantIndex >= 0
    ? messages.slice(assistantIndex + 1).filter((message) => message.role === "tool")
    : [];
  for (let index = 0; index < Math.min(calls.length, results.length); index += 1) {
    const call = calls[index];
    const message = results[index];
    if (!call || !message) continue;
    const pending = [...session.pending.values()].find((entry) => entry.call.function.name === call.function.name);
    if (!pending) continue;
    resolveOne(pending, message);
    resolved += 1;
  }
  return resolved;
}

function resultFor(session: SessionState, result: RunResult | undefined): CursorTransportResult {
  const status = session.pending.size > 0 ? "tool_calls" : (result?.status ?? "finished");
  if (!session.text && result?.result) session.text = result.result;
  return {
    text: session.text,
    reasoning: session.reasoning,
    toolCalls: session.toolCalls,
    status,
    usage: result?.usage,
  };
}

export class CursorAgentTransport {
  private readonly createAgent: NonNullable<CursorTransportDependencies["createAgent"]>;

  constructor(deps: CursorTransportDependencies = {}) {
    this.createAgent = deps.createAgent ?? defaultCreateAgent;
  }

  async execute(
    sessionKey: string,
    request: OpenAIChatRequest,
    callbacks: CursorTransportCallbacks = {},
  ): Promise<CursorTransportResult> {
    let session = sessions.get(sessionKey);
    if (!session) {
      const toolResultIds = new Set(
        request.messages
          .filter((message) => message.role === "tool" && message.tool_call_id)
          .map((message) => message.tool_call_id as string),
      );
      if (toolResultIds.size > 0) {
        session = [...sessions.values()].find((candidate) =>
          [...candidate.pending.keys()].some((id) => toolResultIds.has(id)),
        );
      }
    }
    if (!session) {
      const model = modelSelection(request);
      const apiKey = process.env.CURSOR_API_KEY?.trim();
      session = {
        key: sessionKey,
        agent: await this.createAgent({
          apiKey,
          model,
          mode: "agent",
          local: { cwd: process.cwd(), sandboxOptions: { enabled: false }, customTools: {} },
        }),
        customTools: {},
        pending: new Map(),
        text: "",
        reasoning: "",
        pendingNotified: false,
        toolCalls: [],
        callbacks,
        model: model.id,
      };
      sessions.set(sessionKey, session as SessionState);
    }
    const active = session as SessionState;
    resetTurn(active, callbacks);

    let runResult: RunResult | undefined;
    if (active.run && active.pending.size > 0) {
      if (resolveToolResults(active, request.messages) === 0) {
        throw new Error(`No matching tool result for pending Cursor tool call(s): ${Array.from(active.pending.keys()).join(", ")}`);
      }
      runResult = await Promise.race([
        active.run.wait(),
        waitForPending(active).then(() => undefined),
      ]);
    } else {
      if (!active.run) {
        active.customTools = customToolsFor(active, request.tools);
      }
      const sendOptions: SendOptions = {
        onDelta: ({ update }) => updateFromDelta(active, update),
        local: { customTools: active.customTools },
      };
      active.run = await active.agent.send(messagesToSdkMessage(request.messages), sendOptions);
      runResult = await Promise.race([
        active.run.wait(),
        waitForPending(active).then(() => undefined),
      ]);
    }

    if (active.pending.size > 0) return resultFor(active, runResult);
    const result = resultFor(active, runResult);
    if (runResult) {
      active.run = undefined;
      sessions.delete(sessionKey);
    }
    return result;
  }

  async close(): Promise<void> {
    const current = Array.from(sessions.values());
    sessions.clear();
    await Promise.all(current.map(async (session) => {
      for (const pending of session.pending.values()) pending.deferred.reject(new Error("transport closed"));
      session.pending.clear();
      session.agent.close();
    }));
  }
}

export function resetCursorTransportSessions(): void {
  for (const session of sessions.values()) {
    for (const pending of session.pending.values()) pending.deferred.reject(new Error("session reset"));
    session.agent.close();
  }
  sessions.clear();
}
