import type { ModelProvider } from "../providers/types.js";

/**
 * Model-specific harness tuning (Cursor's published practice): the SAME
 * system prompt is not optimal for every model family. Each profile is a
 * small additive suffix + request knobs, selected from provider + model id.
 * Deliberately conservative: profiles tune tool discipline and output shape,
 * never the workflow rules (those are harness law and stay identical).
 */
export interface ModelProfile {
  id: string;
  /** Extra system-prompt block appended for this family. */
  promptSuffix: string;
  /** Per-turn output budget; generous reasoning room is a harness choice. */
  maxTokens: number;
}

export function profileFor(provider: ModelProvider, model: string): ModelProfile {
  const m = model.toLowerCase();
  if (provider.id === "anthropic" || m.includes("claude")) {
    return {
      id: "anthropic",
      maxTokens: 16_384,
      promptSuffix: `
## Model profile: Claude
- You reason best with explicit evidence lists. Before each phase sign-off, enumerate the concrete evidence (files read, docs cited, commands run) as short bullets, then the sign-off line.
- Prefer parallel independent tool calls in one block when exploring; serialise only when one result decides the next call.
- Keep code out of chat prose: describe edits, let the tools show them.`,
    };
  }
  if (provider.id === "openai" || m.includes("gpt") || m.includes("codex")) {
    return {
      id: "openai",
      maxTokens: 16_384,
      promptSuffix: `
## Model profile: OpenAI
- Tool arguments MUST be valid JSON matching the schema exactly — no trailing commas, no comments, no omitted required fields. If a call fails on arguments, fix the JSON, don't change the plan.
- Be terse between tool calls: one sentence of intent, then the call. Save tokens for the work, not narration.
- When several interpretations exist, gather one more piece of evidence instead of committing early.`,
    };
  }
  return {
    id: "generic",
    maxTokens: 12_288,
    promptSuffix: `
## Model profile: generic
- Follow tool schemas exactly. State intent in one sentence before each call. Cite evidence for every factual claim about the codebase.`,
  };
}
