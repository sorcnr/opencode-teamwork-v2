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

import { closeSync, existsSync, fstatSync, lstatSync, openSync, readdirSync, readSync, constants as fsConstants } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"

const SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/
// A task id is used as a path segment (verify/report-<id>.json), so it must be
// a single safe segment: no separators, no "..", no leading dot.
const TASK_ID = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/
const TERMINAL_EVENT_STATES = new Set(["verified_pass", "blocked"])
const PASS_STATES = new Set(["pass", "verified_pass"])
const FAIL_STATES = new Set(["fail", "verified_fail"])

// Upper bounds on bytes read from one run file. events.jsonl is capped at 8 MiB
// (it is only ever scanned line by line, and a truncated tail would give a
// wrong end time, so an oversize events file is reported, not partly read).
// The JSON files are read whole up to 64 MiB, so a legitimately large
// state.json still renders correctly. Beyond either cap the file is reported.
const MAX_EVENTS_BYTES = 8 * 1024 * 1024
const MAX_JSON_BYTES = 64 * 1024 * 1024

// Per-timeline diagnostics (oversize / unreadable run files), kept outside the
// returned object so the frozen buildTimeline shape is unchanged. Keyed by the
// timeline object; renderTimeline and timelineWarnings read it.
const DIAGNOSTICS = new WeakMap()

function mib(bytes) {
  const v = bytes / (1024 * 1024)
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

// Read a file only if it is a regular file (never follow a symlink) and it is
// no larger than maxBytes. Returns one of:
//   { status: "ok", text }            read in full
//   { status: "absent" }              does not exist
//   { status: "oversize", size, cap } exists but is larger than maxBytes
//   { status: "unreadable" }          exists but is not a readable regular file
// Oversize is never reported as absent. Never writes.
function readBounded(file, maxBytes) {
  let fd = null
  try {
    if (!lstatSync(file).isFile()) return { status: "unreadable" }
    fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    const st = fstatSync(fd)
    if (!st.isFile()) return { status: "unreadable" }
    if (st.size > maxBytes) return { status: "oversize", size: st.size, cap: maxBytes }
    // Read at most maxBytes+1 so a file that grows after fstat is still bounded.
    const cap = Math.min(st.size, maxBytes) + 1
    const buf = Buffer.alloc(cap)
    let total = 0
    while (total < cap) {
      const n = readSync(fd, buf, total, cap - total, null)
      if (n === 0) break
      total += n
    }
    if (total > maxBytes) return { status: "oversize", size: total, cap: maxBytes }
    return { status: "ok", text: buf.subarray(0, total).toString("utf8") }
  } catch (err) {
    return { status: err && err.code === "ENOENT" ? "absent" : "unreadable" }
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {}
    }
  }
}

function oversizeDiag(label, r) {
  return { file: label, kind: "oversize", message: `${label} exceeds the ${mib(r.cap)} MiB read cap (${mib(r.size)} MiB)` }
}

function unreadableDiag(label, why = "is not a regular file; it was not read") {
  return { file: label, kind: "unreadable", message: `${label} ${why}` }
}

// True when .opencode or .opencode/teamwork is a symlink: nothing under it may
// be read (the engine refuses the same layout).
function runRootIsLink(projectRoot) {
  for (const p of [join(projectRoot, ".opencode"), join(projectRoot, ".opencode", "teamwork")]) {
    try {
      if (lstatSync(p).isSymbolicLink()) return true
    } catch {}
  }
  return false
}

// Validate a task id and assert that the report path it names stays inside
// the run directory. Returns the report path, or null if the id is refused.
function isValidTaskId(taskId) {
  return typeof taskId === "string" && TASK_ID.test(taskId) && !taskId.includes("..")
}

function reportPathFor(runDir, taskId) {
  if (!isValidTaskId(taskId)) return null
  const file = join(runDir, "verify", `report-${taskId}.json`)
  const rel = relative(resolve(runDir), resolve(file))
  if (!rel || isAbsolute(rel) || rel.startsWith("..")) return null
  return file
}

// Read verify/report-<taskId>.json as a JSON record, or null. Refuses invalid
// ids and any path that would not stay inside runDir (including a symlinked
// verify/ directory). Never throws.
function readReport(runDir, taskId, diags) {
  const file = reportPathFor(runDir, taskId)
  if (file === null) return null
  try {
    if (!lstatSync(join(runDir, "verify")).isDirectory()) return null
  } catch {
    return null
  }
  // taskId passed reportPathFor, so it is a safe token to show in the label.
  return readJson(file, `verify/report-${taskId}.json`, diags)
}

// Read and parse one JSON run file. An absent file is silently null. An
// oversize or unreadable file is also null, but it records a diagnostic so the
// caller can show the reason instead of a confident "UNKNOWN"/"pending".
function readJson(file, label, diags) {
  const r = readBounded(file, MAX_JSON_BYTES)
  if (r.status === "oversize") {
    diags.push(oversizeDiag(label, r))
    return null
  }
  if (r.status === "unreadable") {
    diags.push(unreadableDiag(label))
    return null
  }
  if (r.status !== "ok") return null
  const text = r.text
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
  if (!existsSync(base) || runRootIsLink(projectRoot)) return []
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
function readEvents(runDir, diags) {
  const r = readBounded(join(runDir, "events.jsonl"), MAX_EVENTS_BYTES)
  if (r.status === "oversize") {
    diags.push(oversizeDiag("events.jsonl", r))
    return []
  }
  if (r.status === "unreadable") {
    diags.push(unreadableDiag("events.jsonl"))
    return []
  }
  if (r.status !== "ok") return []
  const text = r.text
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
        tokens: taskTokens(costs, taskId),
        note: joinNotes(
          "no events.jsonl entries for this task; start and duration unknown",
          isValidTaskId(taskId) ? null : invalidIdNote(taskId),
        ),
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
      tokens: taskTokens(costs, taskId),
      note: joinNotes(phaseNote(transitions), isValidTaskId(taskId) ? null : invalidIdNote(taskId)),
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

// Human-readable note for a task id that failed validation. The id is shown
// (truncated) so the operator can see it, but it is never used in a path.
function invalidIdNote(taskId) {
  const shown = String(taskId).slice(0, 80)
  return `task id "${shown}" failed validation; its verify report was not read`
}

function joinNotes(...parts) {
  const kept = parts.filter((p) => typeof p === "string" && p)
  return kept.length ? kept.join("; ") : null
}

function buildDerivedMode(state, plan, runDir, costs, diags) {
  const taskIds = orderedTaskIds(plan, state, [])
  const tasks = taskIds.map((taskId) => {
    const stateTask = isRecord(state.tasks?.[taskId]) ? state.tasks[taskId] : null
    const valid = isValidTaskId(taskId)
    const report = readReport(runDir, taskId, diags)
    const status = stringOrNull(stateTask?.status) ?? "pending"
    const reportPassed = report && typeof report.status === "string" && report.status.toUpperCase() === "PASS"
    const passedAtRound = status === "verified_pass" && reportPassed ? numberOrNull(report.round) : null
    const approxNote =
      "approximate: state.json keeps only the last updatedAt per task, so start time and duration are unknown; real durations require events.jsonl"
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
      tokens: taskTokens(costs, taskId),
      note: valid ? approxNote : `${approxNote}; ${invalidIdNote(taskId)}`,
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

// A finite, non-negative number, or null.
function nonNegativeOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
}

// Sanitise one per-task token bucket into a fresh, well-formed object, or null.
// Every numeric field must be present and finite and >= 0; any other shape
// (string, number, null, array, missing or non-object cache, NaN, negative)
// yields null. Only the known fields are copied, so no stray keys leak through.
function sanitizeTokenBucket(bucket) {
  if (!isRecord(bucket) || !isRecord(bucket.cache)) return null
  const input = nonNegativeOrNull(bucket.input)
  const output = nonNegativeOrNull(bucket.output)
  const reasoning = nonNegativeOrNull(bucket.reasoning)
  const read = nonNegativeOrNull(bucket.cache.read)
  const write = nonNegativeOrNull(bucket.cache.write)
  if (input === null || output === null || reasoning === null || read === null || write === null) return null
  return { input, output, reasoning, cache: { read, write } }
}

// Per-task token bucket from costs.byTaskTokens, or null when absent or malformed.
// Legacy costs.json files (no byTaskTokens) yield null.
function taskTokens(costs, taskId) {
  const buckets = isRecord(costs.byTaskTokens) ? costs.byTaskTokens : {}
  if (!Object.prototype.hasOwnProperty.call(buckets, taskId)) return null
  return sanitizeTokenBucket(buckets[taskId])
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
  const diags = []
  const timeline = buildRun(projectRoot, sessionId, diags)
  DIAGNOSTICS.set(timeline, diags)
  return timeline
}

/**
 * Human-readable warnings for a timeline built by buildTimeline: run files that
 * were too large or not regular files, and so were NOT read. Empty when every
 * file was either read or genuinely absent.
 * @returns {string[]}
 */
export function timelineWarnings(timeline) {
  const diags = timeline && typeof timeline === "object" ? DIAGNOSTICS.get(timeline) : undefined
  return diags ? diags.map((d) => d.message) : []
}

function buildRun(projectRoot, sessionId, diags) {
  if (typeof projectRoot !== "string") return emptyTimeline(typeof sessionId === "string" ? sessionId : null)

  let id = sessionId
  if (id === undefined || id === null) {
    id = listRunIds(projectRoot)[0] ?? null
  }
  if (typeof id !== "string" || !SESSION_ID.test(id)) return emptyTimeline(typeof id === "string" ? id : null)

  if (runRootIsLink(projectRoot)) {
    diags.push(unreadableDiag(".opencode/teamwork", "is a symlink; the run root was not read"))
    return emptyTimeline(id)
  }

  const runDir = join(projectRoot, ".opencode", "teamwork", id)
  let isDir = false
  try {
    isDir = lstatSync(runDir).isDirectory()
  } catch {}
  if (!isDir) return emptyTimeline(id)

  const state = readJson(join(runDir, "state.json"), "state.json", diags) || {}
  const plan = readJson(join(runDir, "plan.dag.json"), "plan.dag.json", diags) || {}
  const costs = readJson(join(runDir, "costs.json"), "costs.json", diags) || {}
  const events = readEvents(runDir, diags)

  const stateIds = isRecord(state.tasks) ? Object.keys(state.tasks) : []
  const planIds = Array.isArray(plan.tasks) ? plan.tasks.map((t) => (isRecord(t) ? t.id : undefined)) : []
  const knownIds = new Set([...stateIds, ...planIds.filter((x) => typeof x === "string")])

  const mode = events.length ? "events" : "derived"
  const body = events.length
    ? buildEventsMode(events, state, plan, costs)
    : buildDerivedMode(state, plan, runDir, costs, diags)
  // events.jsonl exists but was not read: every task says why its timing is unknown.
  const eventsDiag = diags.find((d) => d.file === "events.jsonl")
  if (mode === "derived" && eventsDiag) {
    for (const task of body.tasks) task.note = joinNotes(task.note, `${eventsDiag.message}; timing unavailable`)
  }

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
// C0 and C1 control characters (includes ESC, BEL, CR, LF, TAB, DEL). Data
// from state.json / events.jsonl can carry these; they must never reach the
// terminal, whether or not colour is enabled.
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g

// Return a copy of value with every string stripped of control characters.
// Keys, numbers, booleans and null are kept as they are, so the shape is the same.
function stripControls(value) {
  if (typeof value === "string") return value.replace(CONTROL_CHARS, "")
  if (Array.isArray(value)) return value.map(stripControls)
  if (isRecord(value)) {
    const out = {}
    for (const key of Object.keys(value)) out[key.replace(CONTROL_CHARS, "")] = stripControls(value[key])
    return out
  }
  return value
}

export function renderTimeline(timeline, options = {}) {
  const color = options && options.color === true
  const t = stripControls(timeline || emptyTimeline())
  const diags = (timeline && typeof timeline === "object" && DIAGNOSTICS.get(timeline)) || []
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
    // Say WHY there is no timing. An unread events.jsonl must never be reported as absent.
    const eventsDiag = diags.find((d) => d.file === "events.jsonl")
    const reason = eventsDiag
      ? `${eventsDiag.message}; timing unavailable`
      : diags.length
        ? "some run files were not read, see warnings below"
        : "no events.jsonl"
    lines.push(p("33", `  wall-clock: unknown (derived mode: ${stripControls(reason)}; last update ${t.endedAt ?? "unknown"})`))
  }
  for (const d of diags) {
    if (d.file === "events.jsonl") continue // already shown in the wall-clock line
    lines.push(p("33", `  ! ${stripControls(d.message)}`))
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
    const taskTokenText = task.tokens ? `in=${task.tokens.input} out=${task.tokens.output}` : "n/a"
    lines.push(`    cost: ${fmtUsd(task.costUsd)}  tokens: ${taskTokenText}`)
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
