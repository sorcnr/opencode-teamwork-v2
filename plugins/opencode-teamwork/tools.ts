// opencode-teamwork — Teamwork engine tools + hooks (V2 plugin API)
//
// Turns the mechanics that the prompts used to describe in prose (run dir,
// plan, state, cost, pitfalls, resume) into real tools, and uses hooks to
// enforce the read-only guarantee and to inject run context automatically.
//
// Security notes:
//   * Every run path is built from a VALIDATED session id and asserted to stay
//     inside the run root (no path traversal / arbitrary file write).
//   * Untrusted run state is sanitised before it is injected into any system
//     prompt (no stored prompt injection).
//   * The read-only policy is an explicit per-agent deny list (fail-closed):
//     an unknown agent is not silently allowed to escalate via subagent/webfetch.
//
// No OpenCode imports: tool definitions are plain objects, so the loader never
// has to resolve node_modules for this package.

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync, appendFileSync, renameSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative } from "node:path"

// ---------------------------------------------------------------------------
// OpenCode native cost tracking
//
// The plugin context (`ctx`) is itself an OpenCode server client, so the
// canonical cost signal is `ctx.session.get({ sessionID })`, whose Session.Info
// carries `cost` (Money.USD) and `tokens` (TokenUsage.Info) computed by
// OpenCode from real token usage. We snapshot the cumulative cost per session
// and report deltas, so a run's spend is measured — never self-reported.
// When the client is unavailable (tests, non-OpenCode host) we fall back to
// manual addUsd.
// ---------------------------------------------------------------------------

interface TokenUsage {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

interface SessionSnapshot {
  /** Last observed cumulative cost for this OpenCode session, in USD. */
  lastCost: number
  lastTokens: TokenUsage
  timestamp: string
}

interface SnapshotsFile {
  sessionId: string
  bySession: Record<string, SessionSnapshot>
}

function normalizeTokens(t: any): TokenUsage {
  return {
    input: Number(t?.input) || 0,
    output: Number(t?.output) || 0,
    reasoning: Number(t?.reasoning) || 0,
    cache: { read: Number(t?.cache?.read) || 0, write: Number(t?.cache?.write) || 0 },
  }
}

function readSnapshots(file: string): SnapshotsFile | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as SnapshotsFile
    if (!parsed || typeof parsed !== "object" || typeof parsed.bySession !== "object") return undefined
    return parsed
  } catch {
    return undefined
  }
}

function writeSnapshots(file: string, value: SnapshotsFile) {
  refuseSymlink(file)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + ".tmp"
  refuseSymlink(tmp)
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n")
  renameSync(tmp, file)
}

/**
 * Read the real cumulative cost + tokens for an OpenCode session from the
 * plugin client. Returns undefined when the client or session is unavailable
 * (tests, non-OpenCode host), which switches the cost tool to manual mode.
 */
async function readSessionUsage(
  ctx: any,
  sessionID: string | undefined,
): Promise<{ cost: number; tokens: TokenUsage } | undefined> {
  if (!sessionID || typeof ctx?.session?.get !== "function") return undefined
  try {
    const info = await ctx.session.get({ sessionID })
    if (!info || typeof info.cost !== "number") return undefined
    return { cost: info.cost, tokens: normalizeTokens(info.tokens) }
  } catch {
    return undefined
  }
}

/** True when the opencode_console MCP server is connected for this location. */
async function isConsoleMcpConnected(ctx: any): Promise<boolean> {
  try {
    if (typeof ctx?.mcp?.list !== "function") return false
    const out = await ctx.mcp.list()
    const servers = Array.isArray(out) ? out : (out?.data ?? [])
    return servers.some((s: any) => /console/i.test(String(s?.name ?? "")) && s?.status?.status === "connected")
  } catch {
    return false
  }
}

/** Provider id of a Model.Ref, unwrapping the `{ location, data }` client envelope. */
function providerOf(value: any): string | undefined {
  const v = value && typeof value === "object" && "data" in value ? value.data : value
  return v?.providerID ?? v?.provider ?? undefined
}

/**
 * True when the run is on managed `opencode/` models — checked against the
 * active session's model, the location default model, and every `team/*`
 * agent's configured model. Any `opencode` provider ⇒ console credits apply.
 */
async function usesOpencodeModel(ctx: any, sessionID?: string): Promise<boolean> {
  // 1. The active session's model.
  try {
    if (sessionID && typeof ctx?.session?.get === "function") {
      const s: any = await ctx.session.get({ sessionID })
      if (providerOf(s?.model ?? s?.data?.model) === "opencode") return true
    }
  } catch {}
  // 2. The location default model.
  try {
    if (typeof ctx?.model?.default === "function") {
      if (providerOf(await ctx.model.default()) === "opencode") return true
    }
  } catch {}
  // 3. Any team/* agent configured with an opencode/ model.
  try {
    if (typeof ctx?.agent?.list === "function") {
      const out: any = await ctx.agent.list()
      const agents = Array.isArray(out) ? out : (out?.data ?? [])
      return agents.some((a: any) => /^team\//.test(String(a?.id ?? a?.name ?? "")) && providerOf(a?.model) === "opencode")
    }
  } catch {}
  return false
}

const RUN_ROOT = ".opencode/teamwork"

// session ids are generated by us; anything else must match this allowlist.
const SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/
const PHASES = new Set(["LOAD_SPEC", "WORKTREE_INIT", "DAG_BUILD", "DISPATCH", "MERGE", "PRESENT_PARTIAL", "DONE"])

// Per-agent read-only policy, enforced in code. Keys are agent ids; values are
// the actions that agent may NOT perform. Anything not listed keeps its
// frontmatter permissions.
const READ_ONLY_ACTIONS: Record<string, Set<string>> = {
  // Real OpenCode permission actions only (see the V2 docs): edit covers the
  // write tool too, so "write"/"task" are intentionally not listed.
  "team/verifier": new Set(["edit", "webfetch", "subagent"]),
  "team/falsifier": new Set(["edit", "shell", "subagent"]),
  "team/scout": new Set(["edit", "subagent"]),
  "team/security-auditor": new Set(["edit", "subagent"]),
}

const pad = (n: number) => String(n).padStart(2, "0")

function newSessionId(): string {
  const d = new Date()
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const hex = Math.random().toString(16).slice(2, 6)
  return `${ts}-${hex}`
}

/** Strip control characters / newlines and cap length. Never inject raw file text. */
function clean(value: unknown, max = 64): string {
  return String(value ?? "")
    .replace(/[\r\n\t\x00-\x1f\u2028\u2029]/g, " ")
    .slice(0, max)
}

function runsDir(root: string) {
  return join(root, RUN_ROOT)
}

/**
 * Validate the run root itself: `.opencode` and `.opencode/teamwork` must not
 * be symlinks, and the resolved base must stay inside the project root. This
 * closes the "commit `.opencode/teamwork` as a symlink" escape that a run-dir
 * check alone misses.
 */
function runsBase(root: string): { base: string } | { error: string } {
  const parent = join(root, ".opencode")
  const base = join(parent, "teamwork")
  for (const p of [parent, base]) {
    try {
      if (existsSync(p) && lstatSync(p).isSymbolicLink()) return { error: "refused: run root is a symlink" }
    } catch {
      return { error: "refused: run root is not readable" }
    }
  }
  if (existsSync(base)) {
    try {
      const rel = relative(realpathSync(root), realpathSync(base))
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) return { error: "refused: run root escapes the project" }
    } catch {
      return { error: "refused: run root is not resolvable" }
    }
  }
  return { base }
}

/**
 * Refuse to write through a symlinked file (would escape the run dir).
 * lstat the path directly: existsSync() follows links, so a *dangling* symlink
 * would otherwise be missed and the write would follow it.
 */
function refuseSymlink(file: string) {
  try {
    if (lstatSync(file).isSymbolicLink()) {
      throw new Error(`refused: refusing to write through symlink "${basename(file)}"`)
    }
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e
  }
}

function listRuns(root: string) {
  const b = runsBase(root)
  if ("error" in b) return [] as { name: string; path: string; mtime: number }[]
  const dir = b.base
  if (!existsSync(dir)) return [] as { name: string; path: string; mtime: number }[]
  return readdirSync(dir)
    .map((name) => {
      const path = join(dir, name)
      let mtime = 0
      try {
        mtime = lstatSync(path).mtimeMs
      } catch {}
      return { name, path, mtime }
    })
    .filter((e) => {
      try {
        // lstat: a symlinked dir is NOT a run (would escape the root).
        return lstatSync(e.path).isDirectory()
      } catch {
        return false
      }
    })
    .filter((e) => SESSION_ID.test(e.name)) // only names we could have generated
    .sort((a, b) => b.mtime - a.mtime)
}

/**
 * Resolve a run directory. Validates the run root, the session id (allowlist),
 * and asserts — lexically and via realpath — that the result stays inside the
 * run root. Closes `..` traversal and symlink escapes.
 */
function resolveRun(root: string, sessionId?: string): { run?: string; error?: string } {
  const b = runsBase(root)
  if ("error" in b) return { error: b.error }
  const base = b.base

  if (sessionId) {
    if (!SESSION_ID.test(sessionId)) return { error: `refused: invalid session id "${clean(sessionId, 32)}"` }
    const run = join(base, sessionId)
    const rel = relative(base, run)
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return { error: "refused: session id escapes the run root" }
    if (existsSync(run)) {
      try {
        if (lstatSync(run).isSymbolicLink()) return { error: "refused: run dir is a symlink" }
        const relReal = relative(realpathSync(base), realpathSync(run))
        if (!relReal || relReal.startsWith("..") || isAbsolute(relReal)) return { error: "refused: run dir escapes the run root" }
      } catch {
        return { error: "refused: run dir is not resolvable" }
      }
    }
    return { run }
  }
  const latest = listRuns(root)[0]?.path
  return latest ? { run: latest } : { error: "no Teamwork run found" }
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T
  } catch {
    return fallback
  }
}

function writeJson(file: string, value: unknown) {
  refuseSymlink(file)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + ".tmp"
  refuseSymlink(tmp)
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n")
  renameSync(tmp, file)
}

function touch(file: string, content: string) {
  refuseSymlink(file)
  mkdirSync(dirname(file), { recursive: true })
  if (!existsSync(file)) writeFileSync(file, content)
}

// Serialise read-modify-write of a run's cost files within this process, so
// concurrent agents (parallel workers calling teamwork_cost at once) cannot
// clobber each other's attribution. Keyed by the file path; the whole async
// section — including the client read — runs inside the lock.
const fileLocks = new Map<string, Promise<unknown>>()
function withFileLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = fileLocks.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  fileLocks.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  )
  return next as Promise<T>
}

/**
 * Compact, sanitised run summary injected into team agents' system prompt.
 * Only whitelisted/enumerated fields are emitted; no raw file content.
 */
export function describeRun(root: string): string | undefined {
  const { run } = resolveRun(root)
  if (!run) return undefined
  const state = readJson<any>(join(run, "state.json"), undefined)
  if (!state) return undefined
  const tasks = Object.values(state.tasks || {}) as any[]
  const pass = tasks.filter((t) => t?.status === "pass").length
  const fail = tasks.filter((t) => t?.status === "fail").length
  let pitfalls = 0
  try {
    pitfalls = readFileSync(join(run, "pitfalls.md"), "utf8")
      .split("\n")
      .filter((l) => l.trim().startsWith("-")).length
  } catch {}
  const id = basename(run)
  if (!SESSION_ID.test(id)) return undefined // never inject a non-conforming dir name
  const phase = PHASES.has(state.phase) ? state.phase : "UNKNOWN"
  const costs = readJson<any>(join(run, "costs.json"), undefined)
  let costLine = "Cost: unknown."
  if (costs && typeof costs.budgetUsd === "number") {
    const budget = costs.budgetUsd
    const spent = Number(costs.spentUsd) || 0
    const pct = budget ? Math.floor((spent / budget) * 100) : 0
    costLine = `Cost: $${spent} of $${budget} (${pct}%)${pct >= 80 ? " — near budget, halt non-essential workers" : ""}.`
  }
  return [
    `[teamwork] active run ${id} — phase ${phase}.`,
    `Tasks: ${pass}/${tasks.length} pass, ${fail} fail. Open pitfalls: ${pitfalls}.`,
    costLine,
    `State: ${join(runsDir(root), id, "state.json")} (read it before dispatching).`,
  ].join("\n")
}

export async function registerTeamworkTools(ctx: any, root: string) {
  if (!ctx?.tool?.transform) return
  await ctx.tool.transform((editor: any) => {
    editor.namespace({
      name: "teamwork",
      description: "Deterministic Teamwork run state: plan, status, resume, cost, pitfalls.",
    })

    editor.add({
      name: "plan",
      description:
        "Create a Teamwork run directory and write plan.dag.json + state.json + costs.json. Returns the run path and the (validated) session id. Call this once before dispatching workers.",
      input: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Reuse an existing session id; omit to create one." },
          topology: { type: "string", description: "small-focused | iterative-coding | distributed-coding | proof | massive-proof | document-review" },
          budgetUsd: { type: "number", description: "Run budget in USD. When using opencode/ models + opencode_console, derive this from credits (full or partial, per the user's choice)." },
          budgetSource: { type: "string", description: "Where the budget came from: credits | default | manual." },
          tasks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                dependsOn: { type: "array", items: { type: "string" } },
                requirements: { type: "array", items: { type: "string" } },
                agent: { type: "string" },
                maxRounds: { type: "number" },
              },
              required: ["id"],
              additionalProperties: true,
            },
          },
        },
        required: ["topology", "tasks"],
        additionalProperties: false,
      },
      execute: async (input: any, context: any) => {
        const sessionId = input.sessionId || newSessionId()
        const resolved = resolveRun(root, sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string
        mkdirSync(run, { recursive: true })
        const tasks = (input.tasks || []).map((t: any) => ({
          id: clean(t.id, 64),
          dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map((d: any) => clean(d, 64)) : [],
          requirements: Array.isArray(t.requirements) ? t.requirements.map((r: any) => clean(r, 120)) : [],
          agent: clean(t.agent || "team/worker", 64),
          status: "pending",
          round: 0,
          maxRounds: Number.isFinite(t.maxRounds) ? t.maxRounds : 4,
        }))
        writeJson(join(run, "plan.dag.json"), { sessionId, topology: clean(input.topology, 64), tasks })
        if (!existsSync(join(run, "state.json"))) {
          writeJson(join(run, "state.json"), {
            version: 1,
            sessionId,
            phase: "DISPATCH",
            tasks: Object.fromEntries(tasks.map((t: any) => [t.id, { status: "pending", round: 0 }])),
            updatedAt: new Date().toISOString(),
          })
        }
        // Use ?? (nullish coalescing) so budgetUsd: 0 is respected as "no budget"
        const budget = input.budgetUsd ?? 20
        const costsFile = join(run, "costs.json")
        const callSession = context?.sessionID
        // Same lock as the cost tool so a re-plan cannot race a concurrent cost call.
        await withFileLock(costsFile, async () => {
          const existing = readJson<any>(costsFile, undefined)
          if (!existing) {
            writeJson(costsFile, {
              sessionId,
              budgetUsd: budget,
              budgetSource: input.budgetSource ? clean(input.budgetSource, 32) : "default",
              spentUsd: 0,
              byTask: {},
              updatedAt: new Date().toISOString(),
            })
          } else if (
            existing.budgetUsd !== budget ||
            (input.budgetSource && existing.budgetSource !== clean(input.budgetSource, 32))
          ) {
            // Update the budget/source but PRESERVE accumulated spend and
            // per-task buckets (a re-plan must not wipe the run's measured cost).
            existing.budgetUsd = budget
            if (input.budgetSource) existing.budgetSource = clean(input.budgetSource, 32)
            existing.updatedAt = new Date().toISOString()
            writeJson(costsFile, existing)
          }
          // Establish the native cost baseline for the calling session, preserving
          // any baselines already recorded for other sessions (merge, don't clobber).
          const now = new Date().toISOString()
          const usage = await readSessionUsage(ctx, callSession)
          const snaps = readSnapshots(join(run, "snapshots.json")) ?? { sessionId, bySession: {} }
          snaps.sessionId = sessionId
          if (callSession && usage && !snaps.bySession[callSession]) {
            snaps.bySession[callSession] = { lastCost: usage.cost, lastTokens: usage.tokens, timestamp: now }
          }
          writeSnapshots(join(run, "snapshots.json"), snaps)
        })
        touch(join(run, "pitfalls.md"), "# Pitfalls\n\n_answer-agnostic failure modes; one per line_\n")
        // Backstop: if console credits apply but the budget wasn't derived from
        // them, warn (advisory — the sentinel is instructed to run the preflight).
        let creditWarning = ""
        if (input.budgetSource !== "credits" && (await isConsoleMcpConnected(ctx)) && (await usesOpencodeModel(ctx, context?.sessionID))) {
          creditWarning = "\n⚠ opencode/ models + opencode_console connected — run teamwork_budget and derive budgetUsd from credits before dispatching."
        }
        return {
          content: `Planned ${tasks.length} task(s).\nSESSION_ID: ${sessionId}\nRun dir: ${run}\nBudget: $${budget} (source: ${input.budgetSource ? clean(input.budgetSource, 32) : "default"})\nplan.dag.json + state.json + costs.json written.${creditWarning}`,
        }
      },
    })

    editor.add({
      name: "status",
      description: "Read the active (or given) Teamwork run and summarize per-task progress.",
      input: { type: "object", properties: { sessionId: { type: "string" } }, additionalProperties: false },
      execute: async (input: any) => {
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string
        const state = readJson<any>(join(run, "state.json"), {})
        const tasks = state.tasks || {}
        const lines = Object.entries(tasks).map(([id, t]: any) => `  ${clean(id, 64)}: ${clean(t?.status, 16)} (round ${Number(t?.round) || 0})`)
        const pass = Object.values(tasks).filter((t: any) => t?.status === "pass").length
        return { content: `Run ${basename(run)} — phase ${PHASES.has(state.phase) ? state.phase : "UNKNOWN"}\n${pass}/${lines.length} pass\n${lines.join("\n")}` }
      },
    })

    editor.add({
      name: "resume",
      description: "Return the tasks that still need work (pending/running/fail) so a restarted Sentinel can continue where it stopped.",
      input: { type: "object", properties: { sessionId: { type: "string" } }, additionalProperties: false },
      execute: async (input: any) => {
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string
        const state = readJson<any>(join(run, "state.json"), {})
        const open = Object.entries(state.tasks || {}).filter(([, t]: any) => t?.status !== "pass")
        if (!open.length) return { content: `Run ${basename(run)} is complete (all tasks pass).` }
        return {
          content: `Resume ${basename(run)} at phase ${PHASES.has(state.phase) ? state.phase : "UNKNOWN"}. Open tasks:\n` + open.map(([id, t]: any) => `  ${clean(id, 64)}: ${clean(t?.status, 16)} round ${Number(t?.round) || 0}`).join("\n"),
        }
      },
    })

    editor.add({
      name: "cost",
      description:
        "Read the run budget and report real spend. Uses OpenCode's native per-session cost (ctx.session.get) and reports the delta since the last check; falls back to manual addUsd when the client is unavailable. Warns at 80%.",
      input: { type: "object", properties: { sessionId: { type: "string" }, addUsd: { type: "number" }, taskId: { type: "string" } }, additionalProperties: false },
      execute: async (input: any, context: any) => {
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string
        const file = join(run, "costs.json")
        const snapshotsFile = join(run, "snapshots.json")

        const callSession = typeof context?.sessionID === "string" ? context.sessionID : undefined

        // Serialise the whole read-modify-write (including the client read) so
        // parallel workers cannot lose each other's attribution.
        return await withFileLock(file, async () => {
          const costs = readJson<any>(file, undefined)
          if (!costs || typeof costs !== "object") {
            return { content: `No costs.json for run ${basename(run)} — call teamwork_plan first.` }
          }
          costs.byTask = costs.byTask && typeof costs.byTask === "object" ? costs.byTask : {}
          const budget = costs.budgetUsd ?? 20
          const usage = await readSessionUsage(ctx, callSession)

          // Attribute every dollar to a bucket so sum(byTask) === spentUsd holds
          // by construction — no drift between the per-task view and the total.
          const bucket = input.taskId ? clean(input.taskId, 64) : "_unattributed"
          const addToBucket = (amount: number) => {
            costs.byTask[bucket] = Math.round(((costs.byTask[bucket] || 0) + amount) * 1e4) / 1e4
            costs.spentUsd =
              Math.round(Object.values(costs.byTask).reduce((a: number, b: any) => a + (Number(b) || 0), 0) * 1e4) / 1e4
            costs.updatedAt = new Date().toISOString()
            writeJson(file, costs)
          }

          let source: string
          if (usage && callSession) {
            // Native path: real, OpenCode-computed cost. Report the delta since we
            // last observed this session so cumulative cost is never double-counted.
            const snaps = readSnapshots(snapshotsFile) ?? { sessionId: basename(run), bySession: {} }
            const prev = snaps.bySession[callSession]
            // No prior baseline (e.g. a worker session created mid-run): attribute
            // the session's full cost, since it started at $0. When a baseline
            // exists (the sentinel, baselined in plan) attribute only the delta.
            const delta = prev
              ? Math.round((usage.cost - prev.lastCost) * 1e4) / 1e4
              : Math.round(usage.cost * 1e4) / 1e4
            snaps.bySession[callSession] = { lastCost: usage.cost, lastTokens: usage.tokens, timestamp: new Date().toISOString() }
            writeSnapshots(snapshotsFile, snaps)
            if (delta > 0) addToBucket(delta)
            source = `opencode session ${callSession}`
          } else if (typeof input?.addUsd === "number" && Number.isFinite(input.addUsd)) {
            if (input.addUsd < 0) return { content: "Error: addUsd must be non-negative" }
            addToBucket(input.addUsd)
            source = "manual (client unavailable)"
          } else {
            source = "manual (client unavailable)"
          }

          const pct = budget ? Math.floor((costs.spentUsd / budget) * 100) : 0
          const warn = pct >= 80 ? `\n⚠ ${pct}% of budget used — halt non-essential workers and ask the user.` : ""
          const taskBreakdown = Object.entries(costs.byTask).map(([k, v]) => `    ${k}: $${v}`).join("\n")
          return {
            content: `Budget: $${budget} · spent: $${costs.spentUsd} (${pct}%)${warn}${taskBreakdown ? `\nPer-task:\n${taskBreakdown}` : ""}\n(source: ${source})`,
            shouldHalt: pct >= 80,
            pct,
          }
        })
      },
    })

    editor.add({
      name: "budget",
      description:
        "Preflight the run budget BEFORE teamwork_plan. Detects whether the session uses opencode/ (managed) models and whether the opencode_console MCP is connected. When both hold, tells the caller to fetch credits via opencode_console_get_usage and pass a full/partial budgetUsd to teamwork_plan. Otherwise, use the default budget.",
      input: { type: "object", properties: {}, additionalProperties: false },
      execute: async (_input: any, context: any) => {
        const consoleOnline = await isConsoleMcpConnected(ctx)
        const opencodeModel = await usesOpencodeModel(ctx, context?.sessionID)
        if (consoleOnline && opencodeModel) {
          return {
            content: [
              "Budget preflight: opencode/ (managed) models detected AND opencode_console is connected.",
              "1. Call opencode_console_get_usage to read your budgets.",
              "2. remaining = min over budgets of (limitDollars - spentDollars).",
              "3. ASK THE USER: use the FULL remaining budget, or PARTIAL (half)?",
              "4. Pass the chosen budgetUsd to teamwork_plan.",
              "budgetSource: credits",
            ].join("\n"),
            applyCredits: true,
          }
        }
        return {
          content: `Budget preflight: console-credit budgeting does not apply (consoleOnline=${consoleOnline}, opencodeModel=${opencodeModel}). Use the default budget.`,
          applyCredits: false,
        }
      },
    })

    editor.add({
      name: "pitfall",
      description: "Append an answer-agnostic failure mode to the run's pitfall registry.",
      input: {
        type: "object",
        properties: { sessionId: { type: "string" }, round: { type: "number" }, taskId: { type: "string" }, pitfall: { type: "string" } },
        required: ["pitfall"],
        additionalProperties: false,
      },
      execute: async (input: any) => {
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string
        const file = join(run, "pitfalls.md")
        refuseSymlink(file)
        const line = `- [round ${Number(input.round) || "?"}] ${clean(input.pitfall, 200)}${input.taskId ? ` — seen in ${clean(input.taskId, 64)}` : ""}\n`
        appendFileSync(file, line)
        return { content: `Logged pitfall: ${line.trim()}` }
      },
    })
  })
}

export async function registerTeamworkHooks(ctx: any, root: string) {
  // Fail-closed: if the permission API is unavailable we refuse to load rather
  // than silently dropping the read-only guardrail.
  if (typeof ctx?.permission?.hook !== "function") {
    throw new Error("teamwork: permission API unavailable — refusing to load without the read-only guardrail")
  }

  // Read-only guarantee for critic/verifier agents, enforced in code.
  await ctx.permission.hook("evaluate", (event: any) => {
    const deny = READ_ONLY_ACTIONS[event.agent]
    if (deny && deny.has(event.action)) {
      event.effect = "deny"
      event.message = `${event.agent} is read-only during a Teamwork run (${event.action} denied).`
    }
  })

  // Inject the active run's (sanitised) state into every team agent's context.
  await ctx.session?.hook?.("context", (event: any) => {
    if (typeof event.agent === "string" && event.agent.startsWith("team/")) {
      const text = describeRun(root)
      if (text) event.system.push({ type: "text", text })
    }
  })
}
