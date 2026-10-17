# Teamwork artifacts

Single source of truth for the files every Teamwork run reads and writes, and
for the topologies the coordinator may pick. Agents reference this file instead
of redefining formats.

## Layout

Every run writes under one root:

```
.opencode/teamwork/<session-id>/
├── prompt_draft.md          # spec (from the crafter, or inlined by the sentinel)
├── plan.dag.json            # task DAG
├── state.json               # resumable coordinator state
├── costs.json               # coordinator-maintained budget tracker
├── pitfalls.md              # answer-agnostic failure registry
├── scout-report.md          # scout output
├── candidates/cand-<n>.md   # one per proposer
├── critiques/crit-<n>.md    # one per falsifier
├── synthesis/syn-<n>.md     # one per synthesizer run
├── synthesis/conflict-<task>.json # git 3-way merge conflict artifact
├── verify/report-<task>.json
├── verify/summary.json
├── verify/security-audit.json # pre-merge security gate report
├── final.md                 # presented result
└── interrupted.md           # present when the user stops a run
```

`<session-id>` = `YYYYMMDD-HHMMSS-<4 hex>`.

Worktrees are created **outside the repository** (nested git worktrees inside
the repo are a footgun). Default root: `$TEAMWORK_WORKTREES_DIR` or
`../.teamwork-worktrees/<session-id>/`.

## Topologies

| Topology | Shape |
| --- | --- |
| `small-focused` | 1 worker + 1 verifier loop |
| `iterative-coding` | 1 worker, test-driven tight loop on one module |
| `distributed-coding` | N workers fan-out + merge |
| `proof` | 1 strategist + 3-5 searchers + 1 formal checker |
| `massive-proof` | 1 meta-coordinator + 100+ searchers (opt-in) |
| `document-review` | 1 chair + 3 critics + 1 aggregator |

Legacy aliases — accept them, normalize on write:
`large-swarm` → `distributed-coding`, `doc-review` → `document-review`,
`long-proof` → `proof`, `massive-proof-swarm` → `massive-proof`.

## Schemas

### `spec.json` — one per dispatched worker (written by the sentinel)

```json
{
  "taskId": "R1-impl",
  "sessionId": "20260112-101500-a1b2",
  "title": "Implement R1",
  "topology": "distributed-coding",
  "objective": "one sentence",
  "requirements": ["R1", "R2"],
  "acceptanceCriteria": ["- [ ] ...", "- [ ] ..."],
  "localChecks": ["npm test -- foo"],
  "verification": ["how the verifier proves PASS"],
  "dependencies": [{ "taskId": "R0", "artifacts": ["synthesis/syn-1.md"] }],
  "avoidPitfalls": ["assumes input is sorted"],
  "worktree": "/abs/path/to/worktree",
  "baseBranch": "teamwork/base-<session-id>",
  "constraints": { "network": "allowed", "sandbox": "worktree-only" }
}
```

`constraints.network`: `allowed | denied | whitelist`.
`constraints.sandbox`: `full | read-only | worktree-only`.

### `plan.dag.json`

```json
{
  "sessionId": "20260112-101500-a1b2",
  "topology": "distributed-coding",
  "tasks": [
    {
      "id": "R1-impl",
      "dependsOn": [],
      "requirements": ["R1"],
      "agent": "team/worker",
      "status": "pending",
      "round": 0,
      "maxRounds": 4
    }
  ]
}
```

### `state.json` — coordinator checkpoint (rewritten on every transition)

```json
{
  "version": 1,
  "sessionId": "20260112-101500-a1b2",
  "phase": "LOAD_SPEC|WORKTREE_INIT|DAG_BUILD|DISPATCH|SECURITY_AUDIT|MERGE|PRESENT_PARTIAL|DONE",
  "tasks": {
    "R1-impl": {
      "status": "pending|worker_active|worker_done|verifier_active|verified_pass|verified_fail|blocked",
      "round": 1,
      "branch": "teamwork/20260112-101500-a1b2-R1-impl",
      "worktree": "../.teamwork-worktrees/20260112-101500-a1b2/R1-impl",
      "summary": "Implemented core validation logic",
      "feedback": "Verifier found edge case in empty inputs",
      "verification": {
        "status": "PASS|FAIL",
        "passedChecks": 4,
        "totalChecks": 4,
        "fatalFindings": []
      },
      "lastReport": "verify/report-R1-impl.json",
      "updatedAt": "2026-01-12T10:15:00Z"
    }
  },
  "updatedAt": "2026-01-12T10:15:00Z"
}
```

Task lifecycle:
- `pending`: Unstarted, waiting for dependencies to reach `verified_pass`.
- `worker_active`: Worker subagent is dispatched and coding in its isolated worktree.
- `worker_done`: Worker has committed changes to its branch; ready for verification.
- `verifier_active`: Verifier subagent is running tests/rubrics against the branch diff.
- `verified_pass`: Verification passed; ready for `teamwork_worktree` merge to sentinel base.
- `verified_fail`: Verification failed; if `round < maxRounds`, ready to re-dispatch worker with feedback; if `round >= maxRounds`, automatically transitions to `blocked`.
- `blocked`: Max rounds exceeded or upstream dependency blocked.

Resume: re-read `state.json`, skip tasks already `verified_pass`, continue the current
`round` for `verified_fail`/`worker_active`/`worker_done`.

### Engine Tools

The plugin provides deterministic orchestration tools for the Sentinel coordinator:
- `teamwork_next`: Evaluates the DAG dependencies against current task lifecycle statuses. Categorizes tasks into `readyForWorker`, `readyForVerifier`, `inProgress`, or terminal conditions (`ALL_TASKS_PASSED` / `DEADLOCK`).
- `teamwork_task_update`: Enforces deterministic state transitions, tracks worker branch names and diff summaries, updates verifier metrics, and advances run `phase` to `MERGE` or `PRESENT_PARTIAL`.
- `teamwork_worktree`: Isolates git worktrees outside the project repo (`setup` for sentinel and worker), inspects branch diffs (`diff`), performs clean merges into `teamwork/base-$SESSION_ID` with automatic conflict abort (`merge`), and prunes worktrees (`cleanup`).

### `costs.json`

```json
{ "sessionId": "...", "budgetUsd": 20, "budgetSource": "credits|default|manual", "spentUsd": 0, "byTask": {}, "updatedAt": "ISO8601" }
```

When the session uses `opencode/` (managed) models and the `opencode_console`
MCP is connected, `teamwork_budget` tells the sentinel to derive `budgetUsd`
from console credits (`opencode_console_get_usage` →
`min(limitDollars - spentDollars)`), after asking the user whether to use the
full remaining budget or a partial (half) amount. `budgetSource` records where
the budget came from.

Cost and token consumption are read directly from OpenCode, not self-reported.
The engine discovers the full OpenCode session tree rooted at the run's sentinel
session (`opencode.db` SQLite tree query, background service API, or client get),
aggregating the root session and all child/subagent sessions (workers, verifiers,
scouts, auditors). Deltas between calls are tracked in `snapshots.json`. When
native discovery is unavailable (tests, non-OpenCode host) the tool falls back
to manual `addUsd`.

### `snapshots.json` — per-session cost baseline for delta tracking

```json
{
  "sessionId": "20260112-101500-a1b2",
  "rootSessionIds": ["ses_abc123"],
  "bySession": {
    "ses_abc123": {
      "lastCost": 0.62,
      "lastTokens": { "input": 1200, "output": 640, "reasoning": 0, "cache": { "read": 300, "write": 40 } },
      "agent": "team/sentinel",
      "timestamp": "ISO8601"
    }
  }
}
```

`lastCost` is the last cumulative cost observed for that OpenCode session.
Each `teamwork_cost` call queries the entire session tree, computes
`delta = current_cost - lastCost` for every session (sentinel + all subagents),
adds new spend to `costs.json`, and advances `lastCost`. Because the running total
is the sum of these deltas across the entire tree, cumulative cost is never
double-counted and subagent consumption is never lost or ignored.

### `verify/report-<task>.json` (verifier output)

```json
{
  "taskId": "R1-impl",
  "verifierAgent": "team/verifier",
  "verifierModel": "<model>",
  "timestamp": "ISO8601",
  "status": "PASS",
  "checks": [
    { "name": "...", "type": "programmatic|adversarial|rubric", "passed": true, "output": "..." }
  ],
  "feedbackForWorker": "...",
  "fatalFindings": [
    { "where": "file:line", "why": "...", "fix": "...", "reproduction": "..." }
  ]
}
```

### `verify/security-audit.json` (pre-merge security gate output)

```json
{
  "sessionId": "20260112-101500-a1b2",
  "status": "PASS|FAIL",
  "timestamp": "ISO8601",
  "severityCounts": { "critical": 0, "high": 0, "medium": 1, "low": 2 },
  "summary": "Audited base branch diff; no secrets or injection vectors found.",
  "findings": [
    {
      "id": "SEC-1",
      "severity": "Medium",
      "location": "src/api.ts:42",
      "description": "Unbounded payload buffer could allow memory pressure under high concurrency."
    }
  ]
}
```

If `critical` > 0 or `high` > 0, `status` is forced to `FAIL` and `teamwork_next` blocks final merge (`BLOCKED_BY_SECURITY`).

### `synthesis/conflict-<task>.json` (git 3-way merge conflict artifact)

Generated by `teamwork_worktree({ action: "merge" })` when a conflict occurs:

```json
{
  "taskId": "R2-impl",
  "sessionId": "20260112-101500-a1b2",
  "baseBranch": "teamwork/base-20260112-101500-a1b2",
  "incomingBranch": "teamwork/20260112-101500-a1b2-R2-impl",
  "conflictingFiles": ["src/router.ts"],
  "diffOurs": "...",
  "diffTheirs": "...",
  "timestamp": "ISO8601"
}
```

### `pitfalls.md`

One line per entry:

```
- [round 2] assumes the input is already sorted — seen in R1-impl
```

### `scout-report.md`, `candidates/*.md`, `critiques/*.md`, `synthesis/*.md`

Free-form markdown following the section structure described in the scout,
proposer, falsifier and synthesizer agent files.

