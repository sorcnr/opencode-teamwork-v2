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

import { buildTimeline, renderTimeline, timelineWarnings } from "../lib/timeline.mjs"
import { registerTeamworkTools } from "../plugins/opencode-teamwork/tools.ts"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync, symlinkSync, truncateSync, existsSync, lstatSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync, execFileSync } from "node:child_process"
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
async function check(name, fn) {
  try {
    await fn()
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

// A unique path under testDir for a sibling/outside fixture (never collides).
let fixtureSeq = 0
const uniq = (label) => join(testDir, `${label}-${++fixtureSeq}`)

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

await check("events mode: mode and run-level startedAt/endedAt/durationMs are exact", () => {
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

await check("events mode: alpha startedAt/endedAt/durationMs/rounds/passedAtRound/agent are exact", () => {
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

await check("events mode: beta (blocked) has exact duration, no pass round, approx false", () => {
  const b = taskOf(eventsTimeline, "beta")
  assert.strictEqual(b.startedAt, "2026-10-18T10:00:10.000Z")
  assert.strictEqual(b.endedAt, "2026-10-18T10:02:10.000Z")
  assert.strictEqual(b.durationMs, 120000)
  assert.strictEqual(b.rounds, 1)
  assert.strictEqual(b.passedAtRound, null)
  assert.strictEqual(b.agent, "team/worker")
  assert.strictEqual(b.approx, false)
})

await check("events mode: totals are exact", () => {
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

await check("derived mode: mode, durationMs 0 together with approx true, startedAt null", () => {
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

await check("derived mode: passedAtRound comes from verify/report-<taskId>.json", () => {
  assert.strictEqual(taskOf(derivedTimeline, "alpha").passedAtRound, 2)
  assert.strictEqual(taskOf(derivedTimeline, "beta").passedAtRound, null)
})

await check("derived mode: passedAtRound follows the report round, not the state round", () => {
  // state says alpha passed at round 2; the report says round 3. Must follow the report.
  const root = makeRun({ events: null, reports: { alpha: { taskId: "alpha", round: 3, status: "PASS" } } })
  assert.strictEqual(taskOf(buildTimeline(root, SESSION), "alpha").passedAtRound, 3)
})

await check("derived mode: a FAIL report does not produce a passedAtRound", () => {
  const root = makeRun({ events: null, reports: { alpha: { taskId: "alpha", round: 2, status: "FAIL" } } })
  assert.strictEqual(taskOf(buildTimeline(root, SESSION), "alpha").passedAtRound, null)
})

await check("derived mode: totals still come from state.json", () => {
  const { totals } = derivedTimeline
  assert.strictEqual(totals.tasks, 2)
  assert.strictEqual(totals.passed, 1)
  assert.strictEqual(totals.blocked, 1)
  assert.strictEqual(totals.totalRounds, 3)
})

// ==========================================
// 3. no fabrication
// ==========================================

await check("no fabrication: hand-carried startedAt/durationMs in state.json are ignored", () => {
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

await check("no fabrication: derived endedAt is the state updatedAt, not an invented start", () => {
  assert.strictEqual(taskOf(derivedTimeline, "alpha").endedAt, "2026-10-18T10:04:00.000Z")
  assert.strictEqual(taskOf(derivedTimeline, "beta").endedAt, "2026-10-18T10:02:10.000Z")
})

// ==========================================
// 4. corrupt tolerance and missing files
// ==========================================

await check("corrupt tolerance: unparseable/truncated lines are skipped, valid events still used", () => {
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

await check("corrupt tolerance: a file of pure garbage falls back to derived mode without throwing", () => {
  const root = makeRun({ events: null })
  writeFileSync(join(runDirOf(root, SESSION), "events.jsonl"), "garbage\n{\n\n")
  const t = buildTimeline(root, SESSION)
  assert.strictEqual(t.mode, "derived")
  assert.strictEqual(t.durationMs, 0)
  assert.strictEqual(taskOf(t, "alpha").approx, true)
})

await check("missing run dir yields a well-formed empty timeline (no throw)", () => {
  const t = buildTimeline(makeRoot(), "20261018-999999-none")
  assertShape(t)
  assert.deepStrictEqual(t.tasks, [])
  assert.strictEqual(t.durationMs, 0)
})

await check("missing state.json yields a well-formed timeline with no tasks (no throw)", () => {
  const root = makeRun({ events: null, state: null, plan: null, costs: null })
  const t = buildTimeline(root, SESSION)
  assertShape(t)
  assert.deepStrictEqual(t.tasks, [])
  assert.strictEqual(t.mode, "derived")
})

await check("no runs at all yields a well-formed empty timeline (no throw)", () => {
  const t = buildTimeline(makeRoot())
  assertShape(t)
  assert.deepStrictEqual(t.tasks, [])
})

await check("default sessionId picks the most recently modified run", () => {
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

await check("cost attribution: task buckets land on the right tasks", () => {
  assert.strictEqual(taskOf(eventsTimeline, "alpha").costUsd, 0.12)
  assert.strictEqual(taskOf(eventsTimeline, "beta").costUsd, 0.05)
  assert.strictEqual(taskOf(derivedTimeline, "alpha").costUsd, 0.12)
})

await check("cost attribution: _sentinel/_unattributed/agent buckets are unattributed and NOT tasks", () => {
  const byBucket = Object.fromEntries(eventsTimeline.unattributed.map((u) => [u.bucket, u.costUsd]))
  assert.deepStrictEqual(byBucket, { _sentinel: 0.01, _unattributed: 0.02, "team/worker": 0.01 })
  assert.strictEqual(eventsTimeline.tasks.length, 2, "non-task buckets must not add task rows")
  assert(
    !eventsTimeline.tasks.some((x) => x.taskId.startsWith("_") || x.taskId.includes("/")),
    "no internal bucket may be a task",
  )
})

await check("cost attribution: non-task buckets never leak into per-task costUsd", () => {
  // If _sentinel/_unattributed/team/worker leaked into a task, these values would change.
  assert.strictEqual(taskOf(eventsTimeline, "alpha").costUsd, 0.12)
  assert.strictEqual(taskOf(eventsTimeline, "beta").costUsd, 0.05)
})

await check("cost attribution: a plan task with no cost bucket gets costUsd null", () => {
  const costs = { ...COSTS, byTask: { _sentinel: 0.5 } }
  const t = buildTimeline(makeRun({ events: EVENTS, costs }), SESSION)
  assert.strictEqual(taskOf(t, "alpha").costUsd, null)
  assert.strictEqual(taskOf(t, "beta").costUsd, null)
  assert.deepStrictEqual(t.unattributed, [{ bucket: "_sentinel", costUsd: 0.5 }])
})

await check("cost attribution: per-task tokens are null; totals carry the run tokens", () => {
  assert.strictEqual(taskOf(eventsTimeline, "alpha").tokens, null)
  assert.strictEqual(taskOf(eventsTimeline, "beta").tokens, null)
  assert.deepStrictEqual(eventsTimeline.totals.tokens, COSTS.tokens)
  assert.strictEqual(eventsTimeline.totals.spentUsd, 0.21)
})

// ==========================================
// 6. render purity / colour
// ==========================================

await check("render: color false emits no ANSI escape", () => {
  const lines = renderTimeline(eventsTimeline, { color: false })
  assert(Array.isArray(lines) && lines.length > 0, "renderTimeline must return a non-empty string array")
  for (const line of lines) assert.strictEqual(typeof line, "string")
  assert(!lines.some((l) => l.includes(ESC)), "no line may contain an ANSI escape when color is false")
})

await check("render: color false emits no ANSI escape for a derived timeline", () => {
  const lines = renderTimeline(derivedTimeline, { color: false })
  assert(!lines.some((l) => l.includes(ESC)), "derived render must be plain with color false")
})

await check("render: color true emits ANSI escapes", () => {
  const lines = renderTimeline(eventsTimeline, { color: true })
  assert(lines.some((l) => l.includes(ESC)), "color true must emit at least one ANSI escape")
})

await check("render: events output shows the exact wall-clock, per-task duration and pass round", () => {
  const text = renderTimeline(eventsTimeline, { color: false }).join("\n")
  assert(text.includes("wall-clock: 4m 10s"), `header must show 4m 10s, got:\n${text}`)
  assert(text.includes("duration: 4m 00s"), `alpha must show 4m 00s, got:\n${text}`)
  assert(text.includes("pass@round 2"), "alpha must show its pass round")
})

await check("render: derived output marks approximate rows and never prints a 0ms duration", () => {
  const text = renderTimeline(derivedTimeline, { color: false }).join("\n")
  assert(text.includes("[APPROX]"), "derived header must be marked approximate")
  assert(text.includes("~ approx"), "derived rows must be marked approximate")
  assert(text.includes("duration: unknown"), "derived rows must say duration unknown, not 0ms")
  assert(!/duration: 0ms/.test(text), "a derived row must never print duration: 0ms")
})

// ==========================================
// 7. timezone invariance
// ==========================================

await check("timezone: durations come from ISO strings, identical under different TZ", () => {
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

await check("timezone: human render is identical under different TZ", () => {
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

await check("CLI: `timeline <id> --json` exits 0, stderr empty, parses, matches R2 shape", () => {
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

await check("CLI: `--session <id> --json` is equivalent to the positional form", () => {
  const res = runCli(["timeline", "--session", SESSION, "--json"], eventsRoot)
  assert.strictEqual(res.status, 0, `exit must be 0, got ${res.status}: ${res.stderr}`)
  assert.strictEqual(res.stderr, "")
  assertShape(JSON.parse(res.stdout))
})

await check("CLI: derived run `--json` has mode derived and approx rows with durationMs 0", () => {
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

await check("CLI: a missing session exits 1 and explains on stderr", () => {
  const res = runCli(["timeline", "20261018-999999-none", "--json"], eventsRoot)
  assert.strictEqual(res.status, 1, `missing session must exit 1, got ${res.status}`)
  assert(res.stderr.length > 0, "missing session must explain itself on stderr")
})

await check("CLI: no runs at all exits 1", () => {
  const res = runCli(["timeline"], makeRoot())
  assert.strictEqual(res.status, 1, `no runs must exit 1, got ${res.status}`)
})

await check("CLI: a valid session exits 0 in human mode, no ANSI under --no-color", () => {
  const res = runCli(["timeline", SESSION, "--no-color"], eventsRoot)
  assert.strictEqual(res.status, 0, `valid session must exit 0, got ${res.status}: ${res.stderr}`)
  assert(!res.stdout.includes(ESC), "--no-color stdout must have no ANSI escapes")
  assert(res.stdout.includes("Teamwork timeline"), "human output must have a header")
})

await check("CLI: no `unknown argument` warning for timeline's positional id", () => {
  const res = runCli(["timeline", SESSION, "--json"], eventsRoot)
  assert(!res.stderr.includes("Ignoring unknown argument"), `unexpected warning: ${res.stderr}`)
})

// ==========================================
// 9. R6.5 — CLI error echo is sanitised and capped
// ==========================================

const CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/
const MiB = 1024 * 1024

await check("R6.5: a hostile --session / positional value is echoed without control bytes", () => {
  const hostile = "A".repeat(20) + "\u001b]52;c;ZZ\u0007\r\nFAKE"
  for (const args of [["timeline", "--session", hostile], ["timeline", hostile]]) {
    const res = runCli(args, eventsRoot)
    assert.strictEqual(res.status, 1, `hostile id must exit 1, got ${res.status}`)
    const msg = res.stderr.replace(/\n$/, "")
    assert(!CONTROL_RE.test(msg), `stderr must carry no control bytes, got ${JSON.stringify(res.stderr)}`)
    assert(msg.startsWith('Run "AAAA'), `stderr must still name the run, got ${JSON.stringify(res.stderr)}`)
  }
})

await check("R6.5: a 200-char --session value is truncated in the error message", () => {
  const res = runCli(["timeline", "--session", "B".repeat(200)], eventsRoot)
  assert.strictEqual(res.status, 1)
  assert(res.stderr.length < 120, `stderr must be short, got ${res.stderr.length} bytes`)
  assert(!res.stderr.includes("B".repeat(65)), "at most 64 chars of the value may be echoed")
})

// ==========================================
// 10. R6.7b — --json escapes DEL and C1 bytes
// ==========================================

await check("R6.7b: --json and human output carry no raw DEL/C1 byte for a hostile branch", () => {
  const hostileBranch = "hx\u009b31mZ\u007fQ\u0085"
  const root = makeRun({
    events: EVENTS,
    state: { ...STATE, tasks: { ...STATE.tasks, alpha: { ...STATE.tasks.alpha, branch: hostileBranch } } },
  })
  const json = runCli(["timeline", SESSION, "--json"], root)
  assert.strictEqual(json.status, 0, `exit must be 0, got ${json.status}: ${json.stderr}`)
  assert(!/[\x7f-\x9f]/.test(json.stdout), `--json stdout must have no raw DEL/C1 byte, got ${JSON.stringify(json.stdout.slice(0, 200))}`)
  assert.strictEqual(JSON.parse(json.stdout).tasks.find((x) => x.taskId === "alpha").branch, hostileBranch, "value must round-trip")
  const human = runCli(["timeline", SESSION, "--no-color"], root)
  assert(!/[\x7f-\x9f]/.test(human.stdout), "human output must have no raw DEL/C1 byte")
})

// ==========================================
// 11. R6.7 — an oversized file is reported, never silently absent or UNKNOWN
// ==========================================

await check("R6.7: a 9.4 MiB events.jsonl is reported as oversize, never as absent", () => {
  const line = JSON.stringify(EVENTS[1]) + "\n"
  const root = makeRun({ events: null })
  writeFileSync(join(runDirOf(root, SESSION), "events.jsonl"), line.repeat(Math.ceil((9.4 * MiB) / line.length)))
  const t = buildTimeline(root, SESSION)
  assertShape(t)
  assert.strictEqual(t.mode, "derived")
  assert.strictEqual(t.durationMs, 0)
  assert.strictEqual(taskOf(t, "alpha").approx, true)
  const warnings = timelineWarnings(t)
  assert(warnings.some((w) => /^events\.jsonl exceeds the 8 MiB read cap \(9\.\d MiB\)$/.test(w)), `warning missing: ${warnings}`)
  const text = renderTimeline(t, { color: false }).join("\n")
  assert(/derived mode: events\.jsonl exceeds the 8 MiB read cap \(9\.\d MiB\); timing unavailable/.test(text), `header must give the oversize reason:\n${text}`)
  assert(!text.includes("no events.jsonl"), "an oversize events.jsonl must never be described as absent")
  assert(taskOf(t, "alpha").note.includes("exceeds the 8 MiB read cap"), "task note must carry the reason (reaches --json)")
})

await check("R6.7: absent events.jsonl is still described as absent, with no warning", () => {
  assert.deepStrictEqual(timelineWarnings(derivedTimeline), [])
  assert(renderTimeline(derivedTimeline, { color: false }).join("\n").includes("derived mode: no events.jsonl"))
})

await check("R6.7: CLI --json warns on stderr when events.jsonl is oversize", () => {
  const line = JSON.stringify(EVENTS[1]) + "\n"
  const root = makeRun({ events: null })
  writeFileSync(join(runDirOf(root, SESSION), "events.jsonl"), line.repeat(Math.ceil((9.4 * MiB) / line.length)))
  const res = runCli(["timeline", SESSION, "--json"], root)
  assert.strictEqual(res.status, 0)
  assert(/warning: events\.jsonl exceeds the 8 MiB read cap/.test(res.stderr), `stderr must warn, got ${res.stderr}`)
  assert.strictEqual(JSON.parse(res.stdout).mode, "derived")
})

await check("R6.7: a 9.4 MiB state.json still yields its real phase, status and rounds", () => {
  const root = makeRun({ events: null, state: null })
  const padded = JSON.stringify({ ...STATE, phase: "SECURITY_AUDIT" }, null, 2) + " ".repeat(9.4 * MiB)
  writeFileSync(join(runDirOf(root, SESSION), "state.json"), padded)
  const t = buildTimeline(root, SESSION)
  assert.strictEqual(t.phase, "SECURITY_AUDIT", `phase must not be UNKNOWN, got ${t.phase}`)
  const alpha = taskOf(t, "alpha")
  assert.strictEqual(alpha.status, "verified_pass")
  assert.strictEqual(alpha.rounds, 2)
  assert.deepStrictEqual(timelineWarnings(t), [], "a readable 9.4 MiB state.json needs no warning")
})

await check("R6.7: a state.json beyond the 64 MiB cap is reported explicitly, not silently", () => {
  const root = makeRun({ events: null, state: null })
  const file = join(runDirOf(root, SESSION), "state.json")
  writeFileSync(file, JSON.stringify(STATE))
  truncateSync(file, 65 * MiB) // sparse: no real disk use, and never read
  const t = buildTimeline(root, SESSION)
  assertShape(t)
  assert(timelineWarnings(t).some((w) => w === "state.json exceeds the 64 MiB read cap (65 MiB)"), `warning missing: ${timelineWarnings(t)}`)
  const text = renderTimeline(t, { color: false }).join("\n")
  assert(text.includes("! state.json exceeds the 64 MiB read cap (65 MiB)"), "the reason must be rendered")
  assert(text.includes("some run files were not read"), "the header must not claim a plain absence")
})

await check("R6.7: an oversize verify report is reported, not treated as no pass", () => {
  const root = makeRun({ events: null, reports: {} })
  const dir = runDirOf(root, SESSION)
  mkdirSync(join(dir, "verify"), { recursive: true })
  const report = join(dir, "verify", "report-alpha.json")
  writeFileSync(report, JSON.stringify({ status: "PASS", round: 2 }))
  truncateSync(report, 65 * MiB)
  const t = buildTimeline(root, SESSION)
  assert(timelineWarnings(t).some((w) => w.startsWith("verify/report-alpha.json exceeds")), `warning missing: ${timelineWarnings(t)}`)
})

// ==========================================
// 12. R6.6 — guardrail coverage for the library read path
// ==========================================

await check("R6.6 (1r): a symlinked events.jsonl is not read by buildTimeline", () => {
  const root = makeRun({ events: null })
  const outside = uniq("outside-events") + ".jsonl"
  writeFileSync(outside, EVENTS.map((e) => JSON.stringify(e)).join("\n") + "\n")
  symlinkSync(outside, join(runDirOf(root, SESSION), "events.jsonl"))
  const t = buildTimeline(root, SESSION)
  assert.strictEqual(t.mode, "derived", "a symlinked events.jsonl must not yield events mode")
  assert.strictEqual(t.durationMs, 0)
  assert(timelineWarnings(t).some((w) => w.startsWith("events.jsonl is not a regular file")), `warning missing: ${timelineWarnings(t)}`)
})

await check("R6.6 (2r): a dangling symlinked events.jsonl is not read by buildTimeline", () => {
  const root = makeRun({ events: null })
  symlinkSync(join(testDir, "no-such-target.jsonl"), join(runDirOf(root, SESSION), "events.jsonl"))
  const t = buildTimeline(root, SESSION)
  assert.strictEqual(t.mode, "derived")
  assert(timelineWarnings(t).some((w) => w.startsWith("events.jsonl is not a regular file")), `warning missing: ${timelineWarnings(t)}`)
})

for (const where of ["outside", "inside"]) {
  await check(`R6.6 (3r): a symlinked .opencode/teamwork run root (target ${where} the project) is refused by buildTimeline`, () => {
    const root = makeRoot()
    // "outside" points at a sibling tree; "inside" points at a directory within the project.
    const target = where === "outside" ? uniq("outside-runs") : join(root, "elsewhere")
    const outDir = join(target, SESSION)
    mkdirSync(outDir, { recursive: true })
    writeJson(join(outDir, "state.json"), STATE)
    writeJson(join(outDir, "plan.dag.json"), PLAN)
    writeFileSync(join(outDir, "events.jsonl"), EVENTS.map((e) => JSON.stringify(e)).join("\n") + "\n")
    mkdirSync(join(root, ".opencode"), { recursive: true })
    symlinkSync(target, join(root, ".opencode", "teamwork"))
    const t = buildTimeline(root, SESSION)
    assertShape(t)
    assert.deepStrictEqual(t.tasks, [], "nothing may be read through a symlinked run root")
    assert.strictEqual(t.mode, "derived")
    assert.strictEqual(t.phase, "UNKNOWN")
    assert(timelineWarnings(t).some((w) => w.includes("symlink")), `warning missing: ${timelineWarnings(t)}`)
    const byDefault = buildTimeline(root)
    assert.strictEqual(byDefault.sessionId, null, "the default run lookup must not list runs through the symlink")
    assert.deepStrictEqual(byDefault.tasks, [])
  })
}

await check("R6.6 (5): hostile task ids cannot read a report outside their own slot", () => {
  const hostile = ["..", "../../x", "a/b", "/abs/x", "a\u0000b", "x".repeat(65)]
  const root = makeRun({
    events: null,
    state: { ...STATE, tasks: Object.fromEntries(hostile.map((id) => [id, { status: "verified_pass", round: 2 }])) },
    plan: { ...PLAN, tasks: hostile.map((id) => ({ id, dependsOn: [], maxRounds: 4 })) },
  })
  const dir = runDirOf(root, SESSION)
  // Plant a PASS report exactly where a naive join(verify, `report-${id}.json`) would read it.
  for (const id of hostile) {
    if (id.includes("\u0000")) continue
    const file = join(dir, "verify", `report-${id}.json`)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ status: "PASS", round: 9 }))
  }
  const t = buildTimeline(root, SESSION)
  assertShape(t)
  for (const id of hostile) {
    const task = taskOf(t, id)
    assert.strictEqual(task.passedAtRound, null, `task ${JSON.stringify(id)} must not read a report`)
    assert(task.note && task.note.includes("failed validation"), `task ${JSON.stringify(id)} must say why it was not read`)
  }
})

await check("R6.6 (containment): a symlinked verify/ directory is not followed for reports", () => {
  const root = makeRun({ events: null })
  const dir = runDirOf(root, SESSION)
  const outside = uniq("outside-verify")
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, "report-alpha.json"), JSON.stringify({ status: "PASS", round: 7 }))
  symlinkSync(outside, join(dir, "verify"))
  const t = buildTimeline(root, SESSION)
  assert.strictEqual(taskOf(t, "alpha").passedAtRound, null, "a report reached through a symlinked verify/ must be ignored")
})

await check("R6.6 (6): a task whose last event is non-terminal pins endedAt to its terminal event", () => {
  const extra = {
    ts: "2026-10-18T10:05:00.000Z", event: "task_transition", sessionId: SESSION, taskId: "alpha",
    from: "verified_pass", to: "worker_active", round: 3, agent: "team/worker", branch: "teamwork/tl-alpha", worktree: "/wt/alpha", phase: "DISPATCH",
  }
  const t = buildTimeline(makeRun({ events: [...EVENTS, extra] }), SESSION)
  const a = taskOf(t, "alpha")
  assert.strictEqual(a.endedAt, "2026-10-18T10:04:00.000Z", "endedAt must be the verified_pass event, not the trailing worker_active")
  assert.strictEqual(a.durationMs, 240000)
  assert.strictEqual(a.passedAtRound, 2)
  assert.strictEqual(t.endedAt, "2026-10-18T10:05:00.000Z", "the run-level end is still the final line")
})

// ==========================================
// 13. R6.6 — guardrails in the engine write path (real tools.ts)
// ==========================================

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" }
function gitInit(root) {
  execFileSync("git", ["init", "-q"], { cwd: root, env: GIT_ENV, stdio: "ignore" })
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init"], {
    cwd: root,
    env: GIT_ENV,
    stdio: "ignore",
  })
}

/** Register the real engine tools against `root` and return them by name. */
async function engineTools(root) {
  const tools = {}
  await registerTeamworkTools(
    {
      tool: {
        transform: async (cb) => {
          await cb({
            namespace: () => {},
            add: (tool) => {
              tools[tool.name] = tool
            },
          })
        },
      },
      session: { get: async () => undefined },
    },
    root,
  )
  return tools
}

/** A project root holding one engine-writable run (state with alpha pending, plan with alpha). */
function engineRun() {
  const root = makeRoot()
  const dir = runDirOf(root, SESSION)
  mkdirSync(dir, { recursive: true })
  writeJson(join(dir, "state.json"), { sessionId: SESSION, phase: "DISPATCH", tasks: { alpha: { status: "pending", round: 0 } } })
  writeJson(join(dir, "plan.dag.json"), { sessionId: SESSION, topology: "iterative-coding", tasks: [{ id: "alpha", dependsOn: [], maxRounds: 4, agent: "team/worker" }] })
  return { root, dir }
}

const readLines = (file) => readFileSync(file, "utf8").split("\n").filter((l) => l !== "")

await check("R6.6 control: task_update appends exactly one event to a plain events.jsonl", async () => {
  const { root, dir } = engineRun()
  const tools = await engineTools(root)
  const res = await tools.task_update.execute({ sessionId: SESSION, taskId: "alpha", status: "worker_active" })
  assert(res.content.includes("updated"), res.content)
  const lines = readLines(join(dir, "events.jsonl"))
  assert.strictEqual(lines.length, 1, "one event expected")
  assert.strictEqual(JSON.parse(lines[0]).to, "worker_active")
})

await check("R6.6 (1): a symlinked events.jsonl is refused; its target is not appended to", async () => {
  const { root, dir } = engineRun()
  const outside = uniq("outside-events") + ".jsonl"
  writeFileSync(outside, "CANARY\n")
  symlinkSync(outside, join(dir, "events.jsonl"))
  const tools = await engineTools(root)
  await tools.task_update.execute({ sessionId: SESSION, taskId: "alpha", status: "worker_active" })
  // Proof the call ran: state.json was written, so the append path was reached.
  assert.strictEqual(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).tasks.alpha.status, "worker_active")
  assert.strictEqual(readFileSync(outside, "utf8"), "CANARY\n", "the symlink target must not receive the event")
  assert(lstatSync(join(dir, "events.jsonl")).isSymbolicLink(), "the symlink is left in place")
})

await check("R6.6 (2): a DANGLING symlinked events.jsonl is refused; no target is created", async () => {
  const { root, dir } = engineRun()
  const target = uniq("dangling") + ".jsonl" // does not exist
  symlinkSync(target, join(dir, "events.jsonl"))
  const tools = await engineTools(root)
  await tools.task_update.execute({ sessionId: SESSION, taskId: "alpha", status: "worker_active" })
  assert.strictEqual(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).tasks.alpha.status, "worker_active")
  assert(!existsSync(target), "appending through a dangling symlink would create the target; it must not")
})

for (const where of ["outside", "inside"]) {
  await check(`R6.6 (3e): a symlinked .opencode/teamwork run root (target ${where} the project) is refused by the engine`, async () => {
    const root = makeRoot()
    const target = where === "outside" ? uniq("outside-engine-runs") : join(root, "elsewhere")
    const outDir = join(target, SESSION)
    mkdirSync(outDir, { recursive: true })
    writeJson(join(outDir, "state.json"), { sessionId: SESSION, phase: "DISPATCH", tasks: { alpha: { status: "pending", round: 0 } } })
    writeJson(join(outDir, "plan.dag.json"), { sessionId: SESSION, tasks: [{ id: "alpha", dependsOn: [], maxRounds: 4 }] })
    mkdirSync(join(root, ".opencode"), { recursive: true })
    symlinkSync(target, join(root, ".opencode", "teamwork"))
    const tools = await engineTools(root)
    const res = await tools.task_update.execute({ sessionId: SESSION, taskId: "alpha", status: "worker_active" })
    assert(/refused/.test(res.content), `must be refused, got: ${res.content}`)
    assert.strictEqual(JSON.parse(readFileSync(join(outDir, "state.json"), "utf8")).tasks.alpha.status, "pending", "nothing may be written through the link")
    assert(!existsSync(join(outDir, "events.jsonl")), "no event may be written through the link")
  })
}

await check("R6.6 (4): control chars and newlines in every appended field cannot inject a second JSONL line", async () => {
  const { root, dir } = engineRun()
  // Hostile values reach appendEvent raw from: input.branch, input.worktree (task_update),
  // state.phase and state.tasks.alpha.status (existing state), plan agent (plan.dag.json).
  const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"))
  state.phase = "DISPATCH\nFAKE\rX"
  state.tasks.alpha.status = "pending\u2028FAKE"
  writeJson(join(dir, "state.json"), state)
  const plan = JSON.parse(readFileSync(join(dir, "plan.dag.json"), "utf8"))
  plan.tasks[0].agent = 'team/worker\n{"event":"injected"}'
  writeJson(join(dir, "plan.dag.json"), plan)

  const tools = await engineTools(root)
  const res = await tools.task_update.execute({
    sessionId: SESSION,
    taskId: "alpha",
    status: "worker_active",
    branch: "teamwork/x\nINJECT",
    worktree: "/wt\r\nINJECT",
  })
  assert(res.content.includes("updated"), res.content)
  const raw = readFileSync(join(dir, "events.jsonl"), "utf8")
  assert.strictEqual(raw.split("\n").length, 2, `exactly one physical line expected, got ${JSON.stringify(raw)}`)
  assert(!/[\r\u2028\u2029]/.test(raw), "no CR or line separator may reach events.jsonl")
  const ev = JSON.parse(raw.trimEnd())
  assert.strictEqual(ev.event, "task_transition")
  assert.strictEqual(ev.branch, "teamwork/x INJECT")
  assert.strictEqual(ev.worktree, "/wt  INJECT")
  assert.strictEqual(ev.phase, "DISPATCH FAKE X")
  assert.strictEqual(ev.from, "pending FAKE")
  assert.strictEqual(ev.agent, 'team/worker {"event":"injected"}')
})

await check("R6.6 (4b): a hostile taskId writes no event and is not found", async () => {
  const { root, dir } = engineRun()
  const tools = await engineTools(root)
  const res = await tools.task_update.execute({ sessionId: SESSION, taskId: "alpha\nFAKE", status: "worker_active" })
  assert(/not found/.test(res.content), `hostile id must not match a task, got: ${res.content}`)
  assert(!existsSync(join(dir, "events.jsonl")), "no event may be written for it")
})

await check("R6.6 (7): a '..' task id is REFUSED by worktree setup and deletes nothing outside worktreesBase", async () => {
  const { root } = engineRun()
  gitInit(root)
  const wtBase = uniq("wt-base")
  mkdirSync(join(wtBase, SESSION), { recursive: true })
  writeFileSync(join(wtBase, "keep.txt"), "keep")
  writeFileSync(join(wtBase, SESSION, "keep.txt"), "keep")
  const sibling = uniq("sibling")
  mkdirSync(sibling, { recursive: true })
  writeFileSync(join(sibling, "keep.txt"), "keep")

  const saved = process.env.TEAMWORK_WORKTREES_DIR
  process.env.TEAMWORK_WORKTREES_DIR = wtBase
  try {
    const tools = await engineTools(root)
    // Control: a valid id really does create a worktree, so the harness is live.
    const ok = await tools.worktree.execute({ sessionId: SESSION, action: "setup", role: "worker", taskId: "alpha" })
    assert(ok.content.includes("worker worktree ready"), `control setup must succeed, got: ${ok.content}`)

    for (const bad of ["..", "../../" + basenameOf(sibling), "a/b", "/abs/x", "x".repeat(65)]) {
      const res = await tools.worktree.execute({ sessionId: SESSION, action: "setup", role: "worker", taskId: bad })
      assert(/refused/.test(res.content), `task id ${JSON.stringify(bad)} must be refused, got: ${res.content}`)
    }
    for (const kept of [join(wtBase, "keep.txt"), join(wtBase, SESSION, "keep.txt"), join(sibling, "keep.txt")]) {
      assert(existsSync(kept), `nothing outside the worktree may be deleted: ${kept} is gone`)
    }
  } finally {
    if (saved === undefined) delete process.env.TEAMWORK_WORKTREES_DIR
    else process.env.TEAMWORK_WORKTREES_DIR = saved
  }
})

function basenameOf(p) {
  return p.slice(p.lastIndexOf("/") + 1)
}

// ---------------------------------------------------------------- cleanup

rmSync(testDir, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
