#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.FAKE_RUNTA_ROOT;
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json')));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(root, 'executions.jsonl'), JSON.stringify(args) + '\n');
if (config.runnerCrash) process.exit(23);
const index = args.indexOf('--jobs-dir');
if (index < 0 || args.includes('--output-dir')) process.exit(2);
const jobs = path.join(args[index + 1], 'job', 'trial');
fs.mkdirSync(jobs, { recursive: true });
const result = config.result || { verifier_result: { rewards: { reward: 1 } }, total_cost_usd: 2.5 };
fs.writeFileSync(path.join(jobs, 'result.json'), JSON.stringify(result));
fs.writeFileSync(path.join(jobs, 'trajectory.json'), JSON.stringify({ steps: [{ reward: 1 }] }));
fs.writeFileSync(path.join(jobs, 'model.patch'), 'test patch evidence\n');
console.log('verifier finished');
