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
├── events.jsonl             # append-only lifecycle event log (JSON Lines)
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
{
  "sessionId": "...",
  "budgetUsd": 20,
  "budgetSource": "credits|default|manual",
  "spentUsd": 0,
  "byTask": {},
  "byTaskTokens": {},
  "updatedAt": "ISO8601"
}
```

`byTask` maps a bucket name to its cumulative spend in USD. `byTaskTokens` is an
additive key (added after the original schema) with the **same bucket keys** as
`byTask`, accumulated in the same locked section so the two stay in lockstep:

```json
{
  "byTask":       { "R1-impl": 0.1234 },
  "byTaskTokens": { "R1-impl": { "input": 1200, "output": 640, "reasoning": 0, "cache": { "read": 300, "write": 40 } } }
}
```

Each `byTaskTokens` bucket holds integer token deltas (current session totals
minus the `lastTokens` recorded in `snapshots.json`), the same way cost deltas
are computed. A `costs.json` without `byTaskTokens` is valid: readers treat it as
absent. The manual `addUsd` path has no token data, so it adds dollars to `byTask`
only and leaves `byTaskTokens` untouched. The session-global `tokens` total is
unchanged.

**Bucketing rule.** Each session in the run's tree is assigned a bucket when
`teamwork_cost` finds spend for it:

1. The calling session, when `taskId` is supplied → `taskId`.
2. A root session (the run's sentinel) → `taskId` if supplied, else `_sentinel`.
3. Any other (non-root, e.g. worker or verifier) session → `taskId` if supplied,
   else its agent name (the legacy behaviour), else `_unattributed`.

So when the sentinel calls `teamwork_cost({ taskId })` at a task boundary, the
spend of the worker and verifier sessions lands on **that task**. Without a
`taskId`, subagent spend is still bucketed by agent name, exactly as before.

**Per-task attribution requires the sentinel to call it.** Per-task cost and
tokens only populate for runs whose sentinel called `teamwork_cost({ taskId })`
after each worker return and each verifier report. Spend recorded by calls made
without a `taskId` stays in agent-name or `_sentinel` buckets.

**Timeline `tokens`.** The timeline view (`lib/timeline.mjs`) reports each task's
`tokens` as `costs.byTaskTokens[<taskId>]`, when that bucket exists and holds
finite numbers. It is `null` otherwise, and **always `null` for any run recorded
before `byTaskTokens` existed**. Per-task token counts are not reconstructed for
older runs.

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

### `events.jsonl` — lifecycle event log (JSON Lines)

Append-only log of run lifecycle events. Each event is one JSON object on its own
line, terminated by `\n`. Lines are only ever appended; nothing rewrites earlier
lines.

Every line has these 11 fields, always present (`null` where not applicable):

- `ts` (string): ISO 8601 time the event was written
- `event` (string): `run_created`, `task_transition`, or `security_audit`
- `sessionId` (string): Run session id (≤64 chars)
- `taskId` (string or null): Task id (≤64 chars); `null` for run-level events
- `from` (string or null): Previous task status (≤32 chars)
- `to` (string): New task status, or `PASS`/`FAIL` for `security_audit` (≤32 chars)
- `round` (integer): Task round; `0` when not applicable
- `agent` (string or null): Actor that performed the transition (≤64 chars)
- `branch` (string or null): Task branch (≤120 chars)
- `worktree` (string or null): Task worktree path (≤200 chars)
- `phase` (string or null): Run phase after the event (≤32 chars)

The three event kinds:

- `run_created`: written by `teamwork_plan` once the run is created. `taskId` and
  `from` are `null`, `to` is `"pending"`, `round` is `0`, `phase` is `"DAG_BUILD"`.
- `task_transition`: written by `teamwork_task_update` after `state.json` is saved.
  `from` is the previous status and `to` the status that landed. `round`, `branch`,
  `worktree` and `phase` are the values after the transition.
- `security_audit`: written by `teamwork_security_audit`. `to` is `"PASS"` or
  `"FAIL"`, and `phase` is the run phase. `taskId`, `from`, `branch`, `worktree` and
  `agent` are `null`, and `round` is `0`.

Example (one `task_transition` line, wrapped here for readability):

```json
{"ts":"2026-01-12T10:15:00.000Z","event":"task_transition","sessionId":"20260112-101500-a1b2",
 "taskId":"R1-impl","from":"worker_active","to":"worker_done","round":1,
 "agent":"team/worker","branch":"teamwork/20260112-101500-a1b2-R1-impl",
 "worktree":"../.teamwork-worktrees/20260112-101500-a1b2/R1-impl","phase":"DISPATCH"}
```

**Actor (`agent`).** On `task_transition` the field records the actor, resolved in
this order: (1) the explicit `agent` input to `teamwork_task_update`, (2) the
calling session's agent, read from the session tree, (3) the agent declared for the
task in `plan.dag.json`. The sentinel passes `agent: "team/worker"` on `worker_done`
and `agent: "team/verifier"` on `verified_pass` / `verified_fail`. Every value is
sanitised before it is written.

**Sanitising.** Every string field is passed through `clean()`, which replaces
control characters and line separators with spaces and truncates to the limit
above. A value can therefore never add a second physical line.

**Locking and symlinks.** Each append runs inside a per-file, in-process lock
(`withFileLock` keyed on the `events.jsonl` path). A symlinked
`events.jsonl` is refused: nothing is written through the link, and the link is left
in place.

**Best-effort, fail-open.** Writing is best-effort. Any error (including a refused
symlink) is swallowed, and no tool result changes because of it. The DAG engine
(`teamwork_next`, `teamwork_task_update`) never reads `events.jsonl`, so a run works
fully without it. Only the timeline view reads it. Without it the timeline falls back
to derived mode, with start and duration unknown.

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

