# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
