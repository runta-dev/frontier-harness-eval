#!/usr/bin/env node
// Local transport double. Remote shell commands and the detached worker execute
// against a temporary filesystem; no Runta account or model provider is contacted.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = process.env.FAKE_RUNTA_ROOT;
const args = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json')));
fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify(args) + '\n');
const work = path.join(root, 'remote', 'work');
const count = name => {
  const file = path.join(root, `${name}.count`);
  const value = Number(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 0) + 1;
  fs.writeFileSync(file, String(value));
  return value;
};
function prepare() {
  fs.mkdirSync(path.join(work, 'jobs'), { recursive: true });
  fs.mkdirSync(path.join(work, 'deep-swe/tasks/httpx-multipart-response-parsing'), { recursive: true });
  fs.writeFileSync(path.join(work, 'manifest.json'), JSON.stringify({ harness: 'pi-responses', deep_swe_commit: '435ee89', task_image_policy: 'per-trial' }));
  fs.writeFileSync(path.join(work, 'deep-swe/tasks/httpx-multipart-response-parsing/task.toml'), 'docker_image = "public.ecr.aws/test/httpx:v1.1"\n');
}
if (args[0] === 'checkpoint') {
  if (args[1] === 'ls') {
    const states = config.checkpointStates || ['ready'];
    const index = args.includes('--json') ? count('checkpoint-poll') - 1 : 0;
    console.log(JSON.stringify({ checkpoints: [{ display_name: 'golden', state: states[Math.min(index, states.length - 1)] }] }));
  } else if (args[1] === 'restore') {
    if (config.restoreFailure) process.exit(1);
    fs.rmSync(path.join(root, 'remote'), { recursive: true, force: true });
    prepare();
  }
} else if (args[0] === 'run') {
  prepare();
} else if (args[0] === 'egress') {
  if (config.egressFailure) process.exit(1);
} else if (args[0] === 'secret') {
  if (args[1] === 'list') console.log(JSON.stringify({ secrets: [{ display_name: 'FIREWORKS_API_KEY' }] }));
  if (args[1] === 'rule' && config.authFailure) process.exit(1);
} else if (args[0] === 'cp') {
  const [source, destination] = args.slice(1);
  const remote = value => value.slice(value.indexOf(':') + 1).replace('/work', work);
  if (source.includes(':/')) {
    const attempt = count('download');
    const contents = fs.readFileSync(remote(source));
    if (config.copyFailure === 'always' || attempt <= (config.copyFailures || 0)) {
      fs.writeFileSync(destination, contents.subarray(0, 12));
      process.exit(1);
    }
    fs.writeFileSync(destination, contents);
    if (config.copyReturnsError) process.exit(1);
  } else {
    const target = remote(destination);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
} else if (args[0] === 'exec') {
  let command = args.at(-1);
  if (config.provision) {
    // Provisioning is tested at its CLI boundary; never install packages locally.
    if (!command.includes('sha256sum /work/manifest.json')) process.exit(0);
  }
  if (command.includes('then cat') && command.includes('completion.json')) {
    if (count('poll') <= (config.pollFailures || 0)) process.exit(255);
  }
  command = command.replace(/\/work(?=\/|\b)/g, work);
  const result = spawnSync('bash', ['-c', command], {
    env: { ...process.env, HOME: path.join(root, 'home'), FH_WORK_DIR: work },
    encoding: 'utf8',
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (command.includes('nohup setsid') && count('launch') <= (config.launchDisconnects || 0)) process.exit(255);
  process.exit(result.status ?? 1);
} else if (args[0] !== 'rm') {
  throw new Error(`Unexpected Runta call: ${JSON.stringify(args)}`);
}
