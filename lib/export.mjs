// lib/export.mjs — Teamwork run report export (READ-ONLY)
//
// buildExportData(projectRoot, sessionId) reads one run directory and returns a
// plain data object. It never throws: an invalid or missing run yields an object
// whose `error` field is a string.
//
// renderExport(data, { format }) is a pure function of its input. format is
// "markdown" for GitHub-flavoured Markdown; anything else (including undefined)
// renders the single-file offline HTML document.
//
// Zero runtime dependencies. Node >= 18. No writes, no network, no scripts in
// the output, no clock reads.

import { closeSync, fstatSync, lstatSync, openSync, readSync, constants as fsConstants } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"

const SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/
// A task id becomes a path segment (verify/report-<id>.json): one safe segment only.
const TASK_ID = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/
const CTRL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g
const SEVERITIES = ["critical", "high", "medium", "low"]

const MAX_EVENTS_BYTES = 8 * 1024 * 1024
const MAX_JSON_BYTES = 16 * 1024 * 1024
const MAX_PITFALLS_BYTES = 1 * 1024 * 1024
const MAX_TASKS = 500
const MAX_FINDINGS = 200
const MAX_PITFALLS = 500
const MAX_FATAL = 50
const MAX_TEXT = 4000
const MAX_SHORT = 300
const MAX_PITFALL = 500

const HTML_ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }

// ------------------------------------------------------------ small helpers

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

// Own-property read: never reaches Object.prototype (e.g. a task id "constructor").
function own(obj, key) {
  return isRecord(obj) && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function nonNegInt(value) {
  const n = numberOrNull(value)
  return n !== null && n >= 0 ? Math.floor(n) : 0
}

// Printable text: control characters become spaces, trimmed, capped in length.
// Returns null for values that are not strings or finite numbers.
function txt(value, max = MAX_TEXT) {
  let s
  if (typeof value === "string") s = value
  else if (typeof value === "number" && Number.isFinite(value)) s = String(value)
  else if (typeof value === "boolean") s = String(value)
  else return null
  s = s.replace(CTRL, " ").trim()
  if (s.length > max) s = s.slice(0, max) + "…"
  return s
}

// Non-empty text or null.
function strOrNull(value, max = MAX_TEXT) {
  if (typeof value !== "string") return null
  const s = txt(value, max)
  return s ? s : null
}

function isValidTaskId(taskId) {
  return typeof taskId === "string" && TASK_ID.test(taskId) && !taskId.includes("..")
}

// Defang absolute URLs in text. The HTML output must contain no http(s) URL at
// all, even when a summary or a pitfall quotes one. "https://" becomes "https[://]".
function defang(s) {
  return s.replace(/https?:\/\//gi, (m) => m.replace("://", "[://]"))
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ESC[c])
}

// Escaped HTML text for any dynamic value. Never returns raw user text.
function h(value, fallback = "—", max = MAX_TEXT) {
  const s = txt(value, max)
  return escapeHtml(s ? defang(s) : fallback)
}

// Escaped GFM text for table cells and list items. Backslash-escapes the
// characters that would otherwise start Markdown markup or HTML.
function md(value, fallback = "—", max = MAX_TEXT) {
  const s = txt(value, max)
  if (!s) return fallback
  return s.replace(/[\\`*_[\]<>|~!&]/g, "\\$&")
}

function int(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a"
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

function fmtUsd(value) {
  return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(4)}` : "n/a"
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

function parseTs(value) {
  if (typeof value !== "string") return NaN
  return Date.parse(value)
}

function mib(bytes) {
  const v = bytes / (1024 * 1024)
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

// ------------------------------------------------------------ bounded reads

// Read a file only if it is a regular file (never follow a symlink) and it is
// no larger than maxBytes. Returns { status: ok|absent|oversize|unreadable }.
function readBounded(file, maxBytes) {
  let fd = null
  try {
    if (!lstatSync(file).isFile()) return { status: "unreadable" }
    fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    const st = fstatSync(fd)
    if (!st.isFile()) return { status: "unreadable" }
    if (st.size > maxBytes) return { status: "oversize", size: st.size, cap: maxBytes }
    // Read at most maxBytes+1 so a file that grows after fstat stays bounded.
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

function isRealDir(p) {
  try {
    return lstatSync(p).isDirectory()
  } catch {
    return false
  }
}

// True when .opencode or .opencode/teamwork is a symlink: nothing under it may be read.
function runRootIsLink(projectRoot) {
  for (const p of [join(projectRoot, ".opencode"), join(projectRoot, ".opencode", "teamwork")]) {
    try {
      if (lstatSync(p).isSymbolicLink()) return true
    } catch {}
  }
  return false
}

function oversizeDiag(label, r) {
  return { file: label, message: `${label} exceeds the ${mib(r.cap)} MiB read cap (${mib(r.size)} MiB); it was not read` }
}

function unreadableDiag(label, why = "is not a regular file; it was not read") {
  return { file: label, message: `${label} ${why}` }
}

// Read and parse one JSON object. Absent is silent. Oversize, unreadable or
// malformed files return null and record a warning.
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
  try {
    const value = JSON.parse(r.text)
    if (isRecord(value)) return value
  } catch {}
  diags.push({ file: label, message: `${label} is not a JSON object; it was ignored` })
  return null
}

// A verify/report-<taskId>.json read. Refuses invalid ids, a symlinked or absent
// verify/ directory, and any path that would not stay inside the run directory.
function reportFor(runDir, taskId, verifyOk, diags) {
  if (!verifyOk || !isValidTaskId(taskId)) return null
  const file = join(runDir, "verify", `report-${taskId}.json`)
  const rel = relative(resolve(runDir), resolve(file))
  if (!rel || isAbsolute(rel) || rel.startsWith("..")) return null
  return readJson(file, `verify/report-${taskId}.json`, diags)
}

function readPitfalls(runDir, diags) {
  const r = readBounded(join(runDir, "pitfalls.md"), MAX_PITFALLS_BYTES)
  if (r.status === "oversize") {
    diags.push(oversizeDiag("pitfalls.md", r))
    return []
  }
  if (r.status === "unreadable") {
    diags.push(unreadableDiag("pitfalls.md"))
    return []
  }
  if (r.status !== "ok") return []
  const out = []
  for (const line of r.text.split(/\r?\n/)) {
    const trimmed = line.trimStart()
    if (!trimmed.startsWith("- ")) continue
    const entry = strOrNull(trimmed.slice(2), MAX_PITFALL)
    if (entry) out.push(entry)
    if (out.length >= MAX_PITFALLS) break
  }
  return out
}

// Parse events.jsonl; skip lines that are not usable event objects.
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
  const events = []
  for (const line of r.text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let obj
    try {
      obj = JSON.parse(trimmed)
    } catch {
      continue // truncated or corrupt line
    }
    if (!isRecord(obj) || typeof obj.event !== "string" || Number.isNaN(parseTs(obj.ts))) continue
    events.push({
      ts: obj.ts,
      tsMs: parseTs(obj.ts),
      event: obj.event,
      taskId: typeof obj.taskId === "string" ? obj.taskId : null,
      to: typeof obj.to === "string" ? obj.to : null,
      round: numberOrNull(obj.round),
      agent: typeof obj.agent === "string" ? obj.agent : null,
      branch: typeof obj.branch === "string" ? obj.branch : null,
      worktree: typeof obj.worktree === "string" ? obj.worktree : null,
    })
  }
  return events
}

// A finite, non-negative token bucket, or null. Only known fields are copied.
function sanitizeTokenBucket(bucket) {
  if (!isRecord(bucket) || !isRecord(bucket.cache)) return null
  const vals = [bucket.input, bucket.output, bucket.reasoning, bucket.cache.read, bucket.cache.write].map((v) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null,
  )
  if (vals.some((v) => v === null)) return null
  const [input, output, reasoning, read, write] = vals
  return { input, output, reasoning, cache: { read, write } }
}

function normStatus(value) {
  if (typeof value !== "string") return null
  const v = value.trim().toUpperCase()
  return v === "PASS" || v === "FAIL" ? v : null
}

// ------------------------------------------------------------ data model

function errorData(sessionId, error, diags = []) {
  return {
    error,
    sessionId,
    topology: "unknown",
    phase: "UNKNOWN",
    status: "INCOMPLETE",
    timing: "unknown",
    startedAt: null,
    endedAt: null,
    durationMs: null,
    budgetUsd: null,
    budgetSource: null,
    spentUsd: 0,
    tokens: null,
    tasks: [],
    totals: { tasks: 0, passed: 0, failed: 0, blocked: 0, pending: 0, rounds: 0 },
    unattributed: [],
    security: null,
    finalReport: null,
    pitfalls: [],
    warnings: diags.map((d) => d.message),
  }
}

/**
 * Build the export data for one Teamwork run. Never throws.
 * @param {string} projectRoot  Project root containing .opencode/teamwork/
 * @param {string} sessionId    Run id (validated against the session allowlist)
 */
export function buildExportData(projectRoot, sessionId) {
  const id = typeof sessionId === "string" && SESSION_ID.test(sessionId) ? sessionId : null
  try {
    if (typeof projectRoot !== "string" || !projectRoot) return errorData(null, "projectRoot must be a non-empty string")
    if (id === null) {
      return errorData(null, "invalid session id: must match ^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$")
    }
    return buildRun(projectRoot, id)
  } catch {
    return errorData(id, "unexpected error while reading the run; nothing was exported")
  }
}

function buildRun(projectRoot, id) {
  const diags = []
  if (runRootIsLink(projectRoot)) {
    return errorData(id, ".opencode/teamwork is a symlink; nothing was read")
  }
  const runDir = join(projectRoot, ".opencode", "teamwork", id)
  if (!isRealDir(runDir)) return errorData(id, `no Teamwork run "${id}" under .opencode/teamwork`)

  const plan = readJson(join(runDir, "plan.dag.json"), "plan.dag.json", diags)
  const state = readJson(join(runDir, "state.json"), "state.json", diags)
  if (!plan || !state) {
    return errorData(id, "plan.dag.json and state.json are required; one is missing or not a JSON object", diags)
  }
  const costs = readJson(join(runDir, "costs.json"), "costs.json", diags) || {}
  const events = readEvents(runDir, diags)

  const verifyDir = join(runDir, "verify")
  const verifyOk = isRealDir(verifyDir)
  if (!verifyOk) {
    try {
      if (lstatSync(verifyDir).isSymbolicLink()) diags.push(unreadableDiag("verify/", "is a symlink; verify reports were not read"))
    } catch {}
  }
  const audit = verifyOk ? readJson(join(verifyDir, "security-audit.json"), "verify/security-audit.json", diags) : null
  const final = verifyOk ? readJson(join(verifyDir, "final.json"), "verify/final.json", diags) : null
  const pitfalls = readPitfalls(runDir, diags)

  // ---- run-level timing: events when present, otherwise unknown
  let startedAt = null
  let endedAt = strOrNull(state.updatedAt, 80)
  let durationMs = null
  let timing = "unknown"
  if (events.length) {
    startedAt = events[0].ts
    endedAt = events[events.length - 1].ts
    durationMs = events[events.length - 1].tsMs - events[0].tsMs
    timing = "events"
  }

  // ---- task ids: plan order, then state order, then event-only ids
  const planTasks = Array.isArray(plan.tasks) ? plan.tasks.filter(isRecord) : []
  const planById = new Map()
  for (const t of planTasks) if (typeof t.id === "string" && !planById.has(t.id)) planById.set(t.id, t)
  const stateTasks = isRecord(state.tasks) ? state.tasks : {}
  const eventsByTask = new Map()
  for (const ev of events) {
    if (ev.event !== "task_transition" || ev.taskId === null) continue
    if (!eventsByTask.has(ev.taskId)) eventsByTask.set(ev.taskId, [])
    eventsByTask.get(ev.taskId).push(ev)
  }
  const idSet = new Set()
  const taskIds = []
  const addId = (x) => {
    if (typeof x !== "string" || !x || idSet.has(x)) return
    idSet.add(x)
    taskIds.push(x)
  }
  for (const t of planTasks) addId(t.id)
  for (const k of Object.keys(stateTasks)) addId(k)
  for (const k of eventsByTask.keys()) addId(k)

  const tasks = taskIds.slice(0, MAX_TASKS).map((taskId) =>
    buildTask(taskId, {
      runDir,
      verifyOk,
      diags,
      costs,
      stateTask: own(stateTasks, taskId),
      planTask: planById.get(taskId) ?? null,
      transitions: eventsByTask.get(taskId) || [],
    }),
  )
  if (taskIds.length > MAX_TASKS) diags.push({ file: "state.json", message: `only the first ${MAX_TASKS} tasks were exported` })

  // ---- cost buckets that are not tasks
  const byTask = isRecord(costs.byTask) ? costs.byTask : {}
  const unattributed = []
  for (const key of Object.keys(byTask)) {
    if (idSet.has(key) && isValidTaskId(key)) continue
    unattributed.push({ bucket: strOrNull(key, 80) ?? "—", costUsd: numberOrNull(byTask[key]) ?? 0 })
  }

  const security = buildSecurity(audit)
  const finalReport = buildFinal(final)
  const status = overallStatus(tasks, security, finalReport)

  const totals = {
    tasks: tasks.length,
    passed: tasks.filter((t) => t.status === "verified_pass").length,
    failed: tasks.filter((t) => t.status === "verified_fail").length,
    blocked: tasks.filter((t) => t.status === "blocked").length,
    pending: 0,
    rounds: tasks.reduce((sum, t) => sum + (t.rounds || 0), 0),
  }
  totals.pending = totals.tasks - totals.passed - totals.failed - totals.blocked

  return {
    error: null,
    sessionId: id,
    topology: strOrNull(plan.topology, MAX_SHORT) ?? "unknown",
    phase: strOrNull(state.phase, MAX_SHORT) ?? "UNKNOWN",
    status,
    timing,
    startedAt,
    endedAt,
    durationMs,
    budgetUsd: numberOrNull(costs.budgetUsd),
    budgetSource: strOrNull(costs.budgetSource, MAX_SHORT),
    spentUsd: numberOrNull(costs.spentUsd) ?? 0,
    tokens: sanitizeTokenBucket(costs.tokens),
    tasks,
    totals,
    unattributed,
    security,
    finalReport,
    pitfalls,
    warnings: diags.map((d) => d.message),
  }
}

function buildTask(taskId, ctx) {
  const { runDir, verifyOk, diags, costs, stateTask, planTask, transitions } = ctx
  const valid = isValidTaskId(taskId)
  const report = reportFor(runDir, taskId, verifyOk, diags)

  // Event-derived timing and identities.
  let ev = null
  if (transitions.length) {
    const startIdx = 0
    let endIdx = transitions.length - 1
    for (let i = 0; i < transitions.length; i++) {
      if (transitions[i].to === "verified_pass" || transitions[i].to === "blocked") endIdx = i
    }
    let rounds = 0
    let workerAgent = null
    let verifierAgent = null
    let branch = null
    let worktree = null
    for (const t of transitions) {
      if (t.round !== null && t.round > rounds) rounds = t.round
      if (t.agent && (t.to === "worker_active" || t.to === "worker_done")) workerAgent = t.agent
      if (t.agent && (t.to === "verifier_active" || t.to === "verified_pass" || t.to === "verified_fail")) verifierAgent = t.agent
      if (t.branch) branch = t.branch
      if (t.worktree) worktree = t.worktree
    }
    ev = {
      startedAt: transitions[startIdx].ts,
      endedAt: transitions[endIdx].ts,
      durationMs: transitions[endIdx].tsMs - transitions[startIdx].tsMs,
      rounds,
      workerAgent,
      verifierAgent,
      branch,
      worktree,
    }
  }

  const status = strOrNull(stateTask?.status, MAX_SHORT) ?? strOrNull(planTask?.status, MAX_SHORT) ?? "pending"

  const verification = isRecord(stateTask?.verification) ? stateTask.verification : null
  let checksPassed = numberOrNull(verification?.passedChecks)
  let checksTotal = numberOrNull(verification?.totalChecks)
  if (checksTotal === null && report && Array.isArray(report.checks)) {
    const checks = report.checks.filter(isRecord)
    checksTotal = checks.length
    checksPassed = checks.filter((c) => c.passed === true).length
  }

  const fatal = []
  if (verification && Array.isArray(verification.fatalFindings)) {
    for (const f of verification.fatalFindings) {
      const s = strOrNull(f, MAX_TEXT)
      if (s) fatal.push(s)
    }
  }
  if (report && Array.isArray(report.fatalFindings)) {
    for (const f of report.fatalFindings) {
      if (!isRecord(f)) continue
      const s = [strOrNull(f.where, MAX_SHORT), strOrNull(f.why, MAX_TEXT), strOrNull(f.fix, MAX_TEXT)].filter(Boolean).join(" — ")
      if (s) fatal.push(s)
    }
  }

  const tokenBuckets = isRecord(costs.byTaskTokens) ? costs.byTaskTokens : {}
  const costBuckets = isRecord(costs.byTask) ? costs.byTask : {}

  const note = [
    ev ? null : "no events.jsonl entries for this task; start and duration unknown",
    valid ? null : "task id failed validation; its verify report was not read",
  ]
    .filter(Boolean)
    .join("; ")

  return {
    id: taskId,
    valid,
    status,
    workerAgent: ev?.workerAgent ?? strOrNull(planTask?.agent, MAX_SHORT),
    verifierAgent: strOrNull(report?.verifierAgent, MAX_SHORT) ?? ev?.verifierAgent ?? null,
    verifierModel: strOrNull(report?.verifierModel, MAX_SHORT),
    rounds: Math.max(numberOrNull(stateTask?.round) ?? 0, numberOrNull(planTask?.round) ?? 0, ev?.rounds ?? 0),
    branch: strOrNull(stateTask?.branch, MAX_SHORT) ?? ev?.branch ?? null,
    worktree: strOrNull(stateTask?.worktree, MAX_SHORT) ?? ev?.worktree ?? null,
    summary: strOrNull(stateTask?.summary) ?? null,
    feedback: strOrNull(stateTask?.feedback) ?? strOrNull(report?.feedbackForWorker) ?? null,
    fatalFindings: fatal.slice(0, MAX_FATAL),
    verificationStatus: normStatus(verification?.status) ?? normStatus(report?.status),
    checksPassed,
    checksTotal,
    startedAt: ev?.startedAt ?? null,
    endedAt: ev ? ev.endedAt : strOrNull(stateTask?.updatedAt, 80),
    durationMs: ev ? ev.durationMs : null,
    costUsd: Object.prototype.hasOwnProperty.call(costBuckets, taskId) ? numberOrNull(costBuckets[taskId]) : null,
    tokens: Object.prototype.hasOwnProperty.call(tokenBuckets, taskId) ? sanitizeTokenBucket(tokenBuckets[taskId]) : null,
    note: note || null,
  }
}

function buildSecurity(raw) {
  if (!raw) return null
  const findings = Array.isArray(raw.findings)
    ? raw.findings
        .filter(isRecord)
        .slice(0, MAX_FINDINGS)
        .map((f) => ({
          id: strOrNull(f.id, 80) ?? "—",
          severity: strOrNull(f.severity, 32) ?? "—",
          location: strOrNull(f.location, MAX_SHORT),
          description: strOrNull(f.description, MAX_TEXT) ?? "—",
        }))
    : []
  const counts = { critical: 0, high: 0, medium: 0, low: 0 }
  if (isRecord(raw.severityCounts) && SEVERITIES.some((k) => numberOrNull(raw.severityCounts[k]) !== null)) {
    for (const k of SEVERITIES) counts[k] = nonNegInt(raw.severityCounts[k])
  } else {
    for (const f of findings) {
      const k = f.severity.toLowerCase()
      if (SEVERITIES.includes(k)) counts[k]++
    }
  }
  return {
    status: normStatus(raw.status),
    timestamp: strOrNull(raw.timestamp, 80),
    summary: strOrNull(raw.summary, MAX_TEXT),
    counts,
    findings,
  }
}

function buildFinal(raw) {
  if (!raw) return null
  let checksPassed = numberOrNull(raw.passedChecks)
  let checksTotal = numberOrNull(raw.totalChecks)
  if (checksTotal === null && Array.isArray(raw.checks)) {
    const checks = raw.checks.filter(isRecord)
    checksTotal = checks.length
    checksPassed = checks.filter((c) => c.passed === true).length
  }
  return {
    status: normStatus(raw.status),
    timestamp: strOrNull(raw.timestamp, 80),
    summary: strOrNull(raw.summary, MAX_TEXT),
    checksPassed,
    checksTotal,
  }
}

// PASS only when every task verified, the audit did not FAIL, and nothing is blocked
// or failed. FAIL on any hard failure. Anything else is INCOMPLETE.
function overallStatus(tasks, security, finalReport) {
  const anyBad = tasks.some((t) => t.status === "blocked" || t.status === "verified_fail")
  const secFail = !!security && (security.status === "FAIL" || security.counts.critical > 0 || security.counts.high > 0)
  if (anyBad || secFail || finalReport?.status === "FAIL") return "FAIL"
  if (finalReport?.status === "PASS") return "PASS"
  if (tasks.length > 0 && tasks.every((t) => t.status === "verified_pass") && (!security || security.status === "PASS")) return "PASS"
  return "INCOMPLETE"
}

// ------------------------------------------------------------ rendering

const BADGE = {
  PASS: ["b-pass", "PASS"],
  FAIL: ["b-fail", "FAIL"],
  BLOCKED: ["b-blocked", "BLOCKED"],
  INCOMPLETE: ["b-wait", "INCOMPLETE"],
}

function badgeLabel(status) {
  if (status === "verified_pass") return "PASS"
  if (status === "verified_fail") return "FAIL"
  if (status === "blocked") return "BLOCKED"
  return String(status ?? "pending").replace(/_/g, " ").toUpperCase()
}

function badgeClass(label) {
  if (BADGE[label]) return BADGE[label][0]
  if (label === "PENDING") return "b-wait"
  return "b-other"
}

function badgeHtml(label) {
  const text = h(label, "UNKNOWN", MAX_SHORT)
  return `<span class="badge ${badgeClass(label)}">${text}</span>`
}

function taskStatusLabel(task) {
  return badgeLabel(task.status)
}

const CSS = `:root{color-scheme:light dark;--bg:#f6f7f9;--fg:#1b1f24;--muted:#5b6470;--card:#fff;--line:#d8dde3;--code:#eef1f4;--pass:#15803d;--fail:#b91c1c;--block:#b45309;--wait:#475569;--info:#1d4ed8}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9aa4af;--card:#161b22;--line:#30363d;--code:#21262d;--pass:#3fb950;--fail:#f85149;--block:#d29922;--wait:#8b949e;--info:#58a6ff}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:22px;margin:0 0 4px}
h2{font-size:17px;margin:28px 0 10px;border-bottom:1px solid var(--line);padding-bottom:6px}
h4{margin:10px 0 4px;font-size:13px;color:var(--muted)}
.sub{color:var(--muted);margin:0 0 16px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--code);padding:1px 5px;border-radius:4px;word-break:break-all}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px}
.warn{border-left:4px solid var(--block)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px 20px;margin:0}
.grid dt{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.grid dd{margin:2px 0 0;font-weight:500;overflow-wrap:anywhere}
.badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:700;letter-spacing:.03em;color:#fff;white-space:nowrap}
.b-pass{background:var(--pass)}.b-fail{background:var(--fail)}.b-blocked{background:var(--block)}.b-wait{background:var(--wait)}.b-other{background:var(--info)}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}
th{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;background:var(--code)}
tr:last-child td{border-bottom:0}
.num{text-align:right;white-space:nowrap}
.muted{color:var(--muted)}
details{margin-top:6px}
summary{cursor:pointer;color:var(--info)}
.txt{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--code);padding:8px;border-radius:6px;margin:4px 0}
.sev td{text-align:center;font-size:18px;font-weight:600}
ul{padding-left:20px;margin:6px 0}
li{margin:4px 0;overflow-wrap:anywhere}
footer{margin-top:32px;color:var(--muted);font-size:12px}
@media print{body{background:#fff;color:#000}.card,table{box-shadow:none;border-color:#999}.wrap{max-width:none}details{page-break-inside:avoid}details[open]{display:block}summary{color:#000}}`

function fmtTokensHtml(t) {
  if (!t) return "n/a"
  return `in ${int(t.input)} · out ${int(t.output)} · reasoning ${int(t.reasoning)} · cache read ${int(t.cache.read)} / write ${int(t.cache.write)}`
}

function fmtTokensMd(t) {
  if (!t) return "n/a"
  return `in ${int(t.input)} / out ${int(t.output)} / reasoning ${int(t.reasoning)} / cache read ${int(t.cache.read)} / write ${int(t.cache.write)}`
}

function renderHtml(d) {
  const title = d.error ? "Teamwork run report (error)" : `Teamwork run ${h(d.sessionId, "unknown", MAX_SHORT)}`
  const out = []
  out.push(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
<style>${CSS}</style>
</head>
<body>
<main class="wrap">
<header>
<h1>${title}</h1>
<p class="sub">Offline Teamwork run report, generated read-only from the run directory.</p>
</header>`)

  if (d.error) {
    out.push(`<section class="card warn"><h2>Export refused</h2><p>${h(d.error, "unknown error")}</p></section>`)
  } else {
    const timingLine =
      d.timing === "events"
        ? `${h(d.startedAt, "unknown", 80)} → ${h(d.endedAt, "unknown", 80)}`
        : `timing unknown (no events.jsonl); last update ${h(d.endedAt, "unknown", 80)}`
    out.push(`<section class="card" aria-label="Summary"><dl class="grid">
<div><dt>Session ID</dt><dd><code>${h(d.sessionId, "unknown", MAX_SHORT)}</code></dd></div>
<div><dt>Topology</dt><dd>${h(d.topology, "unknown", MAX_SHORT)}</dd></div>
<div><dt>Status</dt><dd>${badgeHtml(d.status)}</dd></div>
<div><dt>Phase</dt><dd>${h(d.phase, "UNKNOWN", MAX_SHORT)}</dd></div>
<div><dt>Duration</dt><dd>${fmtDuration(d.durationMs)}<br><span class="muted">${timingLine}</span></dd></div>
<div><dt>Budget vs spent</dt><dd>${fmtUsd(d.budgetUsd)} budget · ${fmtUsd(d.spentUsd)} spent${
      d.budgetSource ? ` <span class="muted">(${h(d.budgetSource, "", MAX_SHORT)})</span>` : ""
    }</dd></div>
<div><dt>Total tokens</dt><dd>${fmtTokensHtml(d.tokens)}</dd></div>
<div><dt>Tasks</dt><dd>${d.totals.tasks} total · ${d.totals.passed} passed · ${d.totals.failed} failed · ${d.totals.blocked} blocked · ${d.totals.pending} open</dd></div>
</dl></section>`)

    out.push(`<h2>Tasks</h2>`)
    out.push(`<div class="scroll"><table><thead><tr><th>Task</th><th>Status</th><th>Worker</th><th>Verifier</th><th class="num">Rounds</th><th>Duration</th><th class="num">Cost</th><th class="num">Checks</th></tr></thead><tbody>`)
    if (!d.tasks.length) out.push(`<tr><td colspan="8" class="muted">No tasks recorded.</td></tr>`)
    for (const t of d.tasks) {
      const label = taskStatusLabel(t)
      const checks = t.checksTotal !== null ? `${int(t.checksPassed ?? 0)}/${int(t.checksTotal)}` : "n/a"
      const verifierModel = t.verifierModel ? `<br><span class="muted">${h(t.verifierModel, "", MAX_SHORT)}</span>` : ""
      out.push(`<tr>
<td><strong>${h(t.id, "—", MAX_SHORT)}</strong>${t.note ? `<br><span class="muted">${h(t.note, "", MAX_TEXT)}</span>` : ""}
<details><summary>Feedback &amp; summary</summary>
<h4>Summary</h4><div class="txt">${h(t.summary, "none recorded")}</div>
<h4>Feedback</h4><div class="txt">${h(t.feedback, "none")}</div>
${t.fatalFindings.length ? `<h4>Fatal findings</h4><ul>${t.fatalFindings.map((f) => `<li>${h(f, "", MAX_TEXT)}</li>`).join("")}</ul>` : ""}
<h4>Branch</h4><div class="txt">${h(t.branch, "n/a", MAX_SHORT)}</div>
<h4>Worktree</h4><div class="txt">${h(t.worktree, "n/a", MAX_SHORT)}</div>
</details></td>
<td>${badgeHtml(label)}</td>
<td>${h(t.workerAgent, "unknown", MAX_SHORT)}</td>
<td>${h(t.verifierAgent, "unknown", MAX_SHORT)}${verifierModel}</td>
<td class="num">${int(t.rounds)}</td>
<td>${fmtDuration(t.durationMs)}</td>
<td class="num">${fmtUsd(t.costUsd)}</td>
<td class="num">${checks}</td>
</tr>`)
    }
    out.push(`</tbody></table></div>`)

    out.push(`<h2>Security audit</h2><section class="card">`)
    if (!d.security) {
      out.push(`<p>Pre-merge status: ${badgeHtml("NOT RUN")}</p><p class="muted">No verify/security-audit.json was found.</p>`)
    } else {
      const s = d.security
      const sLabel = s.status ?? "UNKNOWN"
      out.push(`<p>Pre-merge status: ${badgeHtml(sLabel)} <span class="muted">${h(s.timestamp, "", 80)}</span></p>`)
      out.push(`<div class="scroll"><table class="sev"><thead><tr><th>Critical</th><th>High</th><th>Medium</th><th>Low</th></tr></thead><tbody><tr><td>${int(s.counts.critical)}</td><td>${int(s.counts.high)}</td><td>${int(s.counts.medium)}</td><td>${int(s.counts.low)}</td></tr></tbody></table></div>`)
      if (s.summary) out.push(`<p>${h(s.summary)}</p>`)
      if (s.findings.length) {
        out.push(`<div class="scroll"><table><thead><tr><th>ID</th><th>Severity</th><th>Location</th><th>Description</th></tr></thead><tbody>`)
        for (const f of s.findings) {
          out.push(`<tr><td>${h(f.id)}</td><td>${h(f.severity)}</td><td>${h(f.location, "—", MAX_SHORT)}</td><td>${h(f.description)}</td></tr>`)
        }
        out.push(`</tbody></table></div>`)
      } else {
        out.push(`<p class="muted">No findings recorded.</p>`)
      }
    }
    out.push(`</section>`)

    if (d.finalReport) {
      const f = d.finalReport
      out.push(`<h2>Final verification</h2><section class="card"><p>Status: ${badgeHtml(f.status ?? "UNKNOWN")} · checks ${f.checksPassed === null ? "n/a" : int(f.checksPassed)}/${f.checksTotal === null ? "n/a" : int(f.checksTotal)}</p>${f.summary ? `<p>${h(f.summary)}</p>` : ""}</section>`)
    }

    out.push(`<h2>Pitfalls</h2><section class="card">`)
    if (d.pitfalls.length) {
      out.push(`<ul>${d.pitfalls.map((p) => `<li>${h(p, "", MAX_PITFALL)}</li>`).join("")}</ul>`)
    } else {
      out.push(`<p class="muted">No pitfalls recorded.</p>`)
    }
    out.push(`</section>`)

    if (d.unattributed.length) {
      out.push(`<h2>Other cost buckets</h2><div class="scroll"><table><thead><tr><th>Bucket</th><th class="num">Cost</th></tr></thead><tbody>`)
      for (const u of d.unattributed) out.push(`<tr><td>${h(u.bucket, "—", 80)}</td><td class="num">${fmtUsd(u.costUsd)}</td></tr>`)
      out.push(`</tbody></table></div>`)
    }
  }

  if (d.warnings.length) {
    out.push(`<h2>Warnings</h2><section class="card warn"><ul>${d.warnings.map((w) => `<li>${h(w, "", MAX_SHORT)}</li>`).join("")}</ul></section>`)
  }

  out.push(`<footer>Generated by opencode-teamwork export. Single file: no scripts, no external resources.</footer>
</main>
</body>
</html>
`)
  return out.join("\n")
}

function renderMarkdown(d) {
  const out = []
  if (d.error) {
    out.push("# Teamwork run report", "", `> **Error:** ${md(d.error, "unknown error")}`, "")
    for (const w of d.warnings) out.push(`- ${md(w, "", MAX_SHORT)}`)
    return out.join("\n") + "\n"
  }

  out.push(`# Teamwork run report: ${md(d.sessionId, "unknown", MAX_SHORT)}`, "")
  out.push("## Summary", "")
  out.push("| Field | Value |", "|---|---|")
  out.push(`| Session ID | ${md(d.sessionId, "unknown", MAX_SHORT)} |`)
  out.push(`| Topology | ${md(d.topology, "unknown", MAX_SHORT)} |`)
  out.push(`| Status | **${md(d.status, "UNKNOWN", MAX_SHORT)}** |`)
  out.push(`| Phase | ${md(d.phase, "UNKNOWN", MAX_SHORT)} |`)
  out.push(`| Duration | ${fmtDuration(d.durationMs)}${d.timing === "events" ? ` (${md(d.startedAt, "unknown", 80)} → ${md(d.endedAt, "unknown", 80)})` : " (timing unknown: no events.jsonl)"} |`)
  out.push(`| Budget | ${fmtUsd(d.budgetUsd)}${d.budgetSource ? ` (${md(d.budgetSource, "", MAX_SHORT)})` : ""} |`)
  out.push(`| Spent | ${fmtUsd(d.spentUsd)} |`)
  out.push(`| Total tokens | ${fmtTokensMd(d.tokens)} |`)
  out.push(`| Tasks | ${d.totals.tasks} total, ${d.totals.passed} passed, ${d.totals.failed} failed, ${d.totals.blocked} blocked, ${d.totals.pending} open |`)
  out.push("")

  out.push("## Tasks", "")
  out.push("| Task | Status | Worker | Verifier | Rounds | Duration | Cost | Checks |", "|---|---|---|---|---:|---:|---:|---:|")
  if (!d.tasks.length) out.push("| _none_ |  |  |  |  |  |  |  |")
  for (const t of d.tasks) {
    const checks = t.checksTotal !== null ? `${int(t.checksPassed ?? 0)}/${int(t.checksTotal)}` : "n/a"
    out.push(
      `| ${md(t.id, "—", MAX_SHORT)} | ${md(taskStatusLabel(t), "UNKNOWN", MAX_SHORT)} | ${md(t.workerAgent, "unknown", MAX_SHORT)} | ${md(t.verifierAgent, "unknown", MAX_SHORT)} | ${int(t.rounds)} | ${fmtDuration(t.durationMs)} | ${fmtUsd(t.costUsd)} | ${checks} |`,
    )
  }
  out.push("")

  out.push("## Acceptance checklist", "")
  if (!d.tasks.length) out.push("- [ ] No tasks recorded")
  for (const t of d.tasks) {
    const done = t.status === "verified_pass"
    out.push(`- [${done ? "x" : " "}] ${md(t.id, "—", MAX_SHORT)}: ${md(taskStatusLabel(t), "UNKNOWN", MAX_SHORT)}${done ? ` (round ${int(t.rounds)})` : ""}`)
  }
  const secPass = !!d.security && d.security.status === "PASS"
  out.push(`- [${secPass ? "x" : " "}] Security audit gate: ${md(d.security ? d.security.status : null, "NOT RUN", MAX_SHORT)}`)
  out.push("")

  out.push("## Task details", "")
  if (!d.tasks.length) out.push("_No task details._", "")
  for (const t of d.tasks) {
    out.push(`### ${md(t.id, "—", MAX_SHORT)}`, "")
    out.push(`- **Branch:** ${md(t.branch, "n/a", MAX_SHORT)}`)
    out.push(`- **Summary:** ${md(t.summary, "none recorded")}`)
    out.push(`- **Feedback:** ${md(t.feedback, "none")}`)
    if (t.verifierModel) out.push(`- **Verifier model:** ${md(t.verifierModel, "", MAX_SHORT)}`)
    if (t.tokens) out.push(`- **Tokens:** ${fmtTokensMd(t.tokens)}`)
    if (t.note) out.push(`- **Note:** ${md(t.note, "", MAX_TEXT)}`)
    for (const f of t.fatalFindings) out.push(`- **Fatal:** ${md(f, "", MAX_TEXT)}`)
    out.push("")
  }

  out.push("## Security audit", "")
  if (!d.security) {
    out.push("Pre-merge status: **NOT RUN** (no verify/security-audit.json).", "")
  } else {
    const s = d.security
    out.push(`Pre-merge status: **${md(s.status, "UNKNOWN", MAX_SHORT)}**${s.timestamp ? ` (${md(s.timestamp, "", 80)})` : ""}`, "")
    out.push("| Critical | High | Medium | Low |", "|---:|---:|---:|---:|")
    out.push(`| ${int(s.counts.critical)} | ${int(s.counts.high)} | ${int(s.counts.medium)} | ${int(s.counts.low)} |`, "")
    if (s.summary) out.push(md(s.summary), "")
    if (s.findings.length) {
      for (const f of s.findings) {
        out.push(`- **${md(f.id, "—", 80)}** (${md(f.severity, "—", 32)}) at ${md(f.location, "—", MAX_SHORT)}: ${md(f.description)}`)
      }
    } else {
      out.push("_No findings recorded._")
    }
    out.push("")
  }

  if (d.finalReport) {
    const f = d.finalReport
    out.push("## Final verification", "")
    out.push(`Status: **${md(f.status, "UNKNOWN", MAX_SHORT)}**, checks ${f.checksPassed === null ? "n/a" : int(f.checksPassed)}/${f.checksTotal === null ? "n/a" : int(f.checksTotal)}`, "")
    if (f.summary) out.push(md(f.summary), "")
  }

  out.push("## Pitfalls", "")
  if (d.pitfalls.length) {
    for (const p of d.pitfalls) out.push(`- ${md(p, "", MAX_PITFALL)}`)
  } else {
    out.push("_No pitfalls recorded._")
  }
  out.push("")

  if (d.warnings.length) {
    out.push("## Warnings", "")
    for (const w of d.warnings) out.push(`- ${md(w, "", MAX_SHORT)}`)
    out.push("")
  }

  return out.join("\n")
}

/**
 * Render export data as one document. Pure: no I/O, no clock.
 * format "markdown" gives GitHub-flavoured Markdown; anything else (including
 * undefined) gives the single-file HTML document.
 * @param {object} data     From buildExportData (or an error object)
 * @param {{format?: string}} [options]
 * @returns {string}
 */
export function renderExport(data, options = {}) {
  const format = options && options.format === "markdown" ? "markdown" : "html"
  const d = isRecord(data) ? normalize(data) : errorData(null, "no export data was provided")
  return format === "markdown" ? renderMarkdown(d) : renderHtml(d)
}

// Guard the shape so a hand-built data object cannot break the renderers.
function normalize(data) {
  if (data.error) {
    return { ...errorData(strOrNull(data.sessionId, MAX_SHORT), txt(data.error, MAX_SHORT) ?? "unknown error"), warnings: arr(data.warnings).map((w) => txt(w, MAX_SHORT)).filter(Boolean) }
  }
  const tasks = arr(data.tasks).filter(isRecord).map((t) => ({
    id: strOrNull(t.id, MAX_SHORT) ?? "—",
    valid: isValidTaskId(t.id),
    status: strOrNull(t.status, MAX_SHORT) ?? "pending",
    workerAgent: strOrNull(t.workerAgent, MAX_SHORT),
    verifierAgent: strOrNull(t.verifierAgent, MAX_SHORT),
    verifierModel: strOrNull(t.verifierModel, MAX_SHORT),
    rounds: nonNegInt(t.rounds),
    branch: strOrNull(t.branch, MAX_SHORT),
    worktree: strOrNull(t.worktree, MAX_SHORT),
    summary: strOrNull(t.summary),
    feedback: strOrNull(t.feedback),
    fatalFindings: arr(t.fatalFindings).map((f) => strOrNull(f)).filter(Boolean).slice(0, MAX_FATAL),
    checksPassed: numberOrNull(t.checksPassed),
    checksTotal: numberOrNull(t.checksTotal),
    startedAt: strOrNull(t.startedAt, 80),
    endedAt: strOrNull(t.endedAt, 80),
    durationMs: numberOrNull(t.durationMs),
    costUsd: numberOrNull(t.costUsd),
    tokens: sanitizeTokenBucket(t.tokens),
    note: strOrNull(t.note),
  }))
  const sec = isRecord(data.security) ? data.security : null
  const fin = isRecord(data.finalReport) ? data.finalReport : null
  const totals = isRecord(data.totals) ? data.totals : {}
  return {
    error: null,
    sessionId: strOrNull(data.sessionId, MAX_SHORT),
    topology: strOrNull(data.topology, MAX_SHORT) ?? "unknown",
    phase: strOrNull(data.phase, MAX_SHORT) ?? "UNKNOWN",
    status: strOrNull(data.status, MAX_SHORT) ?? "INCOMPLETE",
    timing: data.timing === "events" ? "events" : "unknown",
    startedAt: strOrNull(data.startedAt, 80),
    endedAt: strOrNull(data.endedAt, 80),
    durationMs: numberOrNull(data.durationMs),
    budgetUsd: numberOrNull(data.budgetUsd),
    budgetSource: strOrNull(data.budgetSource, MAX_SHORT),
    spentUsd: numberOrNull(data.spentUsd) ?? 0,
    tokens: sanitizeTokenBucket(data.tokens),
    tasks,
    totals: {
      tasks: tasks.length,
      passed: tasks.filter((t) => t.status === "verified_pass").length,
      failed: tasks.filter((t) => t.status === "verified_fail").length,
      blocked: tasks.filter((t) => t.status === "blocked").length,
      pending: 0,
      rounds: nonNegInt(totals.rounds),
    },
    unattributed: arr(data.unattributed)
      .filter(isRecord)
      .map((u) => ({ bucket: strOrNull(u.bucket, 80) ?? "—", costUsd: numberOrNull(u.costUsd) ?? 0 })),
    security: sec
      ? {
          status: normStatus(sec.status),
          timestamp: strOrNull(sec.timestamp, 80),
          summary: strOrNull(sec.summary),
          counts: {
            critical: nonNegInt(sec.counts?.critical),
            high: nonNegInt(sec.counts?.high),
            medium: nonNegInt(sec.counts?.medium),
            low: nonNegInt(sec.counts?.low),
          },
          findings: arr(sec.findings)
            .filter(isRecord)
            .slice(0, MAX_FINDINGS)
            .map((f) => ({
              id: strOrNull(f.id, 80) ?? "—",
              severity: strOrNull(f.severity, 32) ?? "—",
              location: strOrNull(f.location, MAX_SHORT),
              description: strOrNull(f.description) ?? "—",
            })),
        }
      : null,
    finalReport: fin
      ? {
          status: normStatus(fin.status),
          timestamp: strOrNull(fin.timestamp, 80),
          summary: strOrNull(fin.summary),
          checksPassed: numberOrNull(fin.checksPassed),
          checksTotal: numberOrNull(fin.checksTotal),
        }
      : null,
    pitfalls: arr(data.pitfalls).map((p) => strOrNull(p, MAX_PITFALL)).filter(Boolean).slice(0, MAX_PITFALLS),
    warnings: arr(data.warnings).map((w) => txt(w, MAX_SHORT)).filter(Boolean),
  }
}

function arr(value) {
  return Array.isArray(value) ? value : []
}
