# Prompt for evaluating your own harness

The `frontierharness-eval` skill is written for an agent, not for a reader. This page is
the other half: a prompt you paste into any coding agent that can read files and run
shell commands, so it drives the run for you instead of you translating `SKILL.md` into
commands by hand.

Install the evaluation skill and the official [Runta skills](https://runta.com/docs/skills/)
in the project where you use your coding agent. Skip the first command if the Runta
skills are already installed, and select the same agent for both:

```bash
npx skills add https://runta.com/docs --skill runta-installer runta-cli
npx skills add frontier-harness-eval/eval --skill frontierharness-eval
```

Start a new agent session and paste the prompt below. The skill's **Workspace setup**
step reuses or clones the benchmark data and keeps the installed scripts' absolute path
when changing directories. You can also use the skill directly from a repository clone.

The optional `npx @frontierharness/eval prompt --harness … --repo … --commit … --provider …`
helper prints the prompt below with those blanks already filled in.

## Fill in five things

Everything else the skill decides for you. These are the only facts it cannot guess:

| Placeholder | What it is | Example |
| --- | --- | --- |
| `<HARNESS_NAME>` | Identifier used in the report and passed to the runner | `my-harness` |
| `<REPO_URL>` | GitHub repo of the harness under evaluation | `https://github.com/acme/my-harness` |
| `<COMMIT_SHA>` | Commit to pin it to — a branch name is not reproducible | `9f2c1ab` |
| `<PROVIDER>` | Who serves Kimi K3: `fireworks`, `moonshot`, `openrouter`, `together`, `custom` | `fireworks` |
| `<BUILD_STEPS>` | How your harness is built and invoked from a clean Linux box | `npm ci && npm run build`, entrypoint `bin/my-harness` |

Authenticate Runta with `runta login` or `RUNTA_TOKEN`, and configure the provider key
for whichever `<PROVIDER>` you chose (`FIREWORKS_API_KEY` for the default), either in
the environment or as a stored Runta secret. The agent verifies these before provisioning.

## The prompt

```text
Use the frontierharness-eval skill. Read its SKILL.md and adjacent reference.md,
from the installed skill or skills/frontierharness-eval/ in a repository clone.
Follow Workspace setup first: prepare the benchmark checkout and set FH to the
absolute path of the loaded skill's scripts directory. Run the workflow from the
benchmark workspace, keeping FH pointed at that skill.
Use runta-installer for Runta tooling setup and runta-cli for runtime command guidance
when needed. Follow frontierharness-eval's runtime, checkpoint, and scoring requirements.

The harness under evaluation:
- name: <HARNESS_NAME>
- repo: <REPO_URL>
- commit: <COMMIT_SHA>
- provider for Kimi K3: <PROVIDER>
- how it builds and how it is invoked: <BUILD_STEPS>

Do this in order, and stop to show me your findings at each numbered boundary:

1. Use runta-installer to set up the local Runta CLI if needed, then verify Runta
   authentication, the provider secret or environment key, jq, and node >= 18.
   Report any remaining prerequisites before provisioning.

2. Write an install script for my harness that works on a clean Linux runtime, from the
   build steps above. If my harness is not a built-in agent for Harbor or Pier, register
   it as a custom agent in both runner registries inside that script, and use the
   registered name as --harness. Show me the script and wait for my approval before
   running it.

3. Provision a small golden checkpoint with bash "$FH/provision-golden-checkpoint.sh", leaving
   formal image pulls to each trial restore. Confirm the checkpoint is ready and that the
   provider key is a stub inside the runtime, not a real key.

4. Smoke-test before spending money on a full sweep: restore the checkpoint once, run a
   single task by hand, and show me the resulting trial.json plus the reward field the
   scoring script extracted from the job output. Confirm the extraction is actually
   reading my harness's success signal and not defaulting to false. Stop here and wait
   for my go-ahead.

5. Run the published 30-task set with bash "$FH/run-trials.sh", one fresh restore per task, and
   report progress as tasks complete. Resume retained runtimes after transport errors
   using the same run command; never rerun a completed valid attempt. Retry setup
   failures that happened before harness launch; if
   it fails on infrastructure twice, mark it infra_invalid rather than scoring it as a
   task failure. A harness crash is a failure, not infrastructure. The report ranks
   against the leaderboard only when all 30 tasks are scoreable.

6. Normalize, chart, and build the report with the three node scripts, then show me
   runs/<run-id>/report/REPORT.md and tell me which reproducibility rules from SKILL.md
   the run relaxed, if any.

Rules I care about: do not change the model — every published configuration runs Kimi
K3, and overriding it makes the result non-comparable. Do not execute any formal task
before the checkpoint is frozen. Keep every trajectory and verifier log under
runs/<run-id>/trials/. If a step fails, show me the actual error instead of retrying
with different flags.
```

## Try it on two tasks first

A full sweep is 30 tasks, each with its own restore and its own model spend. If you have
never run the skill before, replace step 5 with this and get a complete report end to
end for a fraction of the cost:

(`npx @frontierharness/eval prompt --smoke` prints the prompt with this substitution
already applied.)

```text
5. Run only these two tasks, one fresh restore each:
     terminal-bench/regex-log
     datacurve/anko-typed-variable-bindings
   One per suite, so both the Harbor and the Pier path get exercised.
```

The numbers from a two-task run are not comparable to the leaderboard — the point is to
prove the plumbing works before committing to the full set. Re-running the same
`--run-id` later with the full task list only runs the tasks you list and keeps the rest,
so nothing is wasted.

## Follow-ups worth keeping

Paste these into the same session after the first report exists.

```text
Task <TASK_ID> failed. Read its trajectory and verifier log under
runs/<RUN_ID>/trials/, and tell me whether it failed on the task, on my harness's
configuration, or on infrastructure. Quote the evidence.
```

```text
Every task failed at turn zero. Follow the troubleshooting path in reference.md: restore
the checkpoint once, run the harness by hand in the debug runtime, and find where the
configuration is wrong before we re-run anything.
```

```text
Evaluate a second configuration of the same harness at commit <COMMIT_SHA> with
<WHAT_CHANGED>. Reuse the workflow but a separate checkpoint and run-id, then build one
report that shows both configurations against the baselines.
```

```text
Publish the report as a public gist and give me the link.
```

## What the agent still needs you for

Three decisions stay with you, and a well-behaved agent will stop and ask rather than
pick for you: whether the install script is really how your harness should be built,
whether the reward extraction in the smoke test is reading your harness's success signal
correctly, and whether to spend the model budget on the full 30 tasks. The rest of the
run — runtime hygiene, one restore per task, evidence collection, scoring, and the
caveats in the report — is the skill's job.
