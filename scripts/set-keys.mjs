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
      const value = line
        .slice(at + 1)
        .trim()
        .replace(/^"|"$/g, "");
      return [line.slice(0, at).trim(), value];
    })
    .filter(([, value]) => value);
  return new Map(entries);
}

const env = readEnv();
// `npm run keys -- --github` skips the prompts: it sends the keys already in
// .env.local (pasted there in a text editor) to the Actions secrets.
const onlyGithub = process.argv.includes("--github");
for (const key of onlyGithub ? [] : KEYS) {
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

if (!onlyGithub) {
  const lines = [...env].map(([name, value]) => `${name}="${value}"`);
  writeFileSync(FILE, `${lines.join("\n")}\n`);
  console.log(`Saved in ${FILE}.`);
}

const missing = KEYS.filter((k) => !env.get(k.name)).map((k) => k.name);
if (missing.length) {
  console.log(`Still missing: ${missing.join(", ")}. Add them to ${FILE}.`);
  process.exit(1);
}

// The student's own repo (origin), not the course repo.
const repo = spawnSync("git", ["remote", "get-url", "origin"], {
  encoding: "utf8",
}).stdout.trim();
for (const { name } of KEYS) {
  const result = spawnSync("gh", ["secret", "set", name, "--repo", repo], {
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
