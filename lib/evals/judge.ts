// Module 5: grading one golden-set answer. Two kinds of check:
// - hard checks (code): did the agents call the tools they had to, and did the
//   app make the right refund decision?
// - the AI judge (Gemini through lib/ai/call.ts): does the reply do what a good
//   answer does, using only what the tools returned?
// A case passes when both pass.
import { z } from "zod";
import { callObject } from "@/lib/ai/call";
import type { Observation } from "@/lib/ai/trace";
import type { GoldenCase } from "@/lib/evals/golden-set";

export type ToolCall = { name: string; input?: unknown; output?: unknown };

/** What one setup answered, and what it took. */
export type Answer = {
  reply: string;
  status: "working" | "done" | "error";
  tools: ToolCall[];
  costUsd: number;
  latencyMs: number;
  traceId?: string;
};

export type CheckResult = { pass: boolean; reason: string };

/** The refund decision the app made, from request_refund's last result. */
export function refundDecision(tools: ToolCall[]): string | undefined {
  const last = tools.filter((t) => t.name === "request_refund").at(-1);
  const output = last?.output as { status?: string } | undefined;
  return output?.status;
}

/** The hard checks: required tools were called, and the refund decision. */
export function checkTools(golden: GoldenCase, answer: Answer): CheckResult {
  if (answer.status !== "done")
    return { pass: false, reason: "The answer failed or never finished." };
  const called = new Set(answer.tools.map((t) => t.name));
  const missing = (golden.tools ?? []).filter((name) => !called.has(name));
  if (missing.length)
    return { pass: false, reason: `Never called ${missing.join(", ")}.` };
  if (golden.refund) {
    const decision = refundDecision(answer.tools);
    if (decision !== golden.refund)
      return {
        pass: false,
        reason: `The refund decision was ${decision ?? "never made"}, expected ${golden.refund}.`,
      };
  }
  return { pass: true, reason: "Called the right tools." };
}

const VERDICT = z.object({
  reason: z
    .string()
    .describe("One or two sentences on why the answer passes or fails."),
  pass: z
    .boolean()
    .describe("True only if the answer does what a good answer does."),
});

/** Keeps long tool results short enough for the judge. */
function brief(value: unknown, limit = 1500): string {
  const text = JSON.stringify(value) ?? "";
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

const JUDGE_INSTRUCTIONS = `You grade a customer support chatbot for Copper State Labs.
You get the customer's question, what a good answer does, the tools the chatbot called with what they returned, and the chatbot's reply.
Pass the reply only if it does what a good answer does. Facts (prices, colors, stock, refund decisions, document content) must match what the tools returned; anything the tools didn't return counts as made up. Wording, tone and length don't matter, and extra helpful detail that is supported by the tools is fine.
Be strict about refunds: a reply that says money is refunded when the tool said needs_approval, not_found or an earlier status fails.`;

/** The AI judge: grades one reply against what a good answer does. */
export async function judge(
  golden: GoldenCase,
  answer: Answer,
  trace?: Observation,
): Promise<CheckResult> {
  const tools = answer.tools.length
    ? answer.tools
        .map(
          (t, i) =>
            `${i + 1}. ${t.name}(${brief(t.input, 300)}) returned ${brief(t.output)}`,
        )
        .join("\n")
    : "No tools were called.";
  const { output } = await callObject(
    { module: 5, feature: "eval-judge", trace },
    {
      instructions: JUDGE_INSTRUCTIONS,
      prompt: `Customer's question: ${golden.question}

What a good answer does: ${golden.good}

Tools the chatbot called:
${tools}

The chatbot's reply:
${answer.reply}`,
      schema: VERDICT,
      temperature: 0,
    },
  );
  return output;
}
