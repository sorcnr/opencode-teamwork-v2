# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.2] - 2026-10-18

### Added

- **Complete OpenCode session tree consumption tracking**: `teamwork_cost` and
  `teamwork_plan` now discover and aggregate the entire OpenCode session tree
  (root Sentinel session + all spawned child/subagent sessions, including
  `team/worker`, `team/verifier`, `team/scout`, and adversaries) using OpenCode's
  native SQLite database (`session_v2` recursive query) and background service API.
- Subagent consumptions (such as verifier rounds using frontier models) are no
  longer ignored or lost if a worker halts without calling `teamwork_cost`.
- Added aggregate token usage tracking (`costs.tokens`) across all sessions in
  the tree.
- **Deterministic DAG & Worktree Engine Tools**:
  - `teamwork_next`: Evaluates DAG dependencies and task states to determine ready tasks (`readyForWorker`, `readyForVerifier`), in-progress tasks, injects known pitfalls (`avoidPitfalls`), and enforces the pre-merge security gate.
  - `teamwork_task_update`: Enforces deterministic state transitions (`pending` → `worker_active` → `worker_done` → `verifier_active` → `verified_pass` | `verified_fail` | `blocked`), tracking rounds, worker branches, diff summaries, and verification results. Automatically marks tasks `blocked` if `maxRounds` is exceeded.
  - `teamwork_security_audit`: Enforces mandatory pre-merge security gate (`verify/security-audit.json`). If Critical or High findings exist, blocks final merge (`BLOCKED_BY_SECURITY`).
  - `teamwork_worktree`: Out-of-repo git worktree lifecycle management (`setup`, `diff`, `merge`, `resolve`, `cleanup`). On merge conflict, produces `synthesis/conflict-<taskId>.json` with 3-way diffs for `team/synthesizer`. Self-heals broken or stale worktrees automatically.
- **Dynamic Pitfall Injection**:
  - Known failure modes logged via `teamwork_pitfall` are dynamically injected into `readyForWorker` tasks and surfaced in `describeRun` context.
- **CLI Run Management & Inspection**:
  - `opencode-teamwork runs`: Table summary of all sessions, statuses, security audits, and spent budgets.
  - `opencode-teamwork inspect <id>`: Detailed DAG inspection, task breakdowns, conflict artifacts, and pitfall registries.
  - `opencode-teamwork prune`: Prunes out-of-repo git worktrees for completed sessions.
- Added automated test suite for DAG engine, security gate, conflict handling, and CLI helpers (`npm run test:engine`).
- Added automated test suite for session tree cost tracking (`npm run test:cost`).

### Changed

- Updated `sentinel.md`, `worker.md`, `synthesizer.md`, and `docs/ARTIFACTS.md` to reflect the mandatory pre-merge security gate, dynamic pitfall injection, conflict resolution mode, and new tool options.

## [0.5.1] - 2026-10-12

### Fixed

- **Cost reporting is now accurate.** `teamwork_cost` reads the real,
  OpenCode-computed cost from the native per-session client
  (`ctx.session.get`), instead of trusting agent self-reports. This fixes
  over-reporting (e.g. `$4` reported when the real spend was `$1`) caused by
  cumulative self-reporting and a read-modify-write race on `costs.json`.
- Per-task costs now always sum to the run total — every dollar is attributed
  to a bucket (`_unattributed` when no task is given).
- `budgetUsd: 0` is respected (nullish coalescing instead of `||`); negative
  `addUsd` is rejected.
- Re-planning with a new budget no longer wipes accumulated spend, and now also
  updates `budgetSource`.
- `costs.json` / `snapshots.json` writes are atomic (`.tmp` + rename, with the
  temp path symlink-guarded).
- Concurrent `teamwork_cost` calls are serialized per run, so parallel workers
  can no longer lose each other's attribution.
- A session's first cost check attributes its full cost, so worker sessions are
  no longer reported as `$0`.

### Added

- `teamwork_budget` preflight tool: detects `opencode/` (managed) models — via
  the active session model, the location default, or any `team/*` agent model —
  and a connected `opencode_console` MCP server. When both hold, it instructs
  the sentinel to read console credits (`opencode_console_get_usage` →
  `min(limitDollars - spentDollars)`) and **ask the user** whether to use the
  full remaining budget or a partial (half) amount. `teamwork_plan` records
  `budgetSource` and warns when credits apply but weren't used.
- Cost line injected into every team agent's context (`describeRun`).
- Sentinel: a budget-preflight step and a post-completion `team/verifier` step
  (writes `verify/final.json`).
- `snapshots.json` artifact for per-session cost baselines.

### Changed

- `agents/team/worker.md`: removed the dead `cost.json` estimate; workers now
  call `teamwork_cost` with their `taskId`.
- `docs/ARTIFACTS.md`: documented `snapshots.json`, `budgetSource`, and the
  credits flow.

## [0.5.0] and earlier

See the git history and GitHub releases.
