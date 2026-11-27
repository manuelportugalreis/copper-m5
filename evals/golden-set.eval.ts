// @vitest-environment node
// Module 5: the golden-set evaluation. Run it with `npm run eval`; CI runs it
// on every pull request. Each setup (two agents, one agent) answers every
// question in lib/evals/golden-set.ts as a Langfuse experiment on the
// "copper-golden-set" dataset, so the runs sit side by side in Langfuse
// (Datasets > copper-golden-set > Runs). Every answer is traced, and its scores
// (judge, tools, passed, cost, latency) are saved on its trace.
// The check fails when the shipped setup (two agents) passes fewer than
// EVAL_PASS_RATE (80%) of the questions, which blocks the pull request.
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { LangfuseClient } from "@langfuse/client";
import { describe, expect, it } from "vitest";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
// Free Gemini keys allow 15 model calls a minute: stay under it.
process.env.AI_MAX_CALLS_PER_MINUTE ??= "13";

type Setup = "two" | "one";
type Evaluation = { name: string; value: number; comment?: string };

const DATASET = "copper-golden-set";
const SETUP_NAMES: Record<Setup, string> = {
  two: "Two agents (Copper + Refund agent)",
  one: "One agent (Support agent)",
};
const SETUPS = (process.env.EVAL_AGENTS ?? "two,one")
  .split(",")
  .map((s) => s.trim())
  .filter((s): s is Setup => s === "two" || s === "one");
/** The setup the app ships with: its pass rate gates the pull request. */
const GATE: Setup = "two";
const PASS_RATE = Number(process.env.EVAL_PASS_RATE ?? "0.8");
/** Free Gemini keys allow only a few calls at once. */
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY ?? "1");

const missing = [
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
].filter((name) => !process.env[name]?.trim());

type Summary = {
  setup: Setup;
  name: string;
  cases: number;
  passed: number;
  passRate: number;
  avgCostUsd: number;
  totalCostUsd: number;
  avgLatencyS: number;
  url?: string;
  failures: { id: string; reason: string }[];
};

const mean = (values: number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;

/** Free keys sometimes hit the per-minute quota: wait it out and retry. */
async function judgeWithRetry(
  run: () => Promise<{ pass: boolean; reason: string }>,
) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const quota = /quota|rate.?limit|429|exhausted/i.test(String(error));
      if (!quota || attempt >= 3)
        return { pass: false, reason: `The judge failed: ${String(error)}` };
      await new Promise((done) => setTimeout(done, 60_000));
    }
  }
}

/** Copies the golden set into the Langfuse dataset (same ids: an update). */
async function syncDataset(langfuse: LangfuseClient) {
  const { GOLDEN_SET } = await import("@/lib/evals/golden-set");
  try {
    await langfuse.api.datasets.create({
      name: DATASET,
      description:
        "Ask Copper's golden set (lib/evals/golden-set.ts): questions and what a good answer does.",
    });
  } catch {
    // It already exists.
  }
  for (const golden of GOLDEN_SET)
    await langfuse.api.datasetItems.create({
      datasetName: DATASET,
      id: `${DATASET}-${golden.id}`,
      input: { question: golden.question },
      expectedOutput: {
        good: golden.good,
        tools: golden.tools ?? [],
        refund: golden.refund ?? null,
      },
      metadata: { case: golden.id },
    });
  const ids = new Set(GOLDEN_SET.map((g) => `${DATASET}-${g.id}`));
  const dataset = await langfuse.dataset.get(DATASET);
  return {
    ...dataset,
    items: dataset.items.filter((item) => ids.has(item.id)),
  };
}

async function runSetup(
  langfuse: LangfuseClient,
  setup: Setup,
): Promise<Summary> {
  const { GOLDEN_SET } = await import("@/lib/evals/golden-set");
  const { checkTools, judge } = await import("@/lib/evals/judge");
  const { askCopper } = await import("@/lib/copper/assistant/ask");
  const { finalValue } = await import("@/lib/ai/live");
  const { toolCallsOf } = await import("@/lib/copper/assistant/progress");
  const { DEFAULT_LIMIT_USD } = await import("@/lib/copper/orders");
  const { flushTraces } = await import("@/lib/ai/trace");
  const { waitedMs } = await import("@/lib/ai/rate-limit");
  type Answer = import("@/lib/evals/judge").Answer;
  const byId = new Map(GOLDEN_SET.map((g) => [g.id, g]));
  const caseOf = (metadata: unknown) => {
    const id = (metadata as { case?: string } | undefined)?.case ?? "";
    const golden = byId.get(id);
    if (!golden) throw new Error(`No golden case "${id}".`);
    return golden;
  };

  const dataset = await syncDataset(langfuse);
  const version = process.env.GITHUB_SHA?.slice(0, 7) ?? "local";
  const result = await dataset.runExperiment({
    name: SETUP_NAMES[setup],
    runName: `${SETUP_NAMES[setup]} · ${version} · ${new Date().toISOString()}`,
    description: `Ask Copper golden set, ${SETUP_NAMES[setup]}.`,
    metadata: { agents: setup, version },
    maxConcurrency: CONCURRENCY,
    task: async ({ input, metadata }) => {
      const golden = caseOf(metadata);
      const question = (input as { question: string }).question;
      const started = performance.now();
      const waitedBefore = waitedMs();
      const { progress } = await askCopper({
        messages: [{ role: "user", content: question }],
        useTools: true,
        desk: { limitUsd: DEFAULT_LIMIT_USD, refunds: [] },
        agents: setup,
        tags: ["eval", golden.id],
      });
      const final = await finalValue(progress);
      const answer: Answer = {
        reply: final.reply,
        status: final.status,
        tools: toolCallsOf(final),
        costUsd: final.usage?.costUsd ?? 0,
        // Time spent waiting for the free key's rate limit isn't Copper's.
        latencyMs: Math.round(
          performance.now() - started - (waitedMs() - waitedBefore),
        ),
        traceId: final.traceId,
      };
      return answer;
    },
    evaluators: [
      async ({ output, metadata }): Promise<Evaluation[]> => {
        const golden = caseOf(metadata);
        const answer = output as Answer;
        const tools = checkTools(golden, answer);
        const verdict = await judgeWithRetry(() => judge(golden, answer));
        const passed = tools.pass && verdict.pass;
        return [
          {
            name: "judge",
            value: verdict.pass ? 1 : 0,
            comment: verdict.reason,
          },
          { name: "tools", value: tools.pass ? 1 : 0, comment: tools.reason },
          {
            name: "passed",
            value: passed ? 1 : 0,
            comment: passed
              ? "Passed."
              : [tools, verdict]
                  .filter((c) => !c.pass)
                  .map((c) => c.reason)
                  .join(" "),
          },
          { name: "cost_usd", value: answer.costUsd },
          { name: "latency_s", value: answer.latencyMs / 1000 },
        ];
      },
    ],
    runEvaluators: [
      async ({ itemResults }): Promise<Evaluation[]> => {
        const score = (name: string) =>
          itemResults.map(
            (r) => r.evaluations.find((e) => e.name === name)?.value as number,
          );
        return [
          { name: "pass_rate", value: mean(score("passed")) },
          { name: "avg_cost_usd", value: mean(score("cost_usd")) },
          { name: "avg_latency_s", value: mean(score("latency_s")) },
        ];
      },
    ],
  });
  await flushTraces();

  const rows = result.itemResults.map((r) => {
    const value = (name: string) =>
      Number(r.evaluations.find((e) => e.name === name)?.value ?? 0);
    return {
      id: caseOf(r.item.metadata).id,
      passed: value("passed") === 1,
      reason: String(
        r.evaluations.find((e) => e.name === "passed")?.comment ??
          "No scores (the answer or the judge failed).",
      ),
      cost: value("cost_usd"),
      latency: value("latency_s"),
    };
  });
  const passed = rows.filter((r) => r.passed).length;
  return {
    setup,
    name: SETUP_NAMES[setup],
    cases: rows.length,
    passed,
    passRate: rows.length ? passed / rows.length : 0,
    avgCostUsd: mean(rows.map((r) => r.cost)),
    totalCostUsd: rows.reduce((sum, r) => sum + r.cost, 0),
    avgLatencyS: mean(rows.map((r) => r.latency)),
    url:
      result.experimentUrl ??
      result.datasetRunUrl ??
      (result.itemResults[0]?.traceId
        ? await langfuse.getTraceUrl(result.itemResults[0].traceId)
        : undefined),
    failures: rows
      .filter((r) => !r.passed)
      .map(({ id, reason }) => ({ id, reason })),
  };
}

function report(summaries: Summary[]): string {
  const lines = [
    "## Ask Copper golden-set eval (Langfuse, AI judge)",
    "",
    "| Setup | Pass rate | Avg cost per answer | Avg time per answer | Langfuse run |",
    "| --- | --- | --- | --- | --- |",
    ...summaries.map(
      (s) =>
        `| ${s.name} | ${(s.passRate * 100).toFixed(0)}% (${s.passed}/${s.cases}) | $${s.avgCostUsd.toFixed(5)} | ${s.avgLatencyS.toFixed(1)} s | ${s.url ? `[open](${s.url})` : "-"} |`,
    ),
    "",
    `The check passes when the two-agent setup (what the app ships) passes at least ${(PASS_RATE * 100).toFixed(0)}% of the questions.`,
  ];
  for (const s of summaries)
    if (s.failures.length)
      lines.push(
        "",
        `**Failed (${s.name}):**`,
        ...s.failures.map((f) => `- \`${f.id}\`: ${f.reason}`),
      );
  return lines.join("\n");
}

describe("Ask Copper golden set", () => {
  it("has the keys it needs", () => {
    expect(
      missing,
      `Set ${missing.join(", ")} in .env.local (or the repo's Actions secrets).`,
    ).toEqual([]);
  });

  it.skipIf(missing.length > 0)(
    `passes at least ${PASS_RATE * 100}% of the questions`,
    async () => {
      // Start tracing first, so every experiment's traces are recorded.
      const { startTracing } = await import("@/lib/ai/trace");
      await startTracing();
      const langfuse = new LangfuseClient();
      const summaries: Summary[] = [];
      for (const setup of SETUPS)
        summaries.push(await runSetup(langfuse, setup));
      await langfuse.flush();

      const markdown = report(summaries);
      console.info(`\n${markdown}\n`);
      mkdirSync("eval-results", { recursive: true });
      writeFileSync("eval-results/summary.md", `${markdown}\n`);
      writeFileSync(
        "eval-results/summary.json",
        `${JSON.stringify(summaries, null, 2)}\n`,
      );
      if (process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
      // In GitHub Actions, also show each setup's scores as a notice on the
      // pull request's checks.
      if (process.env.GITHUB_ACTIONS)
        for (const r of summaries)
          process.stdout.write(
            `::notice title=Eval scores: ${r.name}::Pass rate ${(r.passRate * 100).toFixed(0)}% (${r.passed}/${r.cases}), avg cost $${r.avgCostUsd.toFixed(5)} per answer, avg time ${r.avgLatencyS.toFixed(1)} s per answer
`,
          );

      const gate = summaries.find((s) => s.setup === GATE);
      if (gate)
        expect(
          gate.passRate,
          `${gate.name} passed ${gate.passed}/${gate.cases}`,
        ).toBeGreaterThanOrEqual(PASS_RATE);
    },
    30 * 60_000,
  );
});
