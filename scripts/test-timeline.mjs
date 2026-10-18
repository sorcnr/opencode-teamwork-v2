// opencode-teamwork-v2 — lifecycle timeline test suite
//
// Hermetic, zero-dependency coverage for `lib/timeline.mjs` and the
// `opencode-teamwork timeline` CLI. Every fixture is a synthetic run directory
// inside its own mkdtemp dir. The CLI is spawned with cwd set to the fixture
// root and HOME pointed at an empty temp dir, so neither the developer's real
// ~/.config/opencode nor the live .opencode/teamwork/ tree is ever read.
//
// Run with plain Node (no test framework): failures are counted, printed, and
// make the process exit non-zero.

import { buildTimeline, renderTimeline } from "../lib/timeline.mjs"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import assert from "node:assert"

const here = dirname(fileURLToPath(import.meta.url))
const cliPath = join(here, "..", "bin", "opencode-teamwork.mjs")
const ESC = "\u001b["

// Root temp dir for this run; every fixture lives under it and it is removed in the end.
const testDir = mkdtempSync(join(tmpdir(), "teamwork-timeline-test-"))

// An empty HOME: any accidental read of ~/.config/opencode finds nothing.
const emptyHome = mkdtempSync(join(testDir, "home-"))

// Keep the in-process environment hermetic too.
process.env.HOME = emptyHome
process.env.USERPROFILE = emptyHome
process.env.XDG_CONFIG_HOME = join(emptyHome, ".config")

const SESSION = "20261018-100000-tl01"
const SESSION_TWO = "20261018-110000-tl02"

let passed = 0
let failed = 0

/** Run one named check; a thrown assertion is recorded and the suite continues. */
function check(name, fn) {
  try {
    fn()
    passed++
    console.log(`✓ ${name}`)
  } catch (err) {
    failed++
    console.error(`✗ ${name}\n    ${err && err.message ? err.message : err}`)
  }
}

function makeRoot() {
  return mkdtempSync(join(testDir, "root-"))
}

function runDirOf(root, id) {
  return join(root, ".opencode", "teamwork", id)
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n")
}

// ---------------------------------------------------------------- fixtures

// Known timestamps. Every expected value below is derived by hand from these.
//   run:   run_created 09:59:50 → last event 10:04:00  ⇒ durationMs 250000 (4m 10s)
//   alpha: worker_active 10:00:00 → verifier 10:01:00 → verified_fail r1 10:01:30
//          → worker_active r2 10:02:00 → verifier 10:03:00 → verified_pass r2 10:04:00
//          ⇒ startedAt 10:00:00, endedAt 10:04:00, durationMs 240000 (4m 00s),
//            rounds 2, passedAtRound 2, agent team/worker
//   beta:  worker_active 10:00:10 → blocked r1 10:02:10 ⇒ durationMs 120000 (2m 00s), rounds 1
const EVENTS = [
  { ts: "2026-10-18T09:59:50.000Z", event: "run_created", sessionId: SESSION, taskId: null, from: null, to: "pending", round: 0, agent: null, branch: null, worktree: null, phase: "DAG_BUILD" },
  { ts: "2026-10-18T10:00:00.000Z", event: "task_transition", sessionId: SESSION, taskId: "alpha", from: "pending", to: "worker_active", round: 1, agent: "team/worker", branch: "teamwork/tl-alpha", worktree: "/wt/alpha", phase: "DISPATCH" },
  { ts: "2026-10-18T10:00:10.000Z", event: "task_transition", sessionId: SESSION, taskId: "beta", from: "pending", to: "worker_active", round: 1, agent: "team/worker", branch: "teamwork/tl-beta", worktree: "/wt/beta", phase: "DISPATCH" },
  { ts: "2026-10-18T10:01:00.000Z", event: "task_transition", sessionId: SESSION, taskId: "alpha", from: "worker_active", to: "verifier_active", round: 1, agent: "team/verifier", branch: "teamwork/tl-alpha", worktree: "/wt/alpha", phase: "VERIFY" },
  { ts: "2026-10-18T10:01:30.000Z", event: "task_transition", sessionId: SESSION, taskId: "alpha", from: "verifier_active", to: "verified_fail", round: 1, agent: "team/verifier", branch: "teamwork/tl-alpha", worktree: "/wt/alpha", phase: "VERIFY" },
  { ts: "2026-10-18T10:02:00.000Z", event: "task_transition", sessionId: SESSION, taskId: "alpha", from: "verified_fail", to: "worker_active", round: 2, agent: "team/worker", branch: "teamwork/tl-alpha", worktree: "/wt/alpha", phase: "DISPATCH" },
  { ts: "2026-10-18T10:02:10.000Z", event: "task_transition", sessionId: SESSION, taskId: "beta", from: "worker_active", to: "blocked", round: 1, agent: "team/verifier", branch: "teamwork/tl-beta", worktree: "/wt/beta", phase: "VERIFY" },
  { ts: "2026-10-18T10:03:00.000Z", event: "task_transition", sessionId: SESSION, taskId: "alpha", from: "worker_active", to: "verifier_active", round: 2, agent: "team/verifier", branch: "teamwork/tl-alpha", worktree: "/wt/alpha", phase: "VERIFY" },
  { ts: "2026-10-18T10:04:00.000Z", event: "task_transition", sessionId: SESSION, taskId: "alpha", from: "verifier_active", to: "verified_pass", round: 2, agent: "team/verifier", branch: "teamwork/tl-alpha", worktree: "/wt/alpha", phase: "VERIFY" },
]

const STATE = {
  version: 1,
  sessionId: SESSION,
  phase: "DONE",
  tasks: {
    alpha: { status: "verified_pass", round: 2, updatedAt: "2026-10-18T10:04:00.000Z", branch: "teamwork/tl-alpha", worktree: "/wt/alpha", summary: "alpha done", feedback: null, verification: null },
    beta: { status: "blocked", round: 1, updatedAt: "2026-10-18T10:02:10.000Z", branch: "teamwork/tl-beta", worktree: "/wt/beta", summary: "beta blocked", feedback: null, verification: null },
  },
  updatedAt: "2026-10-18T10:04:00.000Z",
}

const PLAN = {
  sessionId: SESSION,
  topology: "iterative-coding",
  tasks: [
    { id: "alpha", dependsOn: [], requirements: [], agent: "team/worker", maxRounds: 4, status: "verified_pass", round: 2 },
    { id: "beta", dependsOn: [], requirements: [], agent: "team/worker", maxRounds: 4, status: "blocked", round: 1 },
  ],
}

const COSTS = {
  sessionId: SESSION,
  rootSessionIds: ["ses_root"],
  budgetUsd: 5,
  budgetSource: "manual",
  spentUsd: 0.21,
  byTask: { alpha: 0.12, beta: 0.05, _sentinel: 0.01, _unattributed: 0.02, "team/worker": 0.01 },
  updatedAt: "2026-10-18T10:04:00.000Z",
  tokens: { input: 1000, output: 200, reasoning: 0, cache: { read: 5, write: 6 } },
}

/**
 * Write a run directory under a fresh root and return the root.
 * Pass `null` for any file to omit it (an explicit `undefined` would take the default).
 */
function makeRun({ id = SESSION, events = null, state = STATE, plan = PLAN, costs = COSTS, reports = {} } = {}) {
  const root = makeRoot()
  const dir = runDirOf(root, id)
  mkdirSync(dir, { recursive: true })
  if (events !== null) {
    writeFileSync(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n")
  }
  if (state !== null) writeJson(join(dir, "state.json"), state)
  if (plan !== null) writeJson(join(dir, "plan.dag.json"), plan)
  if (costs !== null) writeJson(join(dir, "costs.json"), costs)
  for (const [taskId, report] of Object.entries(reports)) {
    writeJson(join(dir, "verify", `report-${taskId}.json`), report)
  }
  return root
}

function taskOf(timeline, taskId) {
  const t = timeline.tasks.find((x) => x.taskId === taskId)
  assert(t, `task ${taskId} must be present in timeline.tasks`)
  return t
}

const TASK_KEYS = [
  "taskId", "status", "rounds", "passedAtRound", "agent", "branch", "startedAt", "endedAt",
  "durationMs", "approx", "costUsd", "tokens", "note",
]
const TIMELINE_KEYS = [
  "sessionId", "topology", "phase", "mode", "budgetUsd", "budgetSource", "spentUsd",
  "startedAt", "endedAt", "durationMs", "tasks", "unattributed", "totals",
]
const TOTALS_KEYS = ["tasks", "passed", "failed", "blocked", "totalRounds", "spentUsd", "tokens"]

function assertShape(t) {
  assert.deepStrictEqual(Object.keys(t).sort(), [...TIMELINE_KEYS].sort(), "top-level R2 keys")
  assert.deepStrictEqual(Object.keys(t.totals).sort(), [...TOTALS_KEYS].sort(), "totals keys")
  assert(Array.isArray(t.tasks), "tasks must be an array")
  for (const task of t.tasks) {
    assert.deepStrictEqual(Object.keys(task).sort(), [...TASK_KEYS].sort(), `task keys for ${task.taskId}`)
  }
  assert(Array.isArray(t.unattributed), "unattributed must be an array")
}

// Shared fixtures (built once; every one lives under testDir).
const eventsRoot = makeRun({ events: EVENTS, reports: { alpha: { taskId: "alpha", round: 2, status: "PASS" } } })
const derivedRoot = makeRun({ events: null, reports: { alpha: { taskId: "alpha", round: 2, status: "PASS" } } })
const eventsTimeline = buildTimeline(eventsRoot, SESSION)
const derivedTimeline = buildTimeline(derivedRoot, SESSION)

// ==========================================
// 1. events mode
// ==========================================

check("events mode: mode and run-level startedAt/endedAt/durationMs are exact", () => {
  const t = eventsTimeline
  assert.strictEqual(t.mode, "events")
  assert.strictEqual(t.startedAt, "2026-10-18T09:59:50.000Z")
  assert.strictEqual(t.endedAt, "2026-10-18T10:04:00.000Z")
  assert.strictEqual(t.durationMs, 250000)
  assert.strictEqual(t.sessionId, SESSION)
  assert.strictEqual(t.topology, "iterative-coding")
  assert.strictEqual(t.phase, "DONE")
  assert.strictEqual(t.budgetUsd, 5)
  assert.strictEqual(t.budgetSource, "manual")
  assert.strictEqual(t.spentUsd, 0.21)
})

check("events mode: alpha startedAt/endedAt/durationMs/rounds/passedAtRound/agent are exact", () => {
  const a = taskOf(eventsTimeline, "alpha")
  assert.strictEqual(a.startedAt, "2026-10-18T10:00:00.000Z")
  assert.strictEqual(a.endedAt, "2026-10-18T10:04:00.000Z")
  assert.strictEqual(a.durationMs, 240000)
  assert.strictEqual(a.rounds, 2)
  assert.strictEqual(a.passedAtRound, 2)
  assert.strictEqual(a.agent, "team/worker")
  assert.strictEqual(a.status, "verified_pass")
  assert.strictEqual(a.branch, "teamwork/tl-alpha")
  assert.strictEqual(a.approx, false)
})

check("events mode: beta (blocked) has exact duration, no pass round, approx false", () => {
  const b = taskOf(eventsTimeline, "beta")
  assert.strictEqual(b.startedAt, "2026-10-18T10:00:10.000Z")
  assert.strictEqual(b.endedAt, "2026-10-18T10:02:10.000Z")
  assert.strictEqual(b.durationMs, 120000)
  assert.strictEqual(b.rounds, 1)
  assert.strictEqual(b.passedAtRound, null)
  assert.strictEqual(b.agent, "team/worker")
  assert.strictEqual(b.approx, false)
})

check("events mode: totals are exact", () => {
  const { totals } = eventsTimeline
  assert.strictEqual(totals.tasks, 2)
  assert.strictEqual(totals.passed, 1)
  assert.strictEqual(totals.failed, 0)
  assert.strictEqual(totals.blocked, 1)
  assert.strictEqual(totals.totalRounds, 3)
})

// ==========================================
// 2. derived mode
// ==========================================

check("derived mode: mode, durationMs 0 together with approx true, startedAt null", () => {
  const t = derivedTimeline
  assert.strictEqual(t.mode, "derived")
  assert.strictEqual(t.startedAt, null)
  assert.strictEqual(t.durationMs, 0)
  for (const task of [taskOf(t, "alpha"), taskOf(t, "beta")]) {
    assert.strictEqual(task.durationMs, 0, `${task.taskId} durationMs must be 0`)
    assert.strictEqual(task.approx, true, `${task.taskId} must be approx`)
    assert.strictEqual(task.startedAt, null, `${task.taskId} startedAt must be null`)
  }
})

check("derived mode: passedAtRound comes from verify/report-<taskId>.json", () => {
  assert.strictEqual(taskOf(derivedTimeline, "alpha").passedAtRound, 2)
  assert.strictEqual(taskOf(derivedTimeline, "beta").passedAtRound, null)
})

check("derived mode: passedAtRound follows the report round, not the state round", () => {
  // state says alpha passed at round 2; the report says round 3. Must follow the report.
  const root = makeRun({ events: null, reports: { alpha: { taskId: "alpha", round: 3, status: "PASS" } } })
  assert.strictEqual(taskOf(buildTimeline(root, SESSION), "alpha").passedAtRound, 3)
})

check("derived mode: a FAIL report does not produce a passedAtRound", () => {
  const root = makeRun({ events: null, reports: { alpha: { taskId: "alpha", round: 2, status: "FAIL" } } })
  assert.strictEqual(taskOf(buildTimeline(root, SESSION), "alpha").passedAtRound, null)
})

check("derived mode: totals still come from state.json", () => {
  const { totals } = derivedTimeline
  assert.strictEqual(totals.tasks, 2)
  assert.strictEqual(totals.passed, 1)
  assert.strictEqual(totals.blocked, 1)
  assert.strictEqual(totals.totalRounds, 3)
})

// ==========================================
// 3. no fabrication
// ==========================================

check("no fabrication: hand-carried startedAt/durationMs in state.json are ignored", () => {
  const forged = JSON.parse(JSON.stringify(STATE))
  forged.startedAt = "2020-01-01T00:00:00.000Z"
  forged.durationMs = 987654321
  forged.tasks.alpha.startedAt = "2020-01-01T00:00:00.000Z"
  forged.tasks.alpha.durationMs = 987654321
  forged.tasks.beta.startedAt = "2020-01-01T00:00:00.000Z"
  forged.tasks.beta.durationMs = 111
  const t = buildTimeline(makeRun({ events: null, state: forged }), SESSION)
  assert.strictEqual(t.mode, "derived")
  assert.strictEqual(t.startedAt, null, "run startedAt must not be taken from state.json")
  assert.strictEqual(t.durationMs, 0, "run durationMs must not be taken from state.json")
  for (const task of t.tasks) {
    assert.strictEqual(task.startedAt, null, `${task.taskId} startedAt must not be forged`)
    assert.strictEqual(task.durationMs, 0, `${task.taskId} durationMs must not be forged`)
    assert.strictEqual(task.approx, true, `${task.taskId} must stay approx`)
  }
})

check("no fabrication: derived endedAt is the state updatedAt, not an invented start", () => {
  assert.strictEqual(taskOf(derivedTimeline, "alpha").endedAt, "2026-10-18T10:04:00.000Z")
  assert.strictEqual(taskOf(derivedTimeline, "beta").endedAt, "2026-10-18T10:02:10.000Z")
})

// ==========================================
// 4. corrupt tolerance and missing files
// ==========================================

check("corrupt tolerance: unparseable/truncated lines are skipped, valid events still used", () => {
  // Garbage between valid lines, non-object JSON, a blank line, and a truncated
  // tail with no newline (a partial write at process kill).
  const lines = EVENTS.map((e) => JSON.stringify(e))
  const corrupt = [
    lines[0], "{not json at all", lines[1], "42", "[]", "", lines[2], lines[3],
    '{"ts":"2026-10-18T10:0', lines[4], lines[5], lines[6], lines[7], lines[8],
  ].join("\n") + "\n" + '{"ts":"2026-10-18T10:05'
  const root = makeRun({ events: null })
  writeFileSync(join(runDirOf(root, SESSION), "events.jsonl"), corrupt)
  const t = buildTimeline(root, SESSION)
  assert.strictEqual(t.mode, "events", "corrupt events must still yield events mode")
  assert.strictEqual(t.startedAt, eventsTimeline.startedAt)
  assert.strictEqual(t.endedAt, eventsTimeline.endedAt)
  assert.strictEqual(t.durationMs, 250000)
  assert.deepStrictEqual(t.tasks, eventsTimeline.tasks, "tasks must equal the clean-events result")
})

check("corrupt tolerance: a file of pure garbage falls back to derived mode without throwing", () => {
  const root = makeRun({ events: null })
  writeFileSync(join(runDirOf(root, SESSION), "events.jsonl"), "garbage\n{\n\n")
  const t = buildTimeline(root, SESSION)
  assert.strictEqual(t.mode, "derived")
  assert.strictEqual(t.durationMs, 0)
  assert.strictEqual(taskOf(t, "alpha").approx, true)
})

check("missing run dir yields a well-formed empty timeline (no throw)", () => {
  const t = buildTimeline(makeRoot(), "20261018-999999-none")
  assertShape(t)
  assert.deepStrictEqual(t.tasks, [])
  assert.strictEqual(t.durationMs, 0)
})

check("missing state.json yields a well-formed timeline with no tasks (no throw)", () => {
  const root = makeRun({ events: null, state: null, plan: null, costs: null })
  const t = buildTimeline(root, SESSION)
  assertShape(t)
  assert.deepStrictEqual(t.tasks, [])
  assert.strictEqual(t.mode, "derived")
})

check("no runs at all yields a well-formed empty timeline (no throw)", () => {
  const t = buildTimeline(makeRoot())
  assertShape(t)
  assert.deepStrictEqual(t.tasks, [])
})

check("default sessionId picks the most recently modified run", () => {
  const root = makeRun({ events: EVENTS })
  const older = runDirOf(root, SESSION_TWO)
  mkdirSync(older, { recursive: true })
  writeJson(join(older, "state.json"), { ...STATE, sessionId: SESSION_TWO })
  const past = new Date("2020-01-01T00:00:00Z")
  utimesSync(older, past, past)
  assert.strictEqual(buildTimeline(root).sessionId, SESSION)
})

// ==========================================
// 5. cost attribution
// ==========================================

check("cost attribution: task buckets land on the right tasks", () => {
  assert.strictEqual(taskOf(eventsTimeline, "alpha").costUsd, 0.12)
  assert.strictEqual(taskOf(eventsTimeline, "beta").costUsd, 0.05)
  assert.strictEqual(taskOf(derivedTimeline, "alpha").costUsd, 0.12)
})

check("cost attribution: _sentinel/_unattributed/agent buckets are unattributed and NOT tasks", () => {
  const byBucket = Object.fromEntries(eventsTimeline.unattributed.map((u) => [u.bucket, u.costUsd]))
  assert.deepStrictEqual(byBucket, { _sentinel: 0.01, _unattributed: 0.02, "team/worker": 0.01 })
  assert.strictEqual(eventsTimeline.tasks.length, 2, "non-task buckets must not add task rows")
  assert(
    !eventsTimeline.tasks.some((x) => x.taskId.startsWith("_") || x.taskId.includes("/")),
    "no internal bucket may be a task",
  )
})

check("cost attribution: non-task buckets never leak into per-task costUsd", () => {
  // If _sentinel/_unattributed/team/worker leaked into a task, these values would change.
  assert.strictEqual(taskOf(eventsTimeline, "alpha").costUsd, 0.12)
  assert.strictEqual(taskOf(eventsTimeline, "beta").costUsd, 0.05)
})

check("cost attribution: a plan task with no cost bucket gets costUsd null", () => {
  const costs = { ...COSTS, byTask: { _sentinel: 0.5 } }
  const t = buildTimeline(makeRun({ events: EVENTS, costs }), SESSION)
  assert.strictEqual(taskOf(t, "alpha").costUsd, null)
  assert.strictEqual(taskOf(t, "beta").costUsd, null)
  assert.deepStrictEqual(t.unattributed, [{ bucket: "_sentinel", costUsd: 0.5 }])
})

check("cost attribution: per-task tokens are null; totals carry the run tokens", () => {
  assert.strictEqual(taskOf(eventsTimeline, "alpha").tokens, null)
  assert.strictEqual(taskOf(eventsTimeline, "beta").tokens, null)
  assert.deepStrictEqual(eventsTimeline.totals.tokens, COSTS.tokens)
  assert.strictEqual(eventsTimeline.totals.spentUsd, 0.21)
})

// ==========================================
// 6. render purity / colour
// ==========================================

check("render: color false emits no ANSI escape", () => {
  const lines = renderTimeline(eventsTimeline, { color: false })
  assert(Array.isArray(lines) && lines.length > 0, "renderTimeline must return a non-empty string array")
  for (const line of lines) assert.strictEqual(typeof line, "string")
  assert(!lines.some((l) => l.includes(ESC)), "no line may contain an ANSI escape when color is false")
})

check("render: color false emits no ANSI escape for a derived timeline", () => {
  const lines = renderTimeline(derivedTimeline, { color: false })
  assert(!lines.some((l) => l.includes(ESC)), "derived render must be plain with color false")
})

check("render: color true emits ANSI escapes", () => {
  const lines = renderTimeline(eventsTimeline, { color: true })
  assert(lines.some((l) => l.includes(ESC)), "color true must emit at least one ANSI escape")
})

check("render: events output shows the exact wall-clock, per-task duration and pass round", () => {
  const text = renderTimeline(eventsTimeline, { color: false }).join("\n")
  assert(text.includes("wall-clock: 4m 10s"), `header must show 4m 10s, got:\n${text}`)
  assert(text.includes("duration: 4m 00s"), `alpha must show 4m 00s, got:\n${text}`)
  assert(text.includes("pass@round 2"), "alpha must show its pass round")
})

check("render: derived output marks approximate rows and never prints a 0ms duration", () => {
  const text = renderTimeline(derivedTimeline, { color: false }).join("\n")
  assert(text.includes("[APPROX]"), "derived header must be marked approximate")
  assert(text.includes("~ approx"), "derived rows must be marked approximate")
  assert(text.includes("duration: unknown"), "derived rows must say duration unknown, not 0ms")
  assert(!/duration: 0ms/.test(text), "a derived row must never print duration: 0ms")
})

// ==========================================
// 7. timezone invariance
// ==========================================

check("timezone: durations come from ISO strings, identical under different TZ", () => {
  const runChild = (tz) => {
    const res = spawnSync(process.execPath, [cliPath, "timeline", SESSION, "--json"], {
      cwd: eventsRoot,
      encoding: "utf8",
      env: { ...process.env, TZ: tz, HOME: emptyHome, NO_COLOR: "1" },
    })
    assert.strictEqual(res.status, 0, `timeline under TZ=${tz} must exit 0, got ${res.status}: ${res.stderr}`)
    return JSON.parse(res.stdout)
  }
  const tokyo = runChild("Asia/Tokyo")
  const la = runChild("America/Los_Angeles")
  assert.deepStrictEqual(tokyo, la, "output must not depend on TZ")
  assert.deepStrictEqual(tokyo, JSON.parse(JSON.stringify(eventsTimeline)), "CLI output must match the library")
  assert.strictEqual(tokyo.durationMs, 250000)
  assert.strictEqual(taskOf(tokyo, "alpha").durationMs, 240000)
})

check("timezone: human render is identical under different TZ", () => {
  const under = (tz) => {
    const res = spawnSync(process.execPath, [cliPath, "timeline", SESSION, "--no-color"], {
      cwd: eventsRoot,
      encoding: "utf8",
      env: { ...process.env, TZ: tz, HOME: emptyHome },
    })
    assert.strictEqual(res.status, 0, `human render under TZ=${tz} must exit 0`)
    return res.stdout
  }
  const tokyo = under("Asia/Tokyo")
  assert(tokyo.includes("wall-clock: 4m 10s"), "human output must show 4m 10s under Tokyo")
  assert.strictEqual(tokyo, under("Pacific/Kiritimati"), "human output must not depend on TZ")
})

// ==========================================
// 8. CLI contract (real bin, cwd = fixture root)
// ==========================================

function runCli(args, cwd) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HOME: emptyHome, NO_COLOR: "" },
  })
}

check("CLI: `timeline <id> --json` exits 0, stderr empty, parses, matches R2 shape", () => {
  const res = runCli(["timeline", SESSION, "--json"], eventsRoot)
  assert.strictEqual(res.status, 0, `exit must be 0, got ${res.status}: ${res.stderr}`)
  assert.strictEqual(res.stderr, "", "--json stderr must be empty")
  assert(!res.stdout.includes(ESC), "--json stdout must have no ANSI escapes")
  const parsed = JSON.parse(res.stdout)
  assertShape(parsed)
  assert.strictEqual(parsed.mode, "events")
  assert.strictEqual(parsed.durationMs, 250000)
  assert.strictEqual(taskOf(parsed, "alpha").passedAtRound, 2)
})

check("CLI: `--session <id> --json` is equivalent to the positional form", () => {
  const res = runCli(["timeline", "--session", SESSION, "--json"], eventsRoot)
  assert.strictEqual(res.status, 0, `exit must be 0, got ${res.status}: ${res.stderr}`)
  assert.strictEqual(res.stderr, "")
  assertShape(JSON.parse(res.stdout))
})

check("CLI: derived run `--json` has mode derived and approx rows with durationMs 0", () => {
  const res = runCli(["timeline", SESSION, "--json"], derivedRoot)
  assert.strictEqual(res.status, 0, `exit must be 0, got ${res.status}: ${res.stderr}`)
  assert.strictEqual(res.stderr, "", "derived --json stderr must be empty")
  const parsed = JSON.parse(res.stdout)
  assertShape(parsed)
  assert.strictEqual(parsed.mode, "derived")
  assert(parsed.tasks.length > 0, "derived run must list tasks")
  for (const task of parsed.tasks) {
    assert.strictEqual(task.approx, true)
    assert.strictEqual(task.durationMs, 0)
  }
})

check("CLI: a missing session exits 1 and explains on stderr", () => {
  const res = runCli(["timeline", "20261018-999999-none", "--json"], eventsRoot)
  assert.strictEqual(res.status, 1, `missing session must exit 1, got ${res.status}`)
  assert(res.stderr.length > 0, "missing session must explain itself on stderr")
})

check("CLI: no runs at all exits 1", () => {
  const res = runCli(["timeline"], makeRoot())
  assert.strictEqual(res.status, 1, `no runs must exit 1, got ${res.status}`)
})

check("CLI: a valid session exits 0 in human mode, no ANSI under --no-color", () => {
  const res = runCli(["timeline", SESSION, "--no-color"], eventsRoot)
  assert.strictEqual(res.status, 0, `valid session must exit 0, got ${res.status}: ${res.stderr}`)
  assert(!res.stdout.includes(ESC), "--no-color stdout must have no ANSI escapes")
  assert(res.stdout.includes("Teamwork timeline"), "human output must have a header")
})

check("CLI: no `unknown argument` warning for timeline's positional id", () => {
  const res = runCli(["timeline", SESSION, "--json"], eventsRoot)
  assert(!res.stderr.includes("Ignoring unknown argument"), `unexpected warning: ${res.stderr}`)
})

// ---------------------------------------------------------------- cleanup

rmSync(testDir, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
