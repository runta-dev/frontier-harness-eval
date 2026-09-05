// Build a shareable report for a candidate harness: REPORT.md plus a self-contained
// index.html with the chart inlined.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SOURCE_EVAL = "https://frontierharness.org/";

const args = parseArgs(process.argv.slice(2));
const runDir = args.run ?? die("usage: build-report.mjs --run runs/<run-id> [--baseline results/eval-data.json]");
const baselinePath = args.baseline ?? "results/eval-data.json";

const labels = {
  "pi-responses": "Pi", "oh-my-pi": "Oh My Pi", "claude-code": "Claude Code", codex: "Codex",
  opencode: "OpenCode", hermes: "Hermes", "kimi-code": "Kimi Code", exo: "Exo Harness",
  "dsh-standard": "DSH Standard", "dsh-ptc": "DSH PTC", "dsh-minimal": "DSH Minimal",
  "dsh-creator": "DSH Creator",
};

const baseline = await readJson(baselinePath, `baseline not found at ${baselinePath}; pass --baseline <path to eval-data.json>`);
const candidate = await readJson(join(runDir, "candidate.json"), `candidate.json not found in ${runDir}; run normalize-results.mjs first`);
const run = await readJson(join(runDir, "run.json"), `run.json not found in ${runDir}`);
// eval-data.json carries an internal model slug ("k3"); benchmark.json has the
// readable name ("Kimi K3"), which is what a candidate model id can be matched against.
const benchmark = await readJsonOrNull(args.benchmark ?? "benchmark.json");
const baselineModel = benchmark?.model ?? baseline.model;
const baselineProvider = benchmark?.model_provider ?? null;
const comparable = candidate.comparable === true;
const manifest = await readJsonOrNull(join(runDir, "trials", firstTrialDir(candidate), "manifest.json"));

const reportDir = join(runDir, "report");
await mkdir(reportDir, { recursive: true });
const chart = await readFile(join(reportDir, "chart.svg"), "utf8").catch(() => null);
if (!chart) die("chart.svg not found; run generate-chart.mjs first");

const rows = [
  ...baseline.harnesses.map(item => ({
    label: labels[item.name] ?? item.name,
    passRate: item.pass_rate,
    cost: item.effective_cost_per_pass,
    cache: item.cache_hit_rate_typical,
    duration: item.median_duration_seconds,
    isCandidate: false,
  })),
  {
    label: candidate.label,
    passRate: candidate.pass_rate,
    cost: candidate.effective_cost_per_pass,
    cache: candidate.cache_hit_rate_typical,
    duration: candidate.median_duration_seconds,
    isCandidate: true,
  },
].sort((a, b) => b.passRate - a.passRate || a.label.localeCompare(b.label));

const rank = rows.findIndex(row => row.isCandidate) + 1;
if (!comparable) rows.sort((a, b) => Number(a.isCandidate) - Number(b.isCandidate) || b.passRate - a.passRate || a.label.localeCompare(b.label));
const rankingClause = comparable ? `ranking **${rank} of ${rows.length}** on pass rate against the published configurations` : `**subset evaluation; not ranked against the ${candidate.expected}-task leaderboard**`;
const percent = value => typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "n/a";
const money = value => typeof value === "number" ? `$${value.toFixed(2)}` : "n/a";
const duration = value => {
  if (typeof value !== "number") return "n/a";
  const seconds = Math.round(value);
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
};

const comparison = rows.map((row, index) => {
  const name = row.isCandidate ? `**${row.label}**` : row.label;
  return `| ${row.isCandidate && !comparable ? '—' : String(index + 1).padStart(2, "0")} | ${name} | ${percent(row.passRate)} | ${money(row.cost)} | ${percent(row.cache)} | ${duration(row.duration)} |`;
}).join("\n");

const taskRows = candidate.task_details.map(task => {
  const mark = task.status === "success" ? "pass" : task.status === "infra_invalid" ? "invalid" : task.status;
  return `| \`${task.id}\` | ${mark} | ${money(task.cost_first_cold_usd)} | ${duration(task.duration_seconds)} | ${task.turns ?? "n/a"} | [evidence](../${task.evidence}) |`;
}).join("\n");

const modelDiffers = Boolean(candidate.model && baselineModel
  && modelKey(candidate.model) !== modelKey(baselineModel));
const providerDiffers = Boolean(candidate.provider && baselineProvider
  && modelKey(candidate.provider) !== modelKey(baselineProvider));

const caveats = [
  !comparable ? `Only ${candidate.completed} of ${candidate.expected} published tasks were scored. This subset is not comparable to the published leaderboard and receives no rank.` : null,
  "This workflow uses one shared checkpoint with images normally pulled after each restore. The published baselines used per-task checkpoints; the environments are not identical.",
  manifest?.deep_swe_commit
    ? `DeepSWE ran at commit \`${manifest.deep_swe_commit}\`. The default 435ee89 corpus uses separate-verifier images that differ from the repository's frozen public task metadata. Reproducing a published score requires a control run; matching the task names alone does not establish equivalence.`
    : null,
  manifest?.harness_topology && manifest.harness_topology !== "container-cli"
    ? `The harness topology was \`${manifest.harness_topology}\`; the published baselines used CLIs inside task containers. Custom registration is supported, but does not by itself establish equivalent isolation, resources, or state reset.`
    : null,
  manifest?.system_runc_workaround
    ? "Provisioning enabled the system-runc workaround for Runta's injected-init hang; the resolved runc path is recorded in the manifest."
    : null,
  candidate.cost_coverage < 1
    ? `Cost was captured for ${(candidate.cost_coverage * 100).toFixed(0)}% of tasks, so cost figures are partial.`
    : null,
  candidate.infra_invalid
    ? `${candidate.infra_invalid} trial(s) failed on infrastructure and were excluded from scoring rather than counted as failures.`
    : null,
  modelDiffers
    ? `The candidate ran on \`${candidate.model}\` while the baselines ran on \`${baselineModel}\`. Harness and model effects are not separable across this gap.`
    : null,
  // Same model from a different provider keeps pass rate comparable, but cost only
  // holds if that provider's token prices match the ones behind the baselines. A model
  // mismatch subsumes this, so it is not worth saying twice.
  !modelDiffers && providerDiffers
    ? `${baselineModel} was served by ${candidate.provider === "custom" ? `a custom route (\`${candidate.model}\`)` : candidate.provider} rather than ${baselineProvider}, which the baselines used. Pass rate stays comparable because the model is the same; confirm the provider's input, cached-input, and output token prices match before comparing cost.`
    : null,
  "Baseline costs reprice first-turn cache reads consistently across harnesses. The comparison uses `effective_cost_per_pass` (total cost over all tasks divided by passes), which is reproducible from raw per-task cost.",
].filter(Boolean).map(item => `- ${item}`).join("\n");

const hasCost = typeof candidate.effective_cost_per_pass === "number";
const costClause = hasCost ? ` at **${money(candidate.effective_cost_per_pass)} per pass**` : "";

const markdown = `# ${candidate.label} on FrontierHarness Eval

**${percent(candidate.pass_rate)} pass rate** (${candidate.successful}/${candidate.completed} tasks)${costClause}; ${rankingClause}.

![Pass rate versus effective cost per pass, ${candidate.label} against the FrontierHarness Eval baselines](chart.svg)

## Result

| Metric | Value |
| --- | --- |
| Pass rate | ${percent(candidate.pass_rate)} |
| Tasks passed | ${candidate.successful} / ${candidate.completed} |
| Effective cost per pass | ${money(candidate.effective_cost_per_pass)} |
| Median cost per successful task | ${money(candidate.median_cost_per_success)} |
| Median time per successful task | ${duration(candidate.median_duration_seconds)} |
| Median cache hit rate | ${percent(candidate.cache_hit_rate_typical)} |
| Mean turns | ${typeof candidate.mean_turns === "number" ? candidate.mean_turns.toFixed(1) : "n/a"} |

## Comparison

| # | Harness | Pass rate | Effective cost per pass | Cache, median | Median time |
| --- | --- | --- | --- | --- | --- |
${comparison}

## Reproducibility

| Field | Value |
| --- | --- |
| Run id | \`${run.run_id}\` |
| Golden checkpoint | \`${run.checkpoint}\` |
| Model | \`${candidate.model ?? "unspecified"}\` |
| Provider | ${candidate.provider ? `\`${candidate.provider}\`` : "unspecified"} |
| Harness repo | ${manifest?.harness_repo ? `\`${manifest.harness_repo}\`` : "see manifest"} |
| Harness commit | \`${manifest?.harness_commit ?? "unknown"}\` |
| Runtime | ${manifest ? `${manifest.cpus} vCPU, ${manifest.memory_mib} MiB` : "see manifest"} |
| Harbor | \`${manifest?.harbor_version ?? "unknown"}\` |
| Pier | \`${manifest?.pier_version ?? "unknown"}\` |
| DeepSWE corpus | \`${manifest?.deep_swe_commit ?? "unknown"}\` |
| Started | ${run.started_at ?? "unknown"} |

Every trial restores the same base checkpoint with the same configured vCPU, memory, and disk capacity. Task images are normally pulled after restore. No formal task was executed before the checkpoint was frozen.

## Task results

| Task | Result | Cost | Time | Turns | Evidence |
| --- | --- | --- | --- | --- | --- |
${taskRows}

Each evidence directory holds the agent trajectory, verifier logs, the collected \`model.patch\`, and raw runner output for that trial.

## Caveats

${caveats}

---

Baseline data and methodology: [FrontierHarness Eval](${SOURCE_EVAL})
`;

await writeFile(join(reportDir, "REPORT.md"), markdown);

const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>${escapeHtml(candidate.label)} on FrontierHarness Eval</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 48px 24px; background: #020202; color: #ededed;
         font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; }
  main { max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 28px; margin: 0 0 8px; }
  h2 { font-size: 18px; margin: 40px 0 12px; font-weight: 600; }
  p.lede { color: #b9b9b9; margin: 0 0 32px; }
  strong { color: #ff6418; }
  svg { width: 100%; height: auto; display: block; border-radius: 12px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #1c1c1c; }
  th { color: #8a8a8a; font-weight: 500; }
  tr.candidate td { color: #ff6418; }
  a { color: #ff6418; }
  footer { margin-top: 48px; padding-top: 20px; border-top: 1px solid #1c1c1c; color: #706a63; font-size: 13px; }
</style>
<main>
  <h1>${escapeHtml(candidate.label)} on FrontierHarness Eval</h1>
  <p class="lede"><strong>${percent(candidate.pass_rate)}</strong> pass rate (${candidate.successful}/${candidate.completed} tasks)${hasCost ? `
     at <strong>${money(candidate.effective_cost_per_pass)}</strong> per pass` : ""}; ${comparable ? `ranking ${rank} of ${rows.length}` : `subset evaluation; not ranked against the ${candidate.expected}-task leaderboard`}.
     Model <code>${escapeHtml(candidate.model ?? "unspecified")}</code>,
     golden checkpoint <code>${escapeHtml(run.checkpoint)}</code>.</p>
  ${chart.replace(/^<\?xml[^>]*\?>\s*/, "")}
  <h2>Comparison</h2>
  <table>
    <tr><th>#</th><th>Harness</th><th>Pass rate</th><th>Effective cost per pass</th><th>Cache, median</th><th>Median time</th></tr>
    ${rows.map((row, index) => `<tr${row.isCandidate ? ' class="candidate"' : ""}><td>${row.isCandidate && !comparable ? '—' : index + 1}</td><td>${escapeHtml(row.label)}</td><td>${percent(row.passRate)}</td><td>${money(row.cost)}</td><td>${percent(row.cache)}</td><td>${duration(row.duration)}</td></tr>`).join("\n    ")}
  </table>
  <h2>Reproducibility caveats</h2>
  <ul>${caveats.split('\n').map(line => `<li>${escapeHtml(line.replace(/^- /, ''))}</li>`).join('')}</ul>
  <h2>Task results</h2>
  <table>
    <tr><th>Task</th><th>Result</th><th>Cost</th><th>Time</th><th>Turns</th></tr>
    ${candidate.task_details.map(task => `<tr><td><code>${escapeHtml(task.id)}</code></td><td>${task.status}</td><td>${money(task.cost_first_cold_usd)}</td><td>${duration(task.duration_seconds)}</td><td>${task.turns ?? "n/a"}</td></tr>`).join("\n    ")}
  </table>
  <footer>Baseline data and methodology: <a href="${SOURCE_EVAL}">FrontierHarness Eval</a></footer>
</main>
</html>
`;

await writeFile(join(reportDir, "index.html"), html);

console.log(`${candidate.label}: ${percent(candidate.pass_rate)} pass rate, ${comparable ? `rank ${rank} of ${rows.length}` : 'subset not ranked'}`);
console.log(`wrote ${join(reportDir, "REPORT.md")}`);
console.log(`wrote ${join(reportDir, "index.html")}`);
console.log(`share: gh gist create ${join(reportDir, "REPORT.md")} ${join(reportDir, "chart.svg")} --public`);

// "fireworks_ai/accounts/fireworks/models/kimi-k3" and "Kimi K3" are the same model, so
// compare on a key that drops the provider route, case, and separators.
function modelKey(value) {
  return String(value).toLowerCase().split("/").pop().replace(/[^a-z0-9]/g, "");
}

function firstTrialDir(record) {
  const withEvidence = record.task_details.find(task => task.evidence);
  return withEvidence ? withEvidence.evidence.replace(/^trials\//, "") : "";
}

async function readJsonOrNull(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function readJson(path, message) {
  const parsed = await readJsonOrNull(path);
  return parsed ?? die(message);
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
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
