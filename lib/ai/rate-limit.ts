// Module 5: free Gemini keys allow about 15 model calls a minute. The golden-set
// eval makes many calls in a row, so with AI_MAX_CALLS_PER_MINUTE set, each
// model call waits its turn to stay under that limit. Unset (the app), calls
// never wait.

const WINDOW_MS = 60_000;
const started: number[] = [];
let queue: Promise<void> = Promise.resolve();
let waited = 0;

/** How long calls have waited for their turn so far, in ms (for the evals). */
export function waitedMs(): number {
  return waited;
}

function limit(): number {
  const value = Number(process.env.AI_MAX_CALLS_PER_MINUTE);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Waits until one more model call fits in the last minute's limit. */
export function waitForTurn(): Promise<void> {
  const max = limit();
  if (!max) return Promise.resolve();
  const asked = Date.now();
  const turn = queue.then(async () => {
    for (;;) {
      const now = Date.now();
      while (started.length && now - started[0] >= WINDOW_MS) started.shift();
      if (started.length < max) {
        started.push(now);
        waited += now - asked;
        return;
      }
      await sleep(WINDOW_MS - (now - started[0]) + 50);
    }
  });
  queue = turn;
  return turn;
}
