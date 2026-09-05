// Plot a candidate harness against the published FrontierHarness baselines:
// a pass-rate versus cost scatter plus a pass-rate ranking panel.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const args = parseArgs(process.argv.slice(2));
const runDir = args.run ?? die("usage: generate-chart.mjs --run runs/<run-id> [--baseline results/eval-data.json]");
const baselinePath = args.baseline ?? "results/eval-data.json";

const labels = {
  "pi-responses": "Pi", "oh-my-pi": "Oh My Pi", "claude-code": "Claude Code", codex: "Codex",
  opencode: "OpenCode", hermes: "Hermes", "kimi-code": "Kimi Code", exo: "Exo Harness",
  "dsh-standard": "DSH Standard", "dsh-ptc": "DSH PTC", "dsh-minimal": "DSH Minimal",
  "dsh-creator": "DSH Creator",
};

const baseline = await readJson(baselinePath, `baseline not found at ${baselinePath}; pass --baseline <path to eval-data.json>`);
const candidate = await readJson(join(runDir, "candidate.json"), `candidate.json not found in ${runDir}; run normalize-results.mjs first`);
const comparable = candidate.comparable === true;

const points = [
  ...baseline.harnesses.map(item => ({
    label: labels[item.name] ?? item.name,
    passRate: item.pass_rate,
    cost: item.effective_cost_per_pass,
    isCandidate: false,
  })),
  {
    label: candidate.label,
    passRate: candidate.pass_rate,
    cost: candidate.effective_cost_per_pass,
    isCandidate: true,
  },
];

const eligible = points.filter(point => !point.isCandidate || comparable);
const plotted = eligible.filter(point => typeof point.cost === "number" && point.cost > 0);
const costMissing = points.length - plotted.length;

const width = 1200;
const pad = 24;
const accent = "#ff6418";
const scatterHeight = 420;
const rowHeight = 24;
const listTop = 60;
const panelHeight = listTop + points.length * rowHeight + 16;
const height = pad * 2 + scatterHeight + 20 + panelHeight;

// Cost spans more than an order of magnitude across harnesses, so use a log axis.
// Bounds snap to the 1-2-5 ladder rather than to powers of ten, which would leave
// most of the axis empty for a set clustered between $1 and $20.
const ladder = [];
for (let exponent = -3; exponent <= 4; exponent += 1) {
  for (const step of [1, 2, 5]) ladder.push(step * Math.pow(10, exponent));
}
const costs = plotted.map(point => point.cost);
const minCost = Math.min(...costs, 1);
const maxCost = Math.max(...costs, 2);
const domain = [
  [...ladder].reverse().find(value => value <= minCost) ?? minCost,
  ladder.find(value => value >= maxCost) ?? maxCost,
];
const rates = eligible.map(point => point.passRate);
const rateMin = Math.max(0, Math.floor((Math.min(...rates) - 0.05) * 20) / 20);
const rateMax = Math.min(1, Math.ceil((Math.max(...rates) + 0.05) * 20) / 20);

const plot = { left: pad + 62, right: width - pad - 20, top: pad + 62, bottom: pad + scatterHeight - 40 };
const scaleX = value => plot.left + (Math.log10(value) - Math.log10(domain[0])) / (Math.log10(domain[1]) - Math.log10(domain[0])) * (plot.right - plot.left);
const scaleY = value => plot.bottom - (value - rateMin) / (rateMax - rateMin) * (plot.bottom - plot.top);

const esc = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const money = value => Number.isInteger(value) ? `$${value}` : `$${value.toFixed(2)}`;
const percent = value => `${(value * 100).toFixed(1)}%`;

const xTicks = ladder.filter(value => value >= domain[0] && value <= domain[1]);
const yTicks = [];
for (let value = rateMin; value <= rateMax + 1e-9; value += 0.05) yTicks.push(Number(value.toFixed(2)));

const grid = [
  ...xTicks.map(tick => `<line class="grid" x1="${scaleX(tick).toFixed(1)}" y1="${plot.top}" x2="${scaleX(tick).toFixed(1)}" y2="${plot.bottom}"/>`
    + `<text class="tick" x="${scaleX(tick).toFixed(1)}" y="${plot.bottom + 18}" text-anchor="middle">${money(tick)}</text>`),
  ...yTicks.map(tick => `<line class="grid" x1="${plot.left}" y1="${scaleY(tick).toFixed(1)}" x2="${plot.right}" y2="${scaleY(tick).toFixed(1)}"/>`
    + `<text class="tick" x="${plot.left - 10}" y="${(scaleY(tick) + 3.5).toFixed(1)}" text-anchor="end">${percent(tick)}</text>`),
].join("");

// Labels are placed left to right so neighbours are known, then nudged vertically off
// any label already placed. Labels near an edge switch anchor so they stay in frame.
const offsets = [-13, 20, -26, 33, -39, 46, -52, 59];
const boxes = [];
const dotObstacles = plotted.map(point => ({
  x: scaleX(point.cost),
  y: scaleY(point.passRate),
  r: point.isCandidate ? 7 : 5,
}));
const placements = [...plotted]
  .sort((a, b) => a.cost - b.cost)
  .map(point => {
    const x = scaleX(point.cost);
    const y = scaleY(point.passRate);
    const text = `${point.label} · ${percent(point.passRate)} · ${money(point.cost)}`;
    const half = text.length * 2.95;
    const minX = pad + 12;
    const maxX = width - pad - 12;

    let anchor = "middle";
    let labelX = x;
    if (x - half < minX) {
      anchor = "start";
      labelX = minX;
    } else if (x + half > maxX) {
      anchor = "end";
      labelX = maxX;
    }
    const left = anchor === "start" ? labelX : anchor === "end" ? labelX - half * 2 : labelX - half;
    const right = left + half * 2;

    let labelY = y + offsets[0];
    for (const offset of offsets) {
      labelY = y + offset;
      const hitsLabel = boxes.some(box => right > box.left && left < box.right && Math.abs(box.y - labelY) < 12);
      const hitsDot = dotObstacles.some(dot =>
        dot.x + dot.r > left && dot.x - dot.r < right && Math.abs(dot.y - labelY) < dot.r + 4);
      if (!hitsLabel && !hitsDot) break;
    }
    labelY = Math.min(Math.max(labelY, plot.top - 4), plot.bottom + 26);
    boxes.push({ left, right, y: labelY });
    return { point, x, y, labelX, labelY, anchor, text };
  });

const dots = placements
  .sort((a, b) => Number(a.point.isCandidate) - Number(b.point.isCandidate))
  .map(({ point, x, y, labelX, labelY, anchor, text }) => {
    const halo = point.isCandidate
      ? `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="13" fill="none" stroke="${accent}" stroke-opacity="0.35"/>`
      : "";
    return halo
      + `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${point.isCandidate ? 7 : 5}" fill="${point.isCandidate ? accent : "#5f6672"}"/>`
      + `<text class="${point.isCandidate ? "dot-label-candidate" : "dot-label"}" x="${labelX.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="${anchor}">${esc(text)}</text>`;
  }).join("");

const ranked = [...eligible].sort((a, b) => b.passRate - a.passRate || a.label.localeCompare(b.label));
const barLeft = pad + 20 + 20 + 140;
const barWidth = width - pad * 2 - 40 - 20 - 140 - 80;
const list = ranked.map((point, index) => {
  const center = pad + scatterHeight + 20 + listTop + index * rowHeight + rowHeight / 2;
  const baselineY = center + 3.8;
  const fill = Math.max(point.passRate / Math.max(...rates, 0.01) * barWidth, 2);
  return `<text class="rank" x="${pad + 20}" y="${baselineY}">${String(index + 1).padStart(2, "0")}</text>`
    + `<text class="${point.isCandidate ? "name-candidate" : "name"}" x="${pad + 20 + 28}" y="${baselineY}">${esc(point.label)}</text>`
    + `<rect class="track" x="${barLeft}" y="${center - 7}" width="${barWidth}" height="14"/>`
    + `<rect x="${barLeft}" y="${center - 7}" width="${fill.toFixed(1)}" height="14" fill="${point.isCandidate ? accent : "#5f6672"}"/>`
    + `<text class="value" x="${width - pad - 20}" y="${baselineY}" text-anchor="end">${percent(point.passRate)}</text>`;
}).join("");

const note = !comparable
  ? `<text class="note" x="${plot.left}" y="${plot.bottom + 22}">Candidate excluded from comparison: ${candidate.successful}/${candidate.completed} passed; ${candidate.completed}/${candidate.expected} tasks scored. Subset is not ranked.</text>`
  : costMissing
  ? `<text class="note" x="${plot.left}" y="${plot.bottom + 22}">${costMissing} harness omitted from the scatter: cost unavailable</text>`
  : "";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(candidate.label)} compared with the FrontierHarness Eval baselines by pass rate and effective cost per pass" shape-rendering="geometricPrecision" text-rendering="geometricPrecision">
  <rect width="${width}" height="${height}" fill="#020202"/>
  <style>
    text{font-family:Arial,Helvetica,sans-serif}
    .title{fill:#ededed;font-size:17px}
    .subtitle{fill:#8a8a8a;font-size:11px}
    .axis{fill:#8a8a8a;font-size:11px}
    .tick,.rank,.value,.note,.dot-label,.dot-label-candidate{font-family:"SFMono-Regular",Menlo,monospace}
    .tick{fill:#6a6a6a;font-size:9px}
    .grid{stroke:#161616}
    .dot-label{fill:#9aa0aa;font-size:9px}
    .dot-label-candidate{fill:${accent};font-size:10px}
    .name{fill:#b9b9b9;font-size:11px}
    .name-candidate{fill:${accent};font-size:11px}
    .rank{fill:#5a5a5a;font-size:9px}
    .value{fill:#ededed;font-size:11px}
    .note{fill:#706a63;font-size:9px}
    .track{fill:#1a1a1a}
  </style>
  <rect x="${pad}" y="${pad}" width="${width - pad * 2}" height="${scatterHeight}" rx="12" fill="#0a0a0a" stroke="#242424"/>
  <text class="title" x="${pad + 20}" y="${pad + 28}">${esc(candidate.label)} versus FrontierHarness Eval v1.0</text>
  <text class="subtitle" x="${pad + 20}" y="${pad + 46}">Pass rate against effective cost per pass · model ${esc(candidate.model ?? "unspecified")} · ${candidate.completed} tasks</text>
  ${grid}
  <text class="axis" x="${(plot.left + plot.right) / 2}" y="${plot.bottom + 38}" text-anchor="middle">Effective cost per pass (log scale)</text>
  <text class="axis" transform="translate(${pad + 22} ${(plot.top + plot.bottom) / 2}) rotate(-90)" text-anchor="middle">Pass rate</text>
  ${dots}
  ${note}
  <rect x="${pad}" y="${pad + scatterHeight + 20}" width="${width - pad * 2}" height="${panelHeight}" rx="12" fill="#0a0a0a" stroke="#242424"/>
  <text class="title" x="${pad + 20}" y="${pad + scatterHeight + 51}">Pass rate</text>
  <line x1="${pad + 20}" y1="${pad + scatterHeight + 68}" x2="${width - pad - 20}" y2="${pad + scatterHeight + 68}" stroke="#1c1c1c"/>
  ${list}
</svg>`;

const reportDir = join(runDir, "report");
await mkdir(reportDir, { recursive: true });
await writeFile(join(reportDir, "chart.svg"), svg);

const rank = ranked.findIndex(point => point.isCandidate) + 1;
console.log(comparable ? `${candidate.label} ranks ${rank} of ${ranked.length} on pass rate` : `${candidate.label}: subset is not ranked`);
console.log(`wrote ${join(reportDir, "chart.svg")}`);

async function readJson(path, message) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return die(message);
  }
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
