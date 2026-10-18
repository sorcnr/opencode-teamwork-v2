# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.6] - 2026-10-18

### Added

- **`opencode-teamwork export <session-id>` command**:
  - Offline, standalone HTML and GFM Markdown run reporting.
  - Zero external dependencies or CDNs, self-contained embedded CSS with light/dark theme support (`prefers-color-scheme`).
  - Supports `-o <path>` / `--output <path>` (with path containment and symlink traversal guards), `-m` / `--markdown`, and `-o -` stdout streaming.
  - Comprehensive HTML entity escaping (`h()` / `md()`) protecting all dynamic fields against XSS.
  - Wired `export` and `test:export` into `package.json` scripts and aggregate `npm test`.

### Fixed

- **HTML Report Table Layout**:
  - Fixed table column collapse when expanding feedback & summary details by applying `white-space: nowrap` to metadata columns and responsive `min-width` on the task table.

## [0.5.5] - 2026-10-18

### Added

- **`opencode-teamwork timeline <session-id>` command**:
  - Renders a Teamwork run's complete lifecycle in the terminal as a chronological, ANSI-colored timeline (supports `--no-color` and `--json`).
  - Supports both `events` mode (exact wall-clock timings from `events.jsonl`) and honest `derived` mode (`[APPROX]`, no fabricated durations).
  - Timezone-invariant date parsing and formatting.
  - Added 65 hermetic tests in `scripts/test-timeline.mjs` wired into `npm test`.
- **Engine Events Log (`events.jsonl`)**:
  - Appends JSONL events on lifecycle transitions (`run_created`, `task_transition`, `security_audit`) inside locked sections, recording the actual calling actor identity (`team/worker`, `team/verifier`, etc.).
- **Per-Task Cost & Token Attribution**:
  - `costs.json` now records additive `byTaskTokens` (per-task token deltas) alongside task-specific spend, surfaced by the timeline.

### Security & Hardening

- **SEC-1 (Path Traversal in Worktrees)**: Fixed critical arbitrary recursive directory deletion vulnerability in `worktree setup` by introducing strict `TASK_ID` regex allowlist validation and `path.relative()` containment assertions.
- **SEC-2 (Prototype Pollution)**: Converted `byTask`, `byTaskTokens`, and `state.tasks` to null-prototype maps (`Object.create(null)`) with `hasOwnProperty` checks, preventing `constructor` and `__proto__` task IDs from producing NaN, dropping spend, or injecting phantom tasks.
- **SEC-3 (Terminal ANSI / OSC 52 Injection)**: Stripped control characters, OSC 52 clipboard sequences, and C1 bytes from branch names and echoes.
- **SEC-4 (Bounded Safe Reads)**: Replaced unbounded file reads with explicit reason codes (`oversize`, `unreadable`, `absent`, `ok`) and a 64 MiB ceiling.

## [0.5.4] - 2026-10-18

### Changed

- **Set `mode: all` on all team subagents**:
  - OpenCode V2's user interface dropdown only displays agents with `mode: primary` or `mode: all` (agents with `mode: subagent` are hidden from the human user interface).
  - Switched `mode: all` on `worker`, `verifier`, `security-auditor`, `scout`, `synthesizer`, `proof-worker`, `falsifier`, and `proposer`. All 11 team agents can now be seen and selected directly in the OpenCode interface, while remaining fully callable as subagents.

## [0.5.3] - 2026-10-18

### Added

- **`opencode-teamwork doctor` diagnostic command**:
  - Standalone, zero-dependency diagnostic runner in `lib/doctor.mjs` checking 7 environmental invariants: config file presence/validity, plugin registration, 11 installed agents, model map synchronization, git binary, git work tree presence, and worktree directory access.
  - Pretty-printed human readable terminal output with `[✓]`, `[!]`, and `[✗]` status indicators.
  - Added `--json` flag to `opencode-teamwork doctor` for machine-readable diagnostics.
  - Added hermetic automated test suite in `scripts/test-doctor.mjs` wired into `npm test`.

### Fixed

- **Subagent Model & Dispatch Visibility in OpenCode V2**:
  - Subagents previously had `hidden: true` in their frontmatter, causing OpenCode V2 to filter them out of the `subagent` tool schema presented to LLMs. Switched to `hidden: false` on all 8 subagents (`worker`, `verifier`, `security-auditor`, `scout`, `synthesizer`, `proof-worker`, `falsifier`, `proposer`) so OpenCode natively exposes them in the `subagent` tool schema.
  - Updated `sentinel.md` with explicit dispatch rules mandating `agent: "team/*"` (e.g. `team/worker`, `team/verifier`) and strictly forbidding fallback to `general`. This ensures subagents execute with their allocated model (e.g. Claude Haiku / DeepSeek) and dedicated permissions.
- **Model Map Priority Inversion in `lib/team.mjs`**:
  - Fixed `currentModels()` so user configuration in `teamwork.json` takes precedence over installed agent markdown files. Manual edits in `teamwork.json` are now reliably preserved and applied across `install` and `status` runs without dual-list warnings.

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
