// @vitest-environment node
// Module 5: the single Support agent (one agent with every tool, no handoff),
// the golden set and the eval's hard checks. Mock model, so no AI key, and no
// Langfuse keys, so tracing is off.
import type { LanguageModelV4StreamPart as ModelStreamPart } from "@ai-sdk/provider";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalValue } from "@/lib/ai/live";
import { toolCallsOf } from "@/lib/copper/assistant/progress";
import { GOLDEN_SET } from "@/lib/evals/golden-set";
import { type Answer, checkTools, refundDecision } from "@/lib/evals/judge";

let model: MockLanguageModelV4;
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => model,
}));

type StreamPart = Parameters<
  typeof convertArrayToReadableStream<ModelStreamPart>
>[0][number];

const usage = {
  inputTokens: {
    total: 1000,
    noCache: 1000,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 100, text: 100, reasoning: undefined },
};

const finish = (reason: "stop" | "tool-calls"): StreamPart => ({
  type: "finish",
  finishReason: { unified: reason, raw: undefined },
  usage,
});

const says = (text: string): StreamPart[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  finish("stop"),
];

const calls = (toolName: string, input: unknown): StreamPart[] => [
  { type: "tool-input-start", id: "call-1", toolName },
  { type: "tool-input-end", id: "call-1" },
  {
    type: "tool-call",
    toolCallId: "call-1",
    toolName,
    input: JSON.stringify(input),
  },
  finish("tool-calls"),
];

function modelStreaming(...steps: StreamPart[][]) {
  let step = 0;
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream(steps[step++] ?? says("")),
    }),
  });
}

async function ask(
  request: Parameters<typeof import("@/lib/copper/assistant/ask").askCopper>[0],
) {
  vi.resetModules();
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
  vi.stubEnv("LANGFUSE_PUBLIC_KEY", "");
  vi.stubEnv("LANGFUSE_SECRET_KEY", "");
  const { askCopper } = await import("@/lib/copper/assistant/ask");
  return finalValue((await askCopper(request)).progress);
}

const desk = { limitUsd: 50, refunds: [] };

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("one Support agent (Module 5)", () => {
  it("has Copper's tools and the refund tools, and no handoffs", async () => {
    const { supportAgentTools } = await import("@/lib/copper/assistant/tools");
    const names = Object.keys(supportAgentTools(desk));
    expect(names).toEqual(
      expect.arrayContaining([
        "get_products",
        "search_docs",
        "get_orders",
        "request_refund",
      ]),
    );
    expect(names).not.toContain("transfer_to_refund_agent");
    expect(names).not.toContain("transfer_to_copper");
  });

  it("refunds by itself, with no handoff, and adds up the cost", async () => {
    model = modelStreaming(
      calls("request_refund", { orderId: "1001" }),
      says("Order 1001 is refunded."),
    );
    const progress = await ask({
      messages: [{ role: "user", content: "Refund order 1001" }],
      useTools: true,
      desk,
      agents: "one",
    });
    expect(progress.agent).toBe("support");
    expect(progress.steps.some((s) => s.type === "handoff")).toBe(false);
    expect(refundDecision(toolCallsOf(progress))).toBe("refunded");
    expect(progress.reply).toBe("Order 1001 is refunded.");
    expect(progress.usage?.calls).toBe(1);
    expect(progress.usage?.inputTokens).toBe(2000);
    expect(progress.usage?.costUsd).toBeGreaterThan(0);
  });

  it("keeps the two agents by default", async () => {
    model = modelStreaming(
      calls("transfer_to_refund_agent", { reason: "refund order 1001" }),
      calls("request_refund", { orderId: "1001" }),
      says("Refunded."),
    );
    const progress = await ask({
      messages: [{ role: "user", content: "Refund order 1001" }],
      useTools: true,
      desk,
    });
    expect(progress.agent).toBe("refund");
    expect(progress.steps).toContainEqual({
      type: "handoff",
      from: "copper",
      to: "refund",
    });
    expect(progress.usage?.calls).toBe(2);
  });
});

describe("the golden set and its hard checks (Module 5)", () => {
  const answer = (tools: Answer["tools"], status: Answer["status"] = "done") =>
    ({ reply: "", status, tools, costUsd: 0, latencyMs: 0 }) as Answer;
  const golden = GOLDEN_SET.find((g) => g.id === "refund-over-limit")!;

  it("has unique ids, and a good answer for every question", () => {
    const ids = GOLDEN_SET.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(GOLDEN_SET.length).toBeGreaterThanOrEqual(10);
    for (const g of GOLDEN_SET) expect(g.good.length).toBeGreaterThan(20);
  });

  it("passes when the right tool made the right refund decision", () => {
    const tools = [
      {
        name: "request_refund",
        input: { orderId: "1004" },
        output: { status: "needs_approval" },
      },
    ];
    expect(checkTools(golden, answer(tools)).pass).toBe(true);
  });

  it("fails a wrong decision, a missing tool or a failed answer", () => {
    const refunded = [
      { name: "request_refund", output: { status: "refunded" } },
    ];
    expect(checkTools(golden, answer(refunded)).reason).toMatch(/refunded/);
    expect(checkTools(golden, answer([])).reason).toMatch(/request_refund/);
    expect(checkTools(golden, answer(refunded, "error")).pass).toBe(false);
  });
});
