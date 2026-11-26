// npm run keys: asks for the Module 5 keys in hidden prompts (nothing shows on
// screen or in the chat), saves them in .env.local for `npm run dev` and
// `npm run eval`, and in the GitHub repo's Actions secrets for CI.
// Press Enter at a prompt to keep the value already in .env.local.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const KEYS = [
  { name: "GOOGLE_GENERATIVE_AI_API_KEY", hidden: true },
  { name: "LANGFUSE_PUBLIC_KEY", hidden: true },
  { name: "LANGFUSE_SECRET_KEY", hidden: true },
  {
    name: "LANGFUSE_BASE_URL",
    hidden: false,
    fallback: "https://cloud.langfuse.com",
  },
];
const FILE = ".env.local";

function ask(question, hidden) {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    if (hidden) {
      // Print the question, then echo nothing while the key is typed.
      rl._writeToOutput = (text) => {
        if (text.includes(question)) rl.output.write(text);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

function readEnv() {
  if (!existsSync(FILE)) return new Map();
  const entries = readFileSync(FILE, "utf8")
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1).replace(/^"|"$/g, "")];
    });
  return new Map(entries);
}

const env = readEnv();
for (const key of KEYS) {
  const current = env.get(key.name);
  const hint = current
    ? " (Enter keeps the saved one)"
    : key.fallback
      ? ` (Enter for ${key.fallback})`
      : "";
  const value = await ask(`${key.name}${hint}: `, key.hidden);
  if (value) env.set(key.name, value);
  else if (!current && key.fallback) env.set(key.name, key.fallback);
}

const lines = [...env].map(([name, value]) => `${name}="${value}"`);
writeFileSync(FILE, `${lines.join("\n")}\n`);
console.log(`Saved in ${FILE}.`);

const missing = KEYS.filter((k) => !env.get(k.name)).map((k) => k.name);
if (missing.length) {
  console.log(`Still missing: ${missing.join(", ")}. Run npm run keys again.`);
  process.exit(1);
}

for (const { name } of KEYS) {
  const result = spawnSync("gh", ["secret", "set", name], {
    input: env.get(name),
    encoding: "utf8",
    stdio: ["pipe", "ignore", "pipe"],
  });
  if (result.status !== 0) {
    console.log(
      `Couldn't save ${name} in GitHub: ${result.stderr?.trim() || "is gh installed and signed in?"}`,
    );
    process.exit(1);
  }
}
console.log("Saved in the GitHub repo's Actions secrets too.");
