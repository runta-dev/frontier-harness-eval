// Fold per-task trial.json files into a candidate harness record that uses the same
// field names and definitions as results/eval-data.json.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const args = parseArgs(process.argv.slice(2));
const runDir = args.run ?? die("usage: normalize-results.mjs --run runs/<run-id> [--label \"My Harness\"] [--name my-harness]");

let run;
try {
  run = JSON.parse(await readFile(join(runDir, "run.json"), "utf8"));
} catch {
  die(`run.json not found in ${runDir}; run run-trials.sh first`);
}

const trialsDir = join(runDir, "trials");
const entries = (await readdir(trialsDir, { withFileTypes: true }).catch(() => die(`no trials directory in ${runDir}`)))
  .filter(entry => entry.isDirectory());

const trials = [];
for (const entry of entries) {
  const path = join(trialsDir, entry.name, "trial.json");
  try {
    trials.push({ ...JSON.parse(await readFile(path, "utf8")), evidence: join("trials", entry.name) });
  } catch {
    console.warn(`skipping ${entry.name}: no readable trial.json`);
  }
}
if (!trials.length) die(`no trials found in ${trialsDir}`);

// An infra failure is not a harness failure, so it is reported but never scored.
const invalid = trials.filter(trial => trial.status === "infra_invalid");
const scored = trials.filter(trial => trial.status !== "infra_invalid");
const passes = scored.filter(trial => trial.success);

const costs = numbers(scored.map(trial => trial.cost_first_cold_usd));
const totalCost = costs.reduce((sum, value) => sum + value, 0);
const costCoverage = scored.length ? costs.length / scored.length : 0;
const benchmark = JSON.parse(await readFile(args.benchmark ?? 'benchmark.json', 'utf8'));
const expected = benchmark.task_count;

const candidate = {
  name: args.name ?? run.harness,
  label: args.label ?? run.harness,
  model: run.model,
  provider: run.provider ?? null,
  checkpoint: run.checkpoint,
  run_id: run.run_id,
  candidate: true,
  expected,
  comparable: scored.length === expected,
  completed: scored.length,
  successful: passes.length,
  infra_invalid: invalid.length,
  pass_rate: scored.length ? passes.length / scored.length : null,

  // Reproducible from raw per-task cost, so directly comparable to the baseline field.
  effective_cost_per_pass: passes.length && costCoverage === 1 ? totalCost / passes.length : null,
  total_cost_usd: costs.length ? totalCost : null,
  median_cost_per_task: median(costs),
  median_cost_per_success: median(numbers(passes.map(trial => trial.cost_first_cold_usd))),

  // The baseline *_normalized fields reprice first-turn cache reads using data that is
  // not public, so they stay null rather than being filled with a different basis.
  cost_per_success_normalized: null,
  median_cost_per_success_normalized: null,

  median_duration_seconds: median(numbers(passes.map(trial => trial.duration_seconds))),
  cache_hit_rate_typical: median(numbers(passes.map(trial => trial.cache_hit_rate_normalized))),
  cache_hit_rate_typical_n: numbers(passes.map(trial => trial.cache_hit_rate_normalized)).length,
  mean_turns: mean(numbers(passes.map(trial => trial.turns))),

  cost_coverage: costCoverage,
  duration_coverage: coverage(scored, "duration_seconds"),
  turns_coverage: coverage(scored, "turns"),
  cache_coverage: coverage(scored, "cache_hit_rate_normalized"),

  task_details: trials.map(trial => ({
    id: trial.id,
    title: trial.title,
    status: trial.status,
    success: Boolean(trial.success),
    cost_first_cold_usd: trial.cost_first_cold_usd ?? null,
    duration_seconds: trial.duration_seconds ?? null,
    turns: trial.turns ?? null,
    cache_hit_rate_normalized: trial.cache_hit_rate_normalized ?? null,
    included_in_efficiency: Boolean(trial.success),
    evidence: trial.evidence,
  })),
};

const out = join(runDir, "candidate.json");
await writeFile(out, `${JSON.stringify(candidate, null, 2)}\n`);

console.log(`${candidate.label}: ${passes.length}/${scored.length} passed (${(candidate.pass_rate * 100).toFixed(1)}%)`);
if (invalid.length) console.log(`${invalid.length} trial(s) marked infra_invalid and excluded from scoring`);
if (scored.length && costCoverage < 1) console.log(`cost missing for ${scored.length - costs.length} task(s); effective_cost_per_pass left null`);
if (!scored.length) console.log("no scoreable trials: every trial was infra_invalid");
console.log(`wrote ${out}`);

function numbers(values) {
  return values.filter(value => typeof value === "number" && Number.isFinite(value));
}

function coverage(items, field) {
  return items.length ? numbers(items.map(item => item[field])).length / items.length : 0;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return sorted.length % 2 ? sorted[Math.floor(mid)] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith("--")) parsed[argv[index].slice(2)] = argv[index + 1];
  }
  return parsed;
}

function die(message) {
  console.error(message);
  process.exit(2);
}
