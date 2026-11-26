import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { embedMany, generateText, Output, streamText } from "ai";
import type { z } from "zod";
import {
  defaultModel,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  MODELS,
  type ModelId,
} from "@/lib/ai/models";
import { costUsd } from "@/lib/ai/pricing";
import { type Observation, observe, type TraceParent } from "@/lib/ai/trace";

// Every model call in the app goes through this file, so each one is logged
// with its tokens, cost and how long it took. The log goes to the terminal
// running the app, as a line starting "[ai_calls]".
// Module 5: each call is also traced in Langfuse as a "generation" with its
// model, input, output, tokens and cost (lib/ai/trace.ts), nested under the
// agent that made it when `trace` is set.

export class AiNotConfiguredError extends Error {
  constructor() {
    super(
      "Set up AI to use this feature: add GOOGLE_GENERATIVE_AI_API_KEY to .env.local.",
    );
    this.name = "AiNotConfiguredError";
  }
}

export function isAiConfigured(): boolean {
  return Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY);
}

/** Which module and feature made the call, for the ai_calls log. */
export type CallInfo = {
  module: number;
  feature: string;
  model?: ModelId;
  /** Module 5: the Langfuse observation (an agent, an eval) this call belongs to. */
  trace?: TraceParent | Observation;
  /** Module 5: called with the ai_calls row once the call ends. */
  onLogged?: (row: AiCallRow) => void;
};

// Omit that keeps generateText's "prompt or messages" union intact.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
type TextOptions = DistributiveOmit<
  Parameters<typeof generateText>[0],
  "model" | "output"
>;

export type AiCallRow = {
  module: number;
  feature: string;
  model: ModelId | typeof EMBEDDING_MODEL;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  latency_ms: number;
  ok: boolean;
  created_at: string;
};

function google() {
  const googleKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim();
  if (!googleKey) throw new AiNotConfiguredError();
  return createGoogleGenerativeAI({ apiKey: googleKey });
}

function languageModel(model: ModelId) {
  const entry = MODELS.find((m) => m.id === model);
  const id =
    entry && "googleId" in entry
      ? entry.googleId
      : model.slice("google/".length);
  return google()(id);
}

/** Prints one line per model call, so the cost and time are visible. */
async function logCall(row: AiCallRow): Promise<void> {
  console.info("[ai_calls]", JSON.stringify(row));
}

/** What the model was given, for the Langfuse trace. */
function inputOf(options: {
  instructions?: unknown;
  prompt?: unknown;
  messages?: unknown;
}) {
  return {
    ...(options.instructions ? { instructions: options.instructions } : {}),
    ...(options.messages
      ? { messages: options.messages }
      : { prompt: options.prompt }),
  };
}

/** Starts the Langfuse generation for one model call. */
function startGeneration(
  info: CallInfo,
  model: ModelId,
  options: Parameters<typeof inputOf>[0],
) {
  return observe(
    info.feature,
    "generation",
    {
      model,
      input: inputOf(options),
      metadata: { module: info.module, feature: info.feature },
    },
    info.trace,
  );
}

/** Logs the call, and ends its Langfuse generation with tokens and cost. */
async function finish(
  info: CallInfo,
  generation: Observation,
  row: AiCallRow,
  output?: unknown,
): Promise<void> {
  await logCall(row);
  info.onLogged?.(row);
  generation
    .update({
      output,
      ...(row.ok ? {} : { level: "ERROR", statusMessage: "call failed" }),
      ...(row.input_tokens !== null && row.output_tokens !== null
        ? {
            usageDetails: {
              input: row.input_tokens,
              output: row.output_tokens,
              total: row.input_tokens + row.output_tokens,
            },
          }
        : {}),
      ...(row.cost_usd !== null
        ? { costDetails: { total: row.cost_usd } }
        : {}),
    })
    .end();
}

type Usage = { inputTokens?: number; outputTokens?: number };

/** Builds the ai_calls row for a call that started at `started`. */
function rowFor(info: CallInfo, model: ModelId, started: number) {
  return (ok: boolean, usage?: Usage): AiCallRow => {
    const input = usage?.inputTokens ?? null;
    const output = usage?.outputTokens ?? null;
    return {
      module: info.module,
      feature: info.feature,
      model,
      input_tokens: input,
      output_tokens: output,
      cost_usd:
        input !== null && output !== null
          ? costUsd(model, input, output)
          : null,
      latency_ms: Math.round(performance.now() - started),
      ok,
      created_at: new Date().toISOString(),
    };
  };
}

async function tracked<T extends { usage: Usage; text?: string }>(
  info: CallInfo,
  options: Parameters<typeof inputOf>[0],
  run: (model: ModelId) => Promise<T>,
): Promise<T> {
  const model = info.model ?? defaultModel();
  const row = rowFor(info, model, performance.now());
  const generation = startGeneration(info, model, options);
  try {
    const result = await run(model);
    const output = (result as { output?: unknown }).output ?? result.text;
    await finish(info, generation, row(true, result.usage), output);
    return result;
  } catch (error) {
    if (!(error instanceof AiNotConfiguredError))
      await finish(info, generation, row(false), String(error));
    else generation.end();
    throw error;
  }
}

/** Generates text. Example: callText({ module: 3, feature: "support-answer" }, { prompt }) */
export async function callText(info: CallInfo, options: TextOptions) {
  return tracked(info, options, (model) =>
    generateText({ ...options, model: languageModel(model) }),
  );
}

/** Generates an object that matches a zod schema; read it from `result.output`. */
export async function callObject<Schema extends z.ZodType>(
  info: CallInfo,
  options: TextOptions & { schema: Schema },
) {
  const { schema, ...rest } = options;
  const result = await tracked(info, rest, (model) =>
    generateText({
      ...rest,
      model: languageModel(model),
      output: Output.object({ schema }),
    }),
  );
  // Spreading `rest` loses generateText's output type; Output.object has
  // already validated it against `schema`, so restore the type here.
  return result as typeof result & { output: z.infer<Schema> };
}

/**
 * Embeds many texts in one go; read `result.embeddings` (same order as `values`).
 * Example: callEmbedMany({ module: 3, feature: "embed-docs" }, passages)
 */
export async function callEmbedMany(
  info: Omit<CallInfo, "model">,
  values: string[],
) {
  const started = performance.now();
  const embedding = observe(info.feature, "embedding", {
    model: EMBEDDING_MODEL,
    input: values,
    metadata: { module: info.module, feature: info.feature },
  });
  // Google doesn't report tokens for embeddings, so tokens and cost are null.
  const log = (ok: boolean) => {
    embedding.update({ output: `${values.length} embeddings` }).end();
    return logCall({
      module: info.module,
      feature: info.feature,
      model: EMBEDDING_MODEL,
      input_tokens: null,
      output_tokens: null,
      cost_usd: null,
      latency_ms: Math.round(performance.now() - started),
      ok,
      created_at: new Date().toISOString(),
    });
  };
  try {
    const result = await embedMany({
      model: google().embedding(EMBEDDING_MODEL.slice("google/".length)),
      values,
      providerOptions: {
        google: { outputDimensionality: EMBEDDING_DIMENSIONS },
      },
    });
    await log(true);
    return result;
  } catch (error) {
    if (!(error instanceof AiNotConfiguredError)) await log(false);
    throw error;
  }
}

type StreamOptions = DistributiveOmit<
  Parameters<typeof streamText>[0],
  "model" | "output" | "onFinish" | "onError"
>;

/**
 * Streams a reply: read `result.fullStream` to see each step as it happens
 * (thinking, tool calls, tool results, text). Logged to ai_calls when it ends.
 * Example: callStream({ module: 2, feature: "ask-copper" }, { messages })
 */
export function callStream(info: CallInfo, options: StreamOptions) {
  const model = info.model ?? defaultModel();
  const row = rowFor(info, model, performance.now());
  const generation = startGeneration(info, model, options);
  return streamText({
    ...options,
    model: languageModel(model),
    onFinish: ({ totalUsage, text }) =>
      finish(info, generation, row(true, totalUsage), text),
    onError: ({ error }) => finish(info, generation, row(false), String(error)),
  });
}

// Asking for some thinking (rather than letting the model decide) is what
// makes Gemini write a summary even for an easy question.
const THINKING = { includeThoughts: true, thinkingBudget: 1024 };

/**
 * Asks Gemini to include a summary of its thinking in the stream (as
 * reasoning parts). Other models ignore it. Pass as `providerOptions`.
 */
export const THOUGHT_SUMMARIES = {
  google: { thinkingConfig: THINKING },
};
