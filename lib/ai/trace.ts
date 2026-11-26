// Module 5: observability. Every AI call is traced in Langfuse: which agent
// answered, which tools it used, and the tokens, cost and time of each model
// call. Tracing is on only when the Langfuse keys are set (LANGFUSE_PUBLIC_KEY,
// LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL); without them the app works as before.
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { startObservation } from "@langfuse/tracing";
import { context, type Span, trace } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

export function isTracingConfigured(): boolean {
  return Boolean(
    process.env.LANGFUSE_PUBLIC_KEY?.trim() &&
    process.env.LANGFUSE_SECRET_KEY?.trim(),
  );
}

// One span processor per server process, kept on globalThis so Next.js hot
// reloads don't register a second one.
const KEY = Symbol.for("copper.langfuse.processor");
type WithProcessor = typeof globalThis & {
  [KEY]?: LangfuseSpanProcessor;
};

/** Starts sending traces to Langfuse (once). False when the keys aren't set. */
export function startTracing(): boolean {
  if (!isTracingConfigured()) return false;
  const store = globalThis as WithProcessor;
  if (!store[KEY]) {
    // "immediate" sends each span as it ends, which suits serverless.
    const processor = new LangfuseSpanProcessor({ exportMode: "immediate" });
    new NodeTracerProvider({ spanProcessors: [processor] }).register();
    store[KEY] = processor;
  }
  return true;
}

/** Waits until every finished span has reached Langfuse. */
export async function flushTraces(): Promise<void> {
  await (globalThis as WithProcessor)[KEY]?.forceFlush();
}

/** A Langfuse observation that other observations can nest under. */
export type TraceParent = Pick<
  ReturnType<typeof startObservation>,
  "startObservation"
>;

/** A no-op stand-in, so code can trace without checking for keys. */
type Noop = {
  id: string;
  traceId: string;
  update: (attributes: object) => Noop;
  end: () => void;
  setTraceAsPublic: () => Noop;
  startObservation: (...args: unknown[]) => Noop;
};
const NOOP: Noop = {
  id: "",
  traceId: "",
  update: () => NOOP,
  end: () => {},
  setTraceAsPublic: () => NOOP,
  startObservation: () => NOOP,
};

type Kind =
  | "span"
  | "agent"
  | "tool"
  | "generation"
  | "embedding"
  | "event"
  | "evaluator";

/**
 * Starts an observation under `parent` (or as the start of a new trace, or
 * under the active one), or a no-op one when tracing is off.
 */
export function observe(
  name: string,
  kind: Kind,
  attributes: Record<string, unknown> = {},
  parent?: TraceParent | Noop,
): Noop {
  if (!startTracing()) return NOOP;
  const start = (parent ?? { startObservation }).startObservation as (
    name: string,
    attributes: object,
    options: { asType: Kind },
  ) => Noop;
  return start(name, attributes, { asType: kind });
}

export type Observation = ReturnType<typeof observe>;

/**
 * Runs `fn` with `observation` as the active one, so observations started
 * inside it without a parent (tool calls, embeddings) nest under it.
 */
export function inside<T>(observation: Observation, fn: () => T): T {
  const span = (observation as { otelSpan?: Span }).otelSpan;
  if (!span) return fn();
  return context.with(trace.setSpan(context.active(), span), fn);
}
