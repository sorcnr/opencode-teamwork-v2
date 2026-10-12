// opencode-teamwork — V2 port
//
// Original package: opencode-teamwork@0.2.1 (V1 plugin API)
// Ported to the OpenCode V2 plugin API (see https://opencode.ai/v2/docs/build/plugins).
//
// What changed vs the V1 plugin:
//   * Default export is now an object definition `{ id, setup }` instead of the
//     V1 async plugin function returning a `config` hook.
//   * Agent registration moved OUT of the plugin. The V2 AgentEditor has no
//     `add`, so plugins cannot create agents. The 10 `team/*` agents are
//     installed as markdown files under ~/.config/opencode/agents/team/.
//   * Commands are still registered by the plugin, via ctx.command.transform,
//     which is the V2 replacement for the V1 `config` hook's command injection.
//   * Command templates no longer use `{{ ... }}` handlebars (unsupported in V2)
//     and rely on `$ARGUMENTS` substitution.
//
// Deliberately dependency-free at runtime: no import of @opencode/plugin so the
// loader never has to resolve node_modules for this file. The object shape below
// is exactly what Plugin.define({ id, setup }) produces.

import { registerTeamworkTools, registerTeamworkHooks } from "./tools.ts"

type CommandSpec = {
  name: string
  description: string
  agent: string
  template: string
}

const COMMANDS: CommandSpec[] = [
  {
    name: "teamwork",
    description:
      "Sentinel — main dispatcher. Loads a spec (or asks 1-2 questions), provisions a worktree, builds the DAG, dispatches workers + verifiers, iterates, merges. This is the user-facing /teamwork command.",
    agent: "team/sentinel",
    template: `$ARGUMENTS

Look in \`.opencode/teamwork/\` for a recent \`prompt_draft.md\`. If you find one, ask the user to confirm the session ID. If not, ask 1-2 short questions to pick the topology, then either run the crafter (via /teamwork-craft) or inline the answers and proceed.

Then:

0. Budget preflight: call \`teamwork_budget\`. If it reports console-credit budgeting applies (opencode/ models + opencode_console connected), call \`opencode_console_get_usage\`, compute \`remaining = min(limitDollars - spentDollars)\`, and ASK THE USER whether to use the FULL remaining budget or PARTIAL (half). Pass the choice to \`teamwork_plan\` as \`budgetUsd\` with \`budgetSource: "credits"\`.
1. Load the spec, then call the \`teamwork_plan\` tool to create the run — it returns the canonical \`SESSION_ID\`. Never use a session id read from a file. Provision the sentinel worktree OUTSIDE the repo, quoting both args: \`git worktree add "\${TEAMWORK_WORKTREES_DIR:-../.teamwork-worktrees}/$SESSION_ID/sentinel" -b "teamwork/base-$SESSION_ID"\` (skip if not in a git repo).
2. Build the DAG in \`.opencode/teamwork/<session-id>/plan.dag.json\`. Independent tasks run in parallel; dependent ones in topological order.
3. Dispatch workers in topological order. Each gets:
   - Its own worktree
   - A scoped \`spec.json\`
   - Returns: \`patch.diff\` + \`summary.md\` + cost metrics
4. Dispatch verifiers against each worker's diff. Aggregated results go in \`.opencode/teamwork/<session-id>/verify/summary.json\`.
5. If FAIL, send the verifier's \`feedback_for_worker.md\` back to the worker for the next round. Loop until PASS, maxRounds, or budget exhausted.
6. On full PASS, merge the sentinel worktree back. On partial, present the partial + the open verification reports.
7. After the run completes (full or partial), spawn a \`team/verifier\` agent to independently verify the final merged result against the spec's acceptance criteria; write its report to \`.opencode/teamwork/$SESSION_ID/verify/final.json\`.

Hard caps (override in the spec if the user asks):
- 4 rounds per task (6 for proof, 1 for small-focused, 24h for massive-proof)
- Budget: derived from opencode_console credits when available (full or partial, per the user), else the default $20 session budget

When done, write \`.opencode/teamwork/<session-id>/final.md\` and present. Tell the user:
- Which topology you chose
- How many rounds each task took
- Total cost (estimated)
- Path to the final artifact
- Any unresolved verification reports`,
  },
  {
    name: "teamwork-craft",
    description:
      "Phase-1 prompt crafter. Runs the 9-step elicitation flow before a Teamwork run, produces prompt_draft.md. Use for any hard problem where you want a falsifiable spec before dispatching agents.",
    agent: "team/crafter",
    template: `$ARGUMENTS

The user wants to run a Teamwork session. Before dispatching agents, you need a spec.

Run the 9-step elicitation flow:

1. Elicit project idea (1-2 declarative sentences)
2. Identify ambiguity + scale (small-focused / iterative-coding / distributed-coding / proof / massive-proof / document-review)
3. Determine integrity mode (development / demo / benchmark)
4. Draft requirements $R_1 \\dots R_N$ (2-5 behavior-focused)
5. Design verification (forcing function — what makes the verifier say PASS)
6. Set acceptance criteria (markdown checkboxes for each $R_i$)
7. Configure model allocation (preset: anthropic/team/google/openai/free — or \`custom\` for per-role)
8. Set working directory
9. Assemble + validate (run the anti-pattern checks)

Save the spec to \`.opencode/teamwork/<session-id>/prompt_draft.md\`.

When the spec is approved by the user, they can run \`/teamwork <session-id>\` to dispatch the Sentinel.

If the user just wants speed, tell them: "Run \`/teamwork\` with your prompt. The Sentinel will ask the same 9 questions in compressed form. The wizard is the right tool for multi-hour / multi-day problems."`,
  },
  {
    name: "team-orchestrate",
    description:
      "Legacy v1 orchestrator loop. Use /teamwork (sentinel) for new runs. This is the original propose/falsify/synthesize/verify loop without DAG, worktrees, or cost tracking.",
    agent: "team/orchestrator",
    template: `$ARGUMENTS

You are the legacy v1 orchestrator. The user has explicitly requested the v1 loop (or is running a project that hasn't migrated to v2).

Follow the v1 run loop:

1. Scout first.
2. Propose 3-5 candidates in parallel.
3. Falsify each one. Mandatory.
4. Synthesize (unless iterative-coding).
5. Verify.
6. If FAIL, log a pitfall and re-propose.
7. Present the final artifact at \`.opencode/teamwork/<session-id>/final.md\`.

If you want the v2 features (DAG engine, git worktrees per agent, typed artifact bus, cost tracking, prompt-crafter wizard), use \`/teamwork\` instead.`,
  },
  {
    name: "team-propose",
    description:
      "Run only the propose step. Generates N candidate solutions in parallel and writes them under .opencode/teamwork/. Use when you want to inspect raw candidates before the falsifier step.",
    agent: "team/orchestrator",
    template: `$ARGUMENTS

The user wants raw candidates, not a full Teamwork run. Do this:

1. Pick a pattern from the prompt (default: distributed-coding).
2. Run scout first to gather context.
3. Dispatch \`@team/proposer\` N=3 times in parallel, each with a different strategy framing. If no strategy framing is obvious, use these defaults:
   - Candidate 1: "the textbook approach"
   - Candidate 2: "an unconventional / contrarian angle"
   - Candidate 3: "the minimal change that could work"
4. Write the candidates to \`.opencode/teamwork/<session-id>/candidates/cand-1.md\` through \`cand-3.md\`.
5. STOP after writing the candidates. Do not run falsifier, synthesizer, or verifier. The user will inspect and decide next.

Report back: where the candidates are, a 1-line summary of each, and any patterns you noticed across them (e.g. "all 3 candidates picked the same library — this might be the wrong choice").`,
  },
  {
    name: "team-falsify",
    description:
      "Run only the falsifier step on existing candidates. Use after /team-propose to get adversarial critique before deciding to synthesize.",
    agent: "team/orchestrator",
    template: `$ARGUMENTS

The user wants falsifier critiques of existing candidates. Do this:

1. List the candidates in \`.opencode/teamwork/<session-id>/candidates/\`.
2. For each candidate, dispatch \`@team/falsifier\`. Falsifiers run in parallel.
3. Write the critiques to \`.opencode/teamwork/<session-id>/critiques/crit-<n>.md\`.
4. After all critiques are in, write a meta-summary at \`.opencode/teamwork/<session-id>/critiques/summary.md\`:
   - How many candidates were killed (FATAL).
   - How many have SERIOUS findings.
   - How many pass with MINOR findings only.
   - Which failure modes appear across multiple candidates (these are likely real and the proposers should be told).
5. STOP. Do not synthesize. The user will decide.

Report back: the summary and a recommendation ("synthesis likely unnecessary, all 3 are broken in the same way" or "candidates diverge enough that synthesis will be hard" or "one clear winner, ready to verify").`,
  },
  {
    name: "team-synthesize",
    description:
      "Run the synthesizer on existing candidates + critiques. Use after /team-falsify when candidates have been critiqued and a merge is needed.",
    agent: "team/orchestrator",
    template: `$ARGUMENTS

The user wants a synthesis of existing candidates and their critiques. Do this:

1. Read all candidates in \`.opencode/teamwork/<session-id>/candidates/\`.
2. Read all critiques in \`.opencode/teamwork/<session-id>/critiques/\`.
3. Read the pitfall registry \`.opencode/teamwork/<session-id>/pitfalls.md\` if it exists.
4. Dispatch \`@team/synthesizer\` with all of the above.
5. Write the synthesis to \`.opencode/teamwork/<session-id>/synthesis/syn-1.md\`.
6. STOP. Do not verify. The user will run /teamwork or call the verifier directly.

Report back: where the synthesis is, what was kept from each source candidate, and any new failure modes the synthesizer flagged. If the synthesis was inconclusive, say so explicitly and explain why.`,
  },
  {
    name: "team-review",
    description:
      "Run the verifier on the current synthesis or candidate. Use after /team-synthesize (or directly on a candidate) to get a binary PASS/FAIL with evidence.",
    agent: "team/orchestrator",
    template: `$ARGUMENTS

The user wants verification of a specific artifact. Do this:

1. Find the artifact: the latest file in \`.opencode/teamwork/<session-id>/synthesis/\`, or fall back to the latest in \`candidates/\` if no synthesis exists.
2. Dispatch \`@team/verifier\` with the artifact and the relevant critiques.
3. Write the verification report to \`.opencode/teamwork/<session-id>/verify/v-<n>.md\`.
4. STOP. The user will read the report and decide.

Report back: PASS or FAIL, a 1-line summary of the checks, and (if FAIL) the specific commands to reproduce. Do not propose a fix.`,
  },
]

// Best-effort self-heal: when this file is loaded from the published npm
// package (rather than a hand-vendored copy) make sure the `team/*` agent
// markdown files exist in the OpenCode config directory. Only files that are
// completely missing are created; existing agents are never rewritten, so a
// user's model choices from `opencode-teamwork init` are preserved. When the
// plugin is vendored without the new package layout the import fails and this
// quietly does nothing.
async function ensureAgentsInstalled() {
  try {
    const lib = await import("../../lib/team.mjs")
    const { fileURLToPath } = await import("node:url")
    lib.ensureAgents({ packageRoot: fileURLToPath(new URL("../../", import.meta.url)) })
  } catch {
    // Vendored copy without lib/, or filesystem not writable. Not fatal.
  }
}

export default {
  id: "opencode-teamwork",
  async setup(ctx: any) {
    await ensureAgentsInstalled()
    const root = (ctx?.location?.directory as string) || process.cwd()
    await registerTeamworkTools(ctx, root)
    await registerTeamworkHooks(ctx, root)
    await ctx.command.transform((editor: any) => {
      for (const cmd of COMMANDS) {
        editor.add({
          name: cmd.name,
          description: cmd.description,
          execute: async ({ sessionID, prompt, delivery }: any) => {
            // V1 commands selected an agent via frontmatter; V2 plugin commands
            // must switch the session agent explicitly.
            await ctx.session.switchAgent({ sessionID, agent: cmd.agent })
            const args = typeof prompt?.text === "string" ? prompt.text : ""
            const text = cmd.template.split("$ARGUMENTS").join(args)
            await ctx.session.prompt({ ...prompt, sessionID, text, delivery })
          },
        })
      }
    })
  },
}
