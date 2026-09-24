/**
 * Convert OpenAI Chat Completion requests into a prompt string
 * suitable for the Cursor CLI `agent -p` command.
 */

import type { OpenAIChatMessage, OpenAIChatRequest, OpenAIContentPart } from "../types/openai.js";

const DEFAULT_CURSOR_MODEL = "claude-opus-5-5[context=1m,effort=high,fast=false]";
const MODEL_ALIASES: Record<string, string> = {
  "claude-opus-5-5": DEFAULT_CURSOR_MODEL,
  "claude-opus-5-5-fast": "claude-opus-5-5[context=1m,effort=high,fast=true]",
  "composer-2.5": "composer-2.5",
  "composer-2.5-fast": "composer-2.5-fast",
  "grok-4.6": "cursor-grok-4.6-high",
  "grok-4.6-fast": "cursor-grok-4.6-high-fast",
  "grok-4.7": "grok-4.7-high",
  "grok-4.7-fast": "grok-4.7-high-fast",
};
const KNOWN_CURSOR_MODELS = new Set(Object.keys(MODEL_ALIASES));

const OPUS_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);


export interface CliInput {
  prompt: string;
  model: string;
}

/**
 * Resolve the Cursor CLI model name from an OpenAI-style model string.
 *
 * Supported formats:
 *   "cursor/opus-4.6"     -> "opus-4.6"
 *   "cursor-opus-4.6"     -> "opus-4.6"
 *   "auto"                -> "auto"
 *   "opus-4.6-thinking"   -> "opus-4.6-thinking"
 */
export function extractModel(model: string): string {
  const requested = model.trim();
  if (!requested || requested === "auto") return DEFAULT_CURSOR_MODEL;
  const normalized = requested.startsWith("cursor/") ? requested.slice("cursor/".length) : requested;
  const mapped = MODEL_ALIASES[normalized];
  if (mapped) return mapped;
  throw new Error(`Unsupported Cursor model: ${requested}`);
}

function messageContentToText(content: string | OpenAIContentPart[]): string {
  if (typeof content === "string") return content;

  return content
    .filter((part): part is OpenAIContentPart & { type: "text" } => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

/**
 * Flatten an array of OpenAI messages into a single prompt string.
 *
 * When there's only one user message (the common case), pass the text
 * directly without role markers to keep the prompt clean.
 * Multi-turn conversations get [System]/[User]/[Assistant] prefixes.
 */
export function messagesToPrompt(messages: OpenAIChatMessage[]): string {
  const nonEmpty = messages.filter((m) => {
    const text = messageContentToText(m.content);
    return text.length > 0;
  });

  if (nonEmpty.length === 1 && nonEmpty[0].role === "user") {
    return messageContentToText(nonEmpty[0].content);
  }

  const parts: string[] = [];
  for (const msg of nonEmpty) {
    const text = messageContentToText(msg.content);
    switch (msg.role) {
      case "system":
        parts.push(`[System]\n${text}`);
        break;
      case "user":
        parts.push(`[User]\n${text}`);
        break;
      case "assistant":
        parts.push(`[Assistant]\n${text}`);
        break;
    }
  }

  return parts.join("\n\n");
}

export function openaiToCli(request: OpenAIChatRequest): CliInput {
  const model = extractModel(request.model || "auto");
  const effort = request.reasoning?.effort ?? request.reasoning_effort;
  if (effort !== undefined && !OPUS_EFFORTS.has(effort)) {
    throw new Error(`Unsupported reasoning effort: ${effort}`);
  }
  const resolvedModel = effort && model.startsWith("claude-opus-5-5[context=1m,")
    ? `claude-opus-5-5[context=1m,effort=${effort},fast=${model.includes("fast=true")}]`
    : model;
  return { prompt: messagesToPrompt(request.messages), model: resolvedModel };
}
