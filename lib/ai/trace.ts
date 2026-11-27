// Module 5: observability. Every AI call is traced in Langfuse: which agent
// answered, which tools it used, and the tokens, cost and time of each model
// call. Tracing is on only when the Langfuse keys are set (LANGFUSE_PUBLIC_KEY,
// LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL); without them the app works as before.
// The Langfuse and OpenTelemetry packages load only when the keys are set, so
// they never slow down the app (or its tests) without them.
import type { LangfuseSpanProcessor } from "@langfuse/otel";
import type { startObservation } from "@langfuse/tracing";
import { context, type Span, trace } from "@opentelemetry/api";

export function isTracingConfigured(): boolean {
  return Boolean(
    process.env.LANGFUSE_PUBLIC_KEY?.trim() &&
    process.env.LANGFUSE_SECRET_KEY?.trim(),
  );
}

type Tracing = {
  processor: LangfuseSpanProcessor;
  startObservation: typeof startObservation;
};

// One span processor per server process, kept on globalThis so Next.js hot
// reloads don't register a second one.
const KEY = Symbol.for("copper.langfuse.tracing");
const LOADED = Symbol.for("copper.langfuse.loaded");
type WithTracing = typeof globalThis & {
  [KEY]?: Promise<Tracing>;
  [LOADED]?: Tracing;
};
const store = globalThis as WithTracing;

async function load(): Promise<Tracing> {
  const [{ LangfuseSpanProcessor }, tracing, { NodeTracerProvider }] =
    await Promise.all([
      import("@langfuse/otel"),
      import("@langfuse/tracing"),
      import("@opentelemetry/sdk-trace-node"),
    ]);
  // "immediate" sends each span as it ends, which suits serverless.
  const processor = new LangfuseSpanProcessor({ exportMode: "immediate" });
  new NodeTracerProvider({ spanProcessors: [processor] }).register();
  const loaded = { processor, startObservation: tracing.startObservation };
  store[LOADED] = loaded;
  return loaded;
}

/**
 * Starts sending traces to Langfuse (once). False when the keys aren't set.
 * Await it before tracing: until then, observe() records nothing.
 */
export async function startTracing(): Promise<boolean> {
  if (!isTracingConfigured()) return false;
  store[KEY] ??= load();
  await store[KEY];
  return true;
}

/** Waits until every finished span has reached Langfuse. */
export async function flushTraces(): Promise<void> {
  await store[LOADED]?.processor.forceFlush();
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

type Start = (
  name: string,
  attributes: object,
  options: { asType: Kind },
) => Noop;

/**
 * Starts an observation under `parent` (or as the start of a new trace, or
 * under the active one), or a no-op one when tracing is off or not started.
 */
export function observe(
  name: string,
  kind: Kind,
  attributes: Record<string, unknown> = {},
  parent?: TraceParent | Noop,
): Noop {
  const tracing = store[LOADED];
  if (!tracing || !isTracingConfigured()) return NOOP;
  // Called as a method, so the parent keeps `this` (its own span).
  const owner = (parent ?? tracing) as { startObservation: Start };
  return owner.startObservation(name, attributes, { asType: kind });
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
