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
├── verify/report-<task>.json
├── verify/summary.json
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
  "phase": "LOAD_SPEC|WORKTREE_INIT|DAG_BUILD|DISPATCH|MERGE|PRESENT_PARTIAL|DONE",
  "tasks": {
    "R1-impl": { "status": "pending|running|pass|fail", "round": 0, "lastReport": "verify/report-R1-impl.json" }
  },
  "updatedAt": "2026-01-12T10:15:00Z"
}
```

Resume: re-read `state.json`, skip tasks already `pass`, continue the current
`round` for `fail`/`running`.

### `costs.json`

```json
{ "sessionId": "...", "budgetUsd": 20, "spentUsd": 0, "byTask": {}, "updatedAt": "ISO8601" }
```

Cost figures are best-effort. Subagents cannot reliably observe their own token
usage, so treat worker-reported `cost.json` as an estimate and prefer the
plugin's session-hook accounting when available.

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

### `pitfalls.md`

One line per entry:

```
- [round 2] assumes the input is already sorted — seen in R1-impl
```

### `scout-report.md`, `candidates/*.md`, `critiques/*.md`, `synthesis/*.md`

Free-form markdown following the section structure described in the scout,
proposer, falsifier and synthesizer agent files.
