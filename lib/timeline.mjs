// lib/timeline.mjs — Teamwork run lifecycle timeline (READ-ONLY)
//
// buildTimeline(projectRoot, sessionId?) reads a run directory and returns a
// structured timeline. When events.jsonl exists and yields at least one
// parseable event the timeline is exact ("events" mode). Otherwise it falls
// back to "derived" mode, which never invents a start time or a duration.
//
// renderTimeline(timeline, { color }) turns that object into printable lines.
//
// Zero runtime dependencies. Node >= 18. No writes, no mkdir, no rm, no
// process access, no clock reads: the output is a pure function of the files.

import { existsSync, readdirSync, readFileSync, lstatSync } from "node:fs"
import { join } from "node:path"

const SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/
const TERMINAL_EVENT_STATES = new Set(["verified_pass", "blocked"])
const PASS_STATES = new Set(["pass", "verified_pass"])
const FAIL_STATES = new Set(["fail", "verified_fail"])

// Read a file only if it is a regular file (never follow a symlink).
// Returns null on any problem: missing, symlinked, unreadable.
function safeRead(file) {
  try {
    const st = lstatSync(file)
    if (!st.isFile()) return null
    return readFileSync(file, "utf8")
  } catch {
    return null
  }
}

function readJson(file) {
  const text = safeRead(file)
  if (text === null) return null
  try {
    const value = JSON.parse(text)
    return value && typeof value === "object" && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function stringOrNull(value) {
  return typeof value === "string" ? value : null
}

function parseTs(value) {
  if (typeof value !== "string") return NaN
  return Date.parse(value)
}

function emptyTimeline(sessionId = null) {
  return {
    sessionId,
    topology: "unknown",
    phase: "UNKNOWN",
    mode: "derived",
    budgetUsd: null,
    budgetSource: null,
    spentUsd: 0,
    startedAt: null,
    endedAt: null,
    durationMs: 0,
    tasks: [],
    unattributed: [],
    totals: { tasks: 0, passed: 0, failed: 0, blocked: 0, totalRounds: 0, spentUsd: 0, tokens: null },
  }
}

// Mirrors listTeamworkRuns() ordering: newest run directory first (mtime desc).
// Symlinked run directories are skipped so that nothing outside the
// .opencode/teamwork tree is ever read through this module.
function listRunIds(projectRoot) {
  const base = join(projectRoot, ".opencode", "teamwork")
  if (!existsSync(base)) return []
  let names
  try {
    names = readdirSync(base)
  } catch {
    return []
  }
  const runs = []
  for (const name of names) {
    if (!SESSION_ID.test(name)) continue
    try {
      const st = lstatSync(join(base, name))
      if (!st.isDirectory()) continue
      runs.push({ name, mtime: st.mtimeMs })
    } catch {}
  }
  runs.sort((a, b) => b.mtime - a.mtime)
  return runs.map((r) => r.name)
}

// Parse events.jsonl, skipping anything that is not a usable event object.
function readEvents(runDir) {
  const text = safeRead(join(runDir, "events.jsonl"))
  if (text === null) return []
  const events = []
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let obj
    try {
      obj = JSON.parse(trimmed)
    } catch {
      continue // truncated / corrupt line (e.g. partial write at kill)
    }
    if (!isRecord(obj) || typeof obj.event !== "string" || Number.isNaN(parseTs(obj.ts))) continue
    events.push({
      ts: obj.ts,
      tsMs: parseTs(obj.ts),
      event: obj.event,
      taskId: stringOrNull(obj.taskId),
      to: stringOrNull(obj.to),
      round: numberOrNull(obj.round),
      agent: stringOrNull(obj.agent),
      branch: stringOrNull(obj.branch),
    })
  }
  return events
}

// Per-phase time for one task: time spent in each state, summed over rounds.
// Only states that were left (have a following transition) are reported.
function phaseNote(transitions) {
  const order = []
  const sums = new Map()
  for (let i = 0; i + 1 < transitions.length; i++) {
    const state = transitions[i].to
    if (typeof state !== "string") continue
    const span = transitions[i + 1].tsMs - transitions[i].tsMs
    if (!sums.has(state)) {
      sums.set(state, 0)
      order.push(state)
    }
    sums.set(state, sums.get(state) + span)
  }
  if (!order.length) return null
  return "phases: " + order.map((s) => `${s} ${sums.get(s)}ms`).join(" · ")
}

function buildEventsMode(events, state, plan, costs) {
  const first = events[0]
  const last = events[events.length - 1]
  const runStart = first.ts
  const runEnd = last.ts
  const runDuration = parseTs(runEnd) - parseTs(runStart)

  // Group task transitions by task, in file (append) order.
  const byTask = new Map()
  for (const ev of events) {
    if (ev.event !== "task_transition" || ev.taskId === null) continue
    if (!byTask.has(ev.taskId)) byTask.set(ev.taskId, [])
    byTask.get(ev.taskId).push(ev)
  }

  const taskIds = orderedTaskIds(plan, state, [...byTask.keys()])
  const tasks = taskIds.map((taskId) => {
    const stateTask = isRecord(state.tasks?.[taskId]) ? state.tasks[taskId] : null
    const transitions = byTask.get(taskId) || []
    const stateStatus = stringOrNull(stateTask?.status)
    const branchFromState = stringOrNull(stateTask?.branch)

    if (!transitions.length) {
      // Known to state.json / plan but no events recorded: unknown timing.
      return {
        taskId,
        status: stateStatus ?? "pending",
        rounds: numberOrNull(stateTask?.round) ?? 0,
        passedAtRound: null,
        agent: null,
        branch: branchFromState,
        startedAt: null,
        endedAt: stringOrNull(stateTask?.updatedAt),
        durationMs: null,
        approx: true,
        costUsd: taskCost(costs, taskId),
        tokens: null,
        note: "no events.jsonl entries for this task; start and duration unknown",
      }
    }

    const startedAt = transitions[0].ts
    let endIdx = -1
    let passIdx = -1
    for (let i = 0; i < transitions.length; i++) {
      const to = transitions[i].to
      if (TERMINAL_EVENT_STATES.has(to)) endIdx = i
      if (to === "verified_pass") passIdx = i
    }
    const endEvent = endIdx >= 0 ? transitions[endIdx] : transitions[transitions.length - 1]
    const endedAt = endEvent.ts
    const durationMs = parseTs(endedAt) - parseTs(startedAt)

    let rounds = 0
    let agent = null
    let workerAgent = null
    let branch = null
    for (const t of transitions) {
      if (t.round !== null && t.round > rounds) rounds = t.round
      if (t.agent !== null) agent = t.agent
      if (t.to === "worker_active" && t.agent !== null) workerAgent = t.agent
      if (t.branch !== null) branch = t.branch
    }
    // Prefer the worker agent (the one that ran the task); fall back to the last seen.
    agent = workerAgent ?? agent

    const lastTo = transitions[transitions.length - 1].to
    return {
      taskId,
      status: stateStatus ?? lastTo ?? "pending",
      rounds,
      passedAtRound: passIdx >= 0 ? transitions[passIdx].round : null,
      agent,
      branch: branchFromState ?? branch,
      startedAt,
      endedAt,
      durationMs,
      approx: false,
      costUsd: taskCost(costs, taskId),
      tokens: null,
      note: phaseNote(transitions),
    }
  })

  return {
    mode: "events",
    startedAt: runStart,
    endedAt: runEnd,
    durationMs: runDuration,
    tasks,
  }
}

function buildDerivedMode(state, plan, runDir, costs) {
  const taskIds = orderedTaskIds(plan, state, [])
  const tasks = taskIds.map((taskId) => {
    const stateTask = isRecord(state.tasks?.[taskId]) ? state.tasks[taskId] : null
    const report = readJson(join(runDir, "verify", `report-${taskId}.json`))
    const status = stringOrNull(stateTask?.status) ?? "pending"
    const reportPassed = report && typeof report.status === "string" && report.status.toUpperCase() === "PASS"
    const passedAtRound = status === "verified_pass" && reportPassed ? numberOrNull(report.round) : null
    return {
      taskId,
      status,
      rounds: numberOrNull(stateTask?.round) ?? 0,
      passedAtRound,
      agent: null,
      branch: stringOrNull(stateTask?.branch),
      startedAt: null,
      endedAt: stringOrNull(stateTask?.updatedAt),
      durationMs: 0,
      approx: true,
      costUsd: taskCost(costs, taskId),
      tokens: null,
      note:
        "approximate: state.json keeps only the last updatedAt per task, so start time and duration are unknown; real durations require events.jsonl",
    }
  })
  return {
    mode: "derived",
    startedAt: null,
    endedAt: stringOrNull(state.updatedAt),
    durationMs: 0,
    tasks,
  }
}

// Task ids in plan order, then state order, then any extra ids seen in events.
function orderedTaskIds(plan, state, extra) {
  const seen = new Set()
  const ids = []
  const add = (id) => {
    if (typeof id !== "string" || !id || seen.has(id)) return
    seen.add(id)
    ids.push(id)
  }
  if (Array.isArray(plan.tasks)) for (const t of plan.tasks) add(isRecord(t) ? t.id : undefined)
  if (isRecord(state.tasks)) for (const id of Object.keys(state.tasks)) add(id)
  for (const id of extra) add(id)
  return ids
}

function taskCost(costs, taskId) {
  const buckets = isRecord(costs.byTask) ? costs.byTask : {}
  if (!Object.prototype.hasOwnProperty.call(buckets, taskId)) return null
  return numberOrNull(buckets[taskId])
}

// Build the unattributed list. A bucket is a task only when it names a known
// task id and is not an internal/agent bucket. Everything else is listed here.
function buildUnattributed(costs, taskIdSet) {
  const buckets = isRecord(costs.byTask) ? costs.byTask : {}
  const out = []
  for (const key of Object.keys(buckets)) {
    const isInternal = key.startsWith("_") || key.includes("/")
    if (!isInternal && taskIdSet.has(key)) continue
    const usd = numberOrNull(buckets[key])
    out.push({ bucket: key, costUsd: usd ?? 0 })
  }
  return out
}

/**
 * Build a lifecycle timeline for one Teamwork run.
 * @param {string} projectRoot  Project root containing .opencode/teamwork/
 * @param {string} [sessionId]  Run id; defaults to the most recent run.
 */
export function buildTimeline(projectRoot, sessionId) {
  if (typeof projectRoot !== "string") return emptyTimeline(typeof sessionId === "string" ? sessionId : null)

  let id = sessionId
  if (id === undefined || id === null) {
    id = listRunIds(projectRoot)[0] ?? null
  }
  if (typeof id !== "string" || !SESSION_ID.test(id)) return emptyTimeline(typeof id === "string" ? id : null)

  const runDir = join(projectRoot, ".opencode", "teamwork", id)
  let isDir = false
  try {
    isDir = lstatSync(runDir).isDirectory()
  } catch {}
  if (!isDir) return emptyTimeline(id)

  const state = readJson(join(runDir, "state.json")) || {}
  const plan = readJson(join(runDir, "plan.dag.json")) || {}
  const costs = readJson(join(runDir, "costs.json")) || {}
  const events = readEvents(runDir)

  const stateIds = isRecord(state.tasks) ? Object.keys(state.tasks) : []
  const planIds = Array.isArray(plan.tasks) ? plan.tasks.map((t) => (isRecord(t) ? t.id : undefined)) : []
  const knownIds = new Set([...stateIds, ...planIds.filter((x) => typeof x === "string")])

  const mode = events.length ? "events" : "derived"
  const body = events.length
    ? buildEventsMode(events, state, plan, costs)
    : buildDerivedMode(state, plan, runDir, costs)

  // Event-only task ids are already in body.tasks; include them when deciding
  // which cost buckets are tasks.
  const taskIdSet = new Set([...knownIds, ...body.tasks.map((t) => t.taskId)])
  const unattributed = buildUnattributed(costs, taskIdSet)

  const tokens = isRecord(costs.tokens) ? costs.tokens : null
  const spentUsd = numberOrNull(costs.spentUsd) ?? 0
  const tasks = body.tasks
  const totals = {
    tasks: tasks.length,
    passed: tasks.filter((t) => PASS_STATES.has(t.status)).length,
    failed: tasks.filter((t) => FAIL_STATES.has(t.status)).length,
    blocked: tasks.filter((t) => t.status === "blocked").length,
    totalRounds: tasks.reduce((sum, t) => sum + (t.rounds || 0), 0),
    spentUsd,
    tokens,
  }

  return {
    sessionId: stringOrNull(state.sessionId) ?? id,
    topology: stringOrNull(plan.topology) ?? "unknown",
    phase: stringOrNull(state.phase) ?? "UNKNOWN",
    mode,
    budgetUsd: numberOrNull(costs.budgetUsd),
    budgetSource: stringOrNull(costs.budgetSource),
    spentUsd,
    startedAt: body.startedAt,
    endedAt: body.endedAt,
    durationMs: body.durationMs,
    tasks,
    unattributed,
    totals,
  }
}

// ---------------------------------------------------------------- rendering

function paint(enabled, code, text) {
  return enabled ? `\x1b[${code}m${text}\x1b[0m` : text
}

function fmtDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "unknown"
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const rem = Math.round(seconds - minutes * 60)
  return `${minutes}m ${String(rem).padStart(2, "0")}s`
}

function fmtUsd(value) {
  return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(4)}` : "n/a"
}

function statusColor(status) {
  if (PASS_STATES.has(status)) return "32" // green
  if (FAIL_STATES.has(status) || status === "blocked") return "31" // red
  if (status === "worker_active" || status === "worker_done") return "36" // cyan
  if (status === "verifier_active") return "35" // magenta
  return "33" // yellow for anything else (pending/unknown)
}

/**
 * Render a timeline (from buildTimeline) as printable lines.
 * Pure: no I/O, no clock. ANSI escapes only when color === true.
 * @returns {string[]}
 */
export function renderTimeline(timeline, options = {}) {
  const color = options && options.color === true
  const t = timeline || emptyTimeline()
  const p = (code, text) => paint(color, code, text)
  const lines = []
  const approxTag = t.mode === "derived" ? p("33", " [APPROX]") : ""

  lines.push(p("1", `Teamwork timeline — ${t.sessionId ?? "unknown"}`))
  lines.push(`  topology: ${t.topology ?? "unknown"}  phase: ${t.phase ?? "UNKNOWN"}  mode: ${t.mode}${approxTag}`)
  const budget = typeof t.budgetUsd === "number" ? `$${t.budgetUsd}` : "n/a"
  const source = t.budgetSource ? ` (${t.budgetSource})` : ""
  lines.push(`  budget: ${budget}${source}  spent: ${fmtUsd(t.spentUsd)}`)
  if (t.mode === "events") {
    lines.push(`  started: ${t.startedAt ?? "unknown"}  ended: ${t.endedAt ?? "unknown"}  wall-clock: ${fmtDuration(t.durationMs)}`)
  } else {
    lines.push(p("33", `  wall-clock: unknown (derived mode: no events.jsonl; last update ${t.endedAt ?? "unknown"})`))
  }
  lines.push("")

  const tasks = Array.isArray(t.tasks) ? t.tasks : []
  if (!tasks.length) lines.push("  (no tasks recorded)")

  for (const task of tasks) {
    const sc = statusColor(task.status)
    const icon = PASS_STATES.has(task.status) ? "✓" : FAIL_STATES.has(task.status) || task.status === "blocked" ? "✗" : "•"
    const passRound = task.passedAtRound != null ? `pass@round ${task.passedAtRound}` : "no pass"
    lines.push(`${p(sc, `${icon} ${task.taskId}`)}  ${p(sc, task.status ?? "unknown")}  rounds: ${task.rounds ?? 0}  ${passRound}`)
    lines.push(`    worker: ${task.agent ?? "unknown"}  branch: ${task.branch ?? "n/a"}`)
    if (task.approx) {
      lines.push(p("33", `    ~ approx  start: ${task.startedAt ?? "unknown"}  end: ${task.endedAt ?? "unknown"}  duration: unknown`))
    } else {
      lines.push(`    start: ${p("2", task.startedAt ?? "unknown")}  end: ${p("2", task.endedAt ?? "unknown")}  duration: ${fmtDuration(task.durationMs)}`)
    }
    lines.push(`    cost: ${fmtUsd(task.costUsd)}  tokens: ${task.tokens ? "per-task n/a" : "n/a"}`)
    if (task.note) lines.push(p(task.approx ? "33" : "2", `    note: ${task.note}`))
  }

  lines.push("")
  const un = Array.isArray(t.unattributed) ? t.unattributed : []
  if (un.length) {
    lines.push("  unattributed cost:")
    for (const u of un) lines.push(`    ${u.bucket}: ${fmtUsd(u.costUsd)}`)
  }

  const totals = t.totals || {}
  const tokenLine = totals.tokens
    ? `tokens in=${totals.tokens.input ?? "?"} out=${totals.tokens.output ?? "?"}`
    : "tokens n/a"
  lines.push(
    `  totals: ${totals.tasks ?? 0} tasks · ${p("32", `${totals.passed ?? 0} passed`)} · ${p("31", `${totals.failed ?? 0} failed`)} · ${p("31", `${totals.blocked ?? 0} blocked`)} · ${totals.totalRounds ?? 0} rounds · ${fmtUsd(totals.spentUsd)} · ${tokenLine}`,
  )
  return lines
}
