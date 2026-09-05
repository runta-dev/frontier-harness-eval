import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, symlinkSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const scripts = join(repo, 'skills/frontierharness-eval/scripts');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

function fixture(t, config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fh-pipeline-'));
  t.after(() => process.env.KEEP_FH_FIXTURES ? t.diagnostic(root) : rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  mkdirSync(join(root, 'home'));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_RUNTA_ROOT: root,
    FH_RETRY_DELAY: '0', FH_POLL_INTERVAL: '0.02', FH_TRANSPORT_ATTEMPTS: '3' };
  const executable = (name, content) => writeFileSync(join(bin, name), content, { mode: 0o755 });
  const node = process.execPath;
  executable('runta', `#!/bin/sh\nexec ${quote(node)} ${quote(join(repo, 'tests/fixtures/runta.cjs'))} "$@"\n`);
  for (const name of ['harbor', 'pier']) executable(name, `#!/bin/sh\nexec ${quote(node)} ${quote(join(repo, 'tests/fixtures/runner.cjs'))} ${name} "$@"\n`);
  executable('docker', '#!/bin/sh\necho "pulled $*"\n');
  // Portable implementations of the Linux process primitives used by the worker,
  // so these integration tests also run on the maintainer's macOS workstation.
  executable('setsid', '#!/usr/bin/env python3\nimport os, sys\nos.setsid()\nos.execvp(sys.argv[1], sys.argv[1:])\n');
  executable('flock', '#!/usr/bin/env python3\nimport fcntl, sys\ntry: fcntl.flock(int(sys.argv[-1]), fcntl.LOCK_EX | fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(1)\n');
  executable('timeout', '#!/usr/bin/env python3\nimport json, os, sys\na = sys.argv[1:]\nif a[0].startswith("--kill-after"): a.pop(0)\na.pop(0)\nc = json.load(open(os.path.join(os.environ["FAKE_RUNTA_ROOT"], "config.json")))\nif c.get("runnerTimeout") and a[0] == "bash": sys.exit(124)\nos.execvp(a[0], a)\n');
  executable('sha256sum', '#!/bin/sh\nexec shasum -a 256 "$@"\n');
  writeFileSync(join(root, 'home/.bash_profile'), `export PATH=${quote(env.PATH)}\n`);
  const setConfig = value => writeFileSync(join(root, 'config.json'), JSON.stringify(value));
  setConfig(config);
  const tasks = join(root, 'tasks.txt');
  writeFileSync(tasks, 'datacurve/httpx-multipart-response-parsing\n');
  const execute = (script, args = []) => spawnSync('bash', [join(scripts, script), ...args], {
    cwd: root, env, encoding: 'utf8', timeout: 20000,
  });
  const run = (extra = []) => execute('run-trials.sh', ['--checkpoint', 'golden', '--harness', 'pi-responses',
    '--run-id', 'control', '--tasks', tasks, '--out', join(root, 'runs'), '--timeout', '5', ...extra]);
  const trialDir = join(root, 'runs/control/trials/datacurve-httpx-multipart-response-parsing');
  const json = file => JSON.parse(readFileSync(file, 'utf8'));
  const lines = file => existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  return { root, env, tasks, run, execute, setConfig, trialDir, trial: () => json(join(trialDir, 'trial.json')),
    calls: () => lines('calls.jsonl'), executions: () => lines('executions.jsonl') };
}
const ok = result => assert.equal(result.status, 0, `${result.error || ''}\n${result.stderr}\n${result.stdout}`);

test('detached execution survives lost launch ACK and poll; verifies copies despite a CLI error', t => {
  const f = fixture(t, { launchDisconnects: 1, pollFailures: 1, copyFailures: 1, copyReturnsError: true });
  ok(f.run());
  assert.equal(f.trial().status, 'success');
  assert.equal(f.trial().cost_first_cold_usd, 2.5);
  assert.equal(f.executions().length, 1, 'transport retries must not rerun the harness');
  assert.ok(f.executions()[0].includes('--jobs-dir'));
  assert.equal(f.calls().filter(a => a[0] === 'cp' && a[1].includes('evidence.tar.gz')).length, 2);
  assert.ok(existsSync(join(f.trialDir, 'jobs/job/trial/model.patch')));
  assert.ok(existsSync(join(f.trialDir, 'runner.log')));
  assert.equal(f.calls().at(-1)[0], 'rm');
  const egress = f.calls().find(a => a[0] === 'egress');
  for (const host of ['api.fireworks.ai', 'astral.sh', 'releases.astral.sh', 'github.com', 'release-assets.githubusercontent.com']) assert.ok(egress.includes(host));
  const imagePull = f.calls().findIndex(a => a[0] === 'exec' && a.at(-1).includes('docker pull'));
  assert.ok(imagePull >= 0 && imagePull < f.calls().findIndex(a => a[0] === 'egress'));
  assert.ok(f.calls()[imagePull].at(-1).includes(':v1.1'), 'use the pinned corpus image');
});

test('incomplete evidence retains the runtime and resumes the original passing attempt', t => {
  const f = fixture(t, { copyFailure: 'always' });
  ok(f.run());
  assert.equal(f.trial().status, 'infra_invalid');
  assert.equal(f.trial().recovery, true);
  assert.equal(f.calls().filter(a => a[0] === 'rm').length, 0);
  assert.equal(f.executions().length, 1);
  f.setConfig({});
  ok(f.run());
  assert.equal(f.trial().status, 'success');
  assert.equal(f.executions().length, 1);
  assert.equal(f.calls().filter(a => a[0] === 'checkpoint' && a[1] === 'restore').length, 1);
  ok(f.run());
  assert.equal(f.executions().length, 1, 'first valid attempt remains canonical');
});

test('an unconfirmed completion is infra-invalid and recoverable, not a harness failure', t => {
  const f = fixture(t, { pollFailures: 20 });
  ok(f.run());
  assert.equal(f.trial().status, 'infra_invalid');
  assert.equal(f.calls().filter(a => a[0] === 'rm').length, 0);
  f.setConfig({});
  ok(f.run());
  assert.equal(f.trial().status, 'success');
  assert.equal(f.executions().length, 1);
});

test('environment failure before agent setup is excluded and may be retried', t => {
  const exception = { exception_type: 'RuntimeError', exception_message: 'Proxy image could not be built' };
  const f = fixture(t, { result: { exception_info: exception,
    environment_setup: { started_at: '2026-09-05T00:00:00Z' }, agent_setup: null, agent_execution: null } });
  ok(f.run());
  assert.equal(f.trial().status, 'infra_invalid');
  assert.deepEqual(f.trial().harness_exception, exception);
  f.setConfig({});
  ok(f.run());
  assert.equal(f.trial().status, 'success');
  assert.equal(f.executions().length, 2);
});

for (const [name, config, status] of [
  ['verifier failure', { result: { resolved: false, reward: 1 } }, 'failure'],
  ['harness crash', { runnerCrash: true }, 'failure'],
  ['agent execution exception', { result: { exception_info: { exception_type: 'RuntimeError' },
    environment_setup: {}, agent_setup: {}, agent_execution: { started_at: '2026-09-05T00:00:00Z' } } }, 'failure'],
  ['remote timeout', { runnerTimeout: true }, 'timeout'],
]) test(`${name} stays scoreable and is never rerun by transport recovery`, t => {
  const f = fixture(t, config);
  ok(f.run());
  assert.equal(f.trial().status, status);
  assert.equal(f.trial().success, false);
  const calls = f.calls().length;
  ok(f.run());
  assert.equal(f.calls().length, calls + 1, 'only authentication probe is needed for a valid trial');
});

for (const [name, config] of [['egress', { egressFailure: true }], ['credential', { authFailure: true }]]) {
  test(`${name} setup failure never launches the harness`, t => {
    const f = fixture(t, config);
    ok(f.run());
    assert.equal(f.trial().status, 'infra_invalid');
    assert.equal(f.executions().length, 0);
  });
}

test('Terminal-Bench uses the same verified execution and recovery path', t => {
  const f = fixture(t);
  writeFileSync(f.tasks, 'terminal-bench/regex-log\n');
  ok(f.run());
  const record = JSON.parse(readFileSync(join(f.root, 'runs/control/trials/terminal-bench-regex-log/trial.json')));
  assert.equal(record.status, 'success');
  assert.equal(f.executions()[0][0], 'harbor');
});

test('a standalone skill runs a subset using workspace task images and builds a report', t => {
  const f = fixture(t);
  // Skills CLI copies only the skill folder; the data lives in a separate workspace.
  // A path with spaces also exercises the documented absolute script paths.
  const installed = join(f.root, 'installed skill/scripts');
  cpSync(scripts, installed, { recursive: true });
  for (const entry of ['benchmark.json', 'results', 'tasks/regex-log']) {
    cpSync(join(repo, entry), join(f.root, entry), { recursive: true });
  }
  writeFileSync(f.tasks, 'terminal-bench/regex-log\n');
  ok(spawnSync('bash', [join(installed, 'run-trials.sh'), '--checkpoint', 'golden',
    '--harness', 'pi-responses', '--run-id', 'installed', '--tasks', f.tasks,
    '--timeout', '5'], { cwd: f.root, env: f.env, encoding: 'utf8', timeout: 20000 }));

  const calls = f.calls();
  const imagePull = calls.findIndex(a => a[0] === 'exec' && a.at(-1).includes('docker pull'));
  assert.ok(imagePull >= 0, 'subset image must be pulled even without task data beside the skill');
  assert.ok(calls[imagePull].at(-1).includes('alexgshaw/regex-log:20251031'));
  assert.ok(imagePull < calls.findIndex(a => a[0] === 'egress'));
  assert.equal(f.executions().length, 1);

  for (const script of ['normalize-results.mjs', 'generate-chart.mjs', 'build-report.mjs']) {
    ok(spawnSync(process.execPath, [join(installed, script), '--run', 'runs/installed'],
      { cwd: f.root, env: f.env, encoding: 'utf8', timeout: 10000 }));
  }
  const candidate = JSON.parse(readFileSync(join(f.root, 'runs/installed/candidate.json')));
  assert.equal(candidate.successful, 1);
  assert.equal(candidate.expected, 30);
  assert.equal(candidate.comparable, false);
  for (const file of ['chart.svg', 'REPORT.md', 'index.html']) {
    const report = readFileSync(join(f.root, 'runs/installed/report', file), 'utf8');
    assert.ok(report.length > 0);
    assert.match(report, /not ranked/);
    assert.doesNotMatch(report, /ranking (?:\*\*)?\d+ of/);
  }
});

test('resuming under a different model, harness, or command is refused', t => {
  const f = fixture(t);
  ok(f.run());
  assert.equal(f.run(['--harness', 'changed']).status, 2);
  assert.equal(f.run(['--cmd', 'different command']).status, 2);
  assert.equal(f.executions().length, 1);
});

test('provisioning waits for ready before cleanup and skips formal pre-pulls by default', t => {
  const f = fixture(t, { provision: true, checkpointStates: ['creating', 'ready'] });
  ok(f.execute('provision-golden-checkpoint.sh', ['--runtime', 'build', '--checkpoint', 'golden',
    '--harness', 'pi', '--repo', 'https://example.com/pi', '--commit', '1234567']));
  assert.equal(f.calls().filter(a => a[0] === 'checkpoint' && a.includes('--json')).length, 2);
  assert.equal(f.calls().at(-1)[0], 'rm');
  assert.equal(f.calls().filter(a => a[0] === 'exec' && a.at(-1).includes('docker pull')).length, 0);
  const install = f.calls().find(a => a[0] === 'exec' && a.at(-1).includes('git checkout') && a.at(-1).includes('deep-swe'));
  assert.ok(install.at(-1).includes('435ee89ec2f2e2289f33b0da4f992f0b7b7266b9'));
  assert.ok(install.at(-1).includes('--jobs-dir'));
});

test('custom provider provisioning injects credentials and restricts the selected host', t => {
  const f = fixture(t, { provision: true });
  ok(f.execute('provision-golden-checkpoint.sh', ['--runtime', 'build', '--checkpoint', 'golden',
    '--harness', 'grok-build', '--repo', 'https://example.com/grok', '--commit', '1234567',
    '--provider', 'custom', '--model', 'openai/kimi-k3', '--secret-name', 'FIREWORKS_API_KEY',
    '--secret-host', 'gateway.example.com']));
  const rule = f.calls().find(a => a[0] === 'secret' && a[1] === 'rule');
  assert.ok(rule.includes('gateway.example.com'));
  assert.ok(rule.includes('Bearer ${secret}'));
  assert.ok(f.calls().find(a => a[0] === 'egress').includes('gateway.example.com'));
});

for (const state of ['creating', 'error']) test(`checkpoint stuck in ${state} retains build runtime`, t => {
  const f = fixture(t, { provision: true, checkpointStates: [state] });
  const result = f.execute('provision-golden-checkpoint.sh', ['--runtime', 'build', '--checkpoint', 'golden',
    '--harness', 'pi', '--repo', 'https://example.com/pi', '--commit', '1234567', '--checkpoint-timeout', '1']);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(f.calls().filter(a => a[0] === 'rm').length, 0);
  assert.ok(!result.stderr.includes('Golden checkpoint ready:'));
});

test('runc workaround replaces only the known wrapper symlink', t => {
  const f = fixture(t);
  const root = join(f.root, 'runc-test');
  for (const dir of ['usr/local/sbin', 'usr/bin', 'opt/runta', 'work']) mkdirSync(join(root, dir), { recursive: true });
  const real = join(root, 'usr/bin/runc');
  writeFileSync(real, '#!/bin/sh\necho runc-test\n', { mode: 0o755 });
  const wrapper = join(root, 'usr/local/sbin/runc');
  symlinkSync(join(root, 'opt/runta/runta-runc'), wrapper);
  const script = readFileSync(join(scripts, 'restore-system-runc.sh'), 'utf8').replaceAll('/usr/', `${root}/usr/`).replaceAll('/opt/', `${root}/opt/`).replaceAll('/work', `${root}/work`);
  const execute = () => spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...f.env, PATH: `${join(root, 'usr/local/sbin')}:${f.env.PATH}` } });
  ok(execute());
  assert.equal(readlinkSync(wrapper), real);
  ok(execute());
  rmSync(wrapper);
  symlinkSync(real, wrapper);
  ok(execute());
  assert.equal(readlinkSync(wrapper), real);
});

test('all shipped shell scripts parse', () => {
  for (const file of readdirSync(scripts).filter(f => f.endsWith('.sh'))) {
    ok(spawnSync('bash', ['-n', resolve(scripts, file)], { encoding: 'utf8' }));
  }
});
