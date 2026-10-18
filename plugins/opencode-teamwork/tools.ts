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

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync, appendFileSync, renameSync, rmSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { homedir } from "node:os"
import { execFileSync } from "node:child_process"

// ---------------------------------------------------------------------------
// OpenCode native cost tracking
//
// Total consumption is computed exactly from OpenCode across the entire
// session tree: the root Sentinel session + all spawned child/subagent
// sessions (workers, verifiers, scouts, challengers, etc.).
//
// We discover OpenCode session trees via three redundant channels:
//   1. OpenCode SQLite database (`session_v2` recursive query) via `node:sqlite`
//   2. OpenCode SQLite database via `sqlite3` CLI
//   3. OpenCode background service API (`GET /api/session?parentID=...`)
//   4. Native client fallback (`ctx.session.get({ sessionID })`)
//
// We snapshot cumulative cost per session and report deltas, ensuring a run's
// spend is measured honestly — never self-reported or lost if a worker halts.
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
  agent?: string
  timestamp: string
}

interface SnapshotsFile {
  sessionId: string
  rootSessionIds?: string[]
  bySession: Record<string, SessionSnapshot>
}

interface SessionUsageItem {
  id: string
  parentId?: string
  agent?: string
  cost: number
  tokens: TokenUsage
}

interface TreeUsageResult {
  sessions: SessionUsageItem[]
  source: string
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
    if (!Array.isArray(parsed.rootSessionIds)) parsed.rootSessionIds = []
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

function getOpencodeDbPath(): string | undefined {
  const candidates: string[] = []
  if (process.env.XDG_DATA_HOME) {
    candidates.push(join(process.env.XDG_DATA_HOME, "opencode", "opencode.db"))
  }
  const home = homedir()
  candidates.push(join(home, ".local", "share", "opencode", "opencode.db"))
  candidates.push(join(home, "Library", "Application Support", "opencode", "opencode.db"))
  if (process.env.LOCALAPPDATA) {
    candidates.push(join(process.env.LOCALAPPDATA, "opencode", "opencode.db"))
  }
  candidates.push(join(home, "AppData", "Local", "opencode", "opencode.db"))
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p
    } catch {}
  }
  return undefined
}

function getOpencodeService(): { url: string; auth: string } | undefined {
  const candidates: string[] = []
  if (process.env.XDG_STATE_HOME) {
    candidates.push(join(process.env.XDG_STATE_HOME, "opencode", "service.json"))
  }
  const home = homedir()
  candidates.push(join(home, ".local", "state", "opencode", "service.json"))
  candidates.push(join(home, "Library", "Application Support", "opencode", "service.json"))
  if (process.env.LOCALAPPDATA) {
    candidates.push(join(process.env.LOCALAPPDATA, "opencode", "service.json"))
  }
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        const raw = JSON.parse(readFileSync(p, "utf8"))
        if (raw?.url) {
          const auth = "Basic " + Buffer.from(`opencode:${raw.password ?? ""}`).toString("base64")
          return { url: raw.url, auth }
        }
      }
    } catch {}
  }
  return undefined
}

async function fetchServiceTree(url: string, auth: string, rootIds: string[]): Promise<SessionUsageItem[] | undefined> {
  const sessions: SessionUsageItem[] = []
  const seen = new Set<string>()
  const queue: string[] = [...rootIds]

  for (const rootId of rootIds) {
    if (seen.has(rootId)) continue
    seen.add(rootId)
    try {
      const res = await fetch(`${url}/api/session/${encodeURIComponent(rootId)}`, {
        headers: { Authorization: auth },
        signal: AbortSignal.timeout(3000),
      })
      if (res.ok) {
        const json: any = await res.json()
        const s = json?.data
        if (s && typeof s.cost === "number") {
          sessions.push({
            id: s.id,
            parentId: s.parentID,
            agent: s.agent,
            cost: s.cost,
            tokens: normalizeTokens(s.tokens),
          })
        }
      }
    } catch {}
  }

  while (queue.length > 0) {
    const parentId = queue.shift()!
    try {
      const res = await fetch(`${url}/api/session?parentID=${encodeURIComponent(parentId)}`, {
        headers: { Authorization: auth },
        signal: AbortSignal.timeout(3000),
      })
      if (res.ok) {
        const json: any = await res.json()
        const children = Array.isArray(json?.data) ? json.data : []
        for (const c of children) {
          if (c?.id && !seen.has(c.id)) {
            seen.add(c.id)
            queue.push(c.id)
            sessions.push({
              id: c.id,
              parentId: c.parentID,
              agent: c.agent,
              cost: Number(c.cost) || 0,
              tokens: normalizeTokens(c.tokens),
            })
          }
        }
      }
    } catch {}
  }

  return sessions.length ? sessions : undefined
}

/**
 * Read the real cumulative cost + tokens for an OpenCode session tree (root +
 * all child/subagent sessions).
 */
async function readSessionTreeUsage(
  ctx: any,
  rootIds: string[],
  fallbackSessionId?: string,
): Promise<TreeUsageResult | undefined> {
  const safeIds = Array.from(new Set([...rootIds, ...(fallbackSessionId ? [fallbackSessionId] : [])])).filter(
    (id) => typeof id === "string" && /^[0-9A-Za-z_.-]+$/.test(id),
  )
  if (!safeIds.length) return undefined

  // 1. Try local SQLite database (node:sqlite)
  const dbPath = getOpencodeDbPath()
  if (dbPath) {
    try {
      const { DatabaseSync } = await import("node:sqlite")
      const db = new DatabaseSync(dbPath, { readOnly: true })
      const placeholders = safeIds.map(() => "?").join(", ")
      const stmt = db.prepare(`
        WITH RECURSIVE tree AS (
          SELECT id, parent_id, agent, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write
          FROM session_v2 WHERE id IN (${placeholders})
          UNION ALL
          SELECT s.id, s.parent_id, s.agent, s.cost, s.tokens_input, s.tokens_output, s.tokens_reasoning, s.tokens_cache_read, s.tokens_cache_write
          FROM session_v2 s JOIN tree t ON s.parent_id = t.id
        )
        SELECT id, parent_id, agent, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write FROM tree;
      `)
      const rows = stmt.all(...safeIds)
      db.close()
      if (rows && rows.length > 0) {
        return {
          sessions: rows.map((r: any) => ({
            id: String(r.id),
            parentId: r.parent_id ? String(r.parent_id) : undefined,
            agent: r.agent ? String(r.agent) : undefined,
            cost: Number(r.cost) || 0,
            tokens: {
              input: Number(r.tokens_input) || 0,
              output: Number(r.tokens_output) || 0,
              reasoning: Number(r.tokens_reasoning) || 0,
              cache: { read: Number(r.tokens_cache_read) || 0, write: Number(r.tokens_cache_write) || 0 },
            },
          })),
          source: "opencode database (node:sqlite)",
        }
      }
    } catch {}

    // 2. Try sqlite3 CLI fallback
    try {
      const inClause = safeIds.map((id) => `'${id}'`).join(", ")
      const sql = `
        WITH RECURSIVE tree AS (
          SELECT id, parent_id, agent, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write
          FROM session_v2 WHERE id IN (${inClause})
          UNION ALL
          SELECT s.id, s.parent_id, s.agent, s.cost, s.tokens_input, s.tokens_output, s.tokens_reasoning, s.tokens_cache_read, s.tokens_cache_write
          FROM session_v2 s JOIN tree t ON s.parent_id = t.id
        )
        SELECT id, coalesce(parent_id, ''), coalesce(agent, ''), cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write FROM tree;
      `
      const raw = execFileSync("sqlite3", [dbPath, "-separator", "\t", sql], { encoding: "utf8", timeout: 5000 })
      const lines = raw.trim().split("\n").filter(Boolean)
      if (lines.length > 0) {
        return {
          sessions: lines.map((line) => {
            const [id, parentId, agent, cost, inp, out, reas, cr, cw] = line.split("\t")
            return {
              id,
              parentId: parentId || undefined,
              agent: agent || undefined,
              cost: Number(cost) || 0,
              tokens: {
                input: Number(inp) || 0,
                output: Number(out) || 0,
                reasoning: Number(reas) || 0,
                cache: { read: Number(cr) || 0, write: Number(cw) || 0 },
              },
            }
          }),
          source: "opencode database (sqlite3 CLI)",
        }
      }
    } catch {}
  }

  // 3. Try OpenCode background service API
  const svc = getOpencodeService()
  if (svc) {
    try {
      const items = await fetchServiceTree(svc.url, svc.auth, safeIds)
      if (items && items.length > 0) {
        return {
          sessions: items,
          source: "opencode service API",
        }
      }
    } catch {}
  }

  // 4. Fallback to client ctx.session.get
  const fallbackSessions: SessionUsageItem[] = []
  for (const id of safeIds) {
    const u = await readSessionUsage(ctx, id)
    if (u) fallbackSessions.push({ id, cost: u.cost, tokens: u.tokens })
  }
  if (fallbackSessions.length > 0) {
    return {
      sessions: fallbackSessions,
      source: `opencode session ${safeIds[0]}`,
    }
  }

  return undefined
}

/**
 * Read cumulative cost + tokens for a single session from ctx.session.get.
 * Used for baselines or as a single-session fallback.
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

/** Reject if `p` does not settle within `ms`; the timer is always cleared. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms)
  })
  return Promise.race([p, guard]).finally(() => clearTimeout(timer))
}

/**
 * Best-effort actor lookup for the calling session. Fail-open: never throws and
 * never blocks longer than 2s. Order: the client's session.get agent, then the
 * agent recorded for that session in snapshots.json (same source as
 * bySession[*].agent). Returns undefined when neither is available.
 */
async function deriveCallerAgent(ctx: any, run: string, sessionID: string | undefined): Promise<string | undefined> {
  if (!sessionID) return undefined
  try {
    if (typeof ctx?.session?.get === "function") {
      const info: any = await withTimeout(Promise.resolve(ctx.session.get({ sessionID })), 2000)
      const a = typeof info?.agent === "string" ? clean(info.agent, 64).trim() : ""
      if (a) return a
    }
  } catch {}
  try {
    const a = readSnapshots(join(run, "snapshots.json"))?.bySession?.[sessionID]?.agent
    if (typeof a === "string") {
      const c = clean(a, 64).trim()
      if (c) return c
    }
  } catch {}
  return undefined
}

type TokenTotals = { input: number; output: number; reasoning: number; cache: { read: number; write: number } }

/** Non-negative integer, 0 for anything non-finite. */
function tokenInt(v: unknown): number {
  const n = Math.round(Number(v))
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * Add the token delta (cur - prev.lastTokens) of one session to
 * costs.byTaskTokens[bucket]. Mirrors the cost-delta baseline: no prior snapshot
 * means the full current total is the delta. A prior snapshot without
 * lastTokens cannot yield an honest delta, so it is skipped. An all-zero token
 * delta returns early WITHOUT touching either map, so byTaskTokens and byTask
 * key sets can diverge (a bucket can have spend and no token entry).
 * Both maps are null-prototype (see nullMap) so no bucket name collides.
 */
function accumulateTokenDelta(costs: any, bucket: string, cur: TokenTotals | undefined, prev: any) {
  if (!cur || typeof cur !== "object") return
  if (prev && !prev.lastTokens) return
  const base: any = prev ? prev.lastTokens : undefined
  const d = {
    input: tokenInt(cur.input) - tokenInt(base?.input),
    output: tokenInt(cur.output) - tokenInt(base?.output),
    reasoning: tokenInt(cur.reasoning) - tokenInt(base?.reasoning),
    cache: {
      read: tokenInt(cur.cache?.read) - tokenInt(base?.cache?.read),
      write: tokenInt(cur.cache?.write) - tokenInt(base?.cache?.write),
    },
  }
  const parts = [d.input, d.output, d.reasoning, d.cache.read, d.cache.write].map((x) => Math.max(0, x))
  if (parts.every((x) => x === 0)) return
  costs.byTaskTokens = nullMap(costs.byTaskTokens)
  costs.byTask = nullMap(costs.byTask)
  if (costs.byTask[bucket] === undefined) costs.byTask[bucket] = 0
  const b = costs.byTaskTokens[bucket]
  const cur2 = b && typeof b === "object" ? b : { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
  costs.byTaskTokens[bucket] = {
    input: tokenInt(cur2.input) + parts[0],
    output: tokenInt(cur2.output) + parts[1],
    reasoning: tokenInt(cur2.reasoning) + parts[2],
    cache: {
      read: tokenInt(cur2.cache?.read) + parts[3],
      write: tokenInt(cur2.cache?.write) + parts[4],
    },
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

/**
 * A task id is used as a single filesystem path segment (worktree dir, verifier
 * dir, report/conflict file names) and inside git branch names. Only allow a
 * conservative single-segment token. `clean()` is NOT sufficient: it keeps `/`
 * and `..`, which let `../../x` escape the worktrees base (SEC-1).
 */
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
function isSafeTaskId(id: string): boolean {
  return TASK_ID.test(id) && id !== "." && id !== ".."
}

/**
 * Lexical containment check: `child` must be a strict descendant of `parent`.
 * Returns an error string when it is not, `undefined` when it is safe.
 * Must be evaluated BEFORE any mkdir / rmSync / git worktree add on `child`.
 */
function containmentError(parent: string, child: string): string | undefined {
  const rel = relative(resolve(parent), resolve(child))
  if (!rel || isAbsolute(rel) || rel.startsWith("..")) {
    return "refused: target path escapes the worktrees base"
  }
  return undefined
}
const PHASES = new Set(["LOAD_SPEC", "WORKTREE_INIT", "DAG_BUILD", "DISPATCH", "SECURITY_AUDIT", "MERGE", "PRESENT_PARTIAL", "DONE"])

// Per-agent read-only policy, enforced in code. Keys are agent ids; values are
// the actions that agent may NOT perform. Anything not listed keeps its
// frontmatter permissions.
const READ_ONLY_ACTIONS: Record<string, Set<string>> = {
  // Real OpenCode permission actions only (see the V2 docs): edit covers the
  // write tool too, so "write"/"task" are intentionally not listed.
  "team/verifier": new Set(["edit", "webfetch", "subagent"]),
  "team/falsifier": new Set(["edit", "shell", "subagent"]),
  "team/scout": new Set(["edit", "subagent"]),
  "team/security-auditor": new Set(["edit", "webfetch", "subagent"]),
}

const pad = (n: number) => String(n).padStart(2, "0")

function newSessionId(): string {
  const d = new Date()
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const hex = Math.random().toString(16).slice(2, 6)
  return `${ts}-${hex}`
}

/**
 * Strip control characters (C0, DEL, C1 incl. U+0085) / line separators and cap
 * length. Never inject raw file text. Matches lib/timeline.mjs CONTROL_CHARS.
 * NOT a prototype-safety mechanism: task ids need the TASK_ID allowlist and
 * object-keyed state needs nullMap().
 */
function clean(value: unknown, max = 64): string {
  return String(value ?? "")
    .replace(/[\r\n\t\x00-\x1f\x7f-\x9f\u0085\u2028\u2029]/g, " ")
    .slice(0, max)
}

/**
 * Null-prototype copy of an object-keyed map (byTask, byTaskTokens, state.tasks).
 * With no prototype, no inherited member name (constructor, __proto__, ...) can
 * collide with a task/bucket key. Own keys are copied with [[Set]] onto a
 * null-prototype target, so a "__proto__" key becomes an ordinary own property.
 * JSON.stringify serialises the result exactly like a plain object.
 */
function nullMap<T = any>(src?: unknown): Record<string, T> {
  const out: Record<string, T> = Object.create(null)
  if (src && typeof src === "object" && !Array.isArray(src)) {
    for (const k of Object.keys(src as object)) out[k] = (src as Record<string, T>)[k]
  }
  return out
}

function runsDir(root: string) {
  return join(root, RUN_ROOT)
}

function readPitfalls(run: string, taskId?: string): string[] {
  try {
    const file = join(run, "pitfalls.md")
    if (!existsSync(file)) return []
    const content = readFileSync(file, "utf8")
    const lines = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("-"))
      .map((l) => clean(l.replace(/^-\s*/, ""), 200))
    if (!taskId) return lines
    const targetTag = `seen in ${clean(taskId, 64)}`
    return lines.filter((l) => !l.includes("seen in ") || l.includes(targetTag))
  } catch {
    return []
  }
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

/**
 * Append one lifecycle event to `<run>/events.jsonl` (append-only, one JSON
 * object per line). Fail-open: any error is swallowed so the DAG engine never
 * depends on the event log. Every string field is sanitised with clean() so no
 * value can inject a second physical line.
 */
async function appendEvent(
  run: string,
  ev: {
    event: "run_created" | "task_transition" | "security_audit"
    sessionId: string
    taskId?: string | null
    from?: string | null
    to: string
    round?: number
    agent?: string | null
    branch?: string | null
    worktree?: string | null
    phase?: string | null
  },
) {
  try {
    const eventsFile = join(run, "events.jsonl")
    await withFileLock(eventsFile, () => {
      refuseSymlink(eventsFile)
      const opt = (v: unknown, max: number) => (v === null || v === undefined || v === "" ? null : clean(v, max))
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        event: ev.event,
        sessionId: clean(ev.sessionId, 64),
        taskId: opt(ev.taskId, 64),
        from: opt(ev.from, 32),
        to: clean(ev.to, 32),
        round: Number(ev.round) || 0,
        agent: opt(ev.agent, 64),
        branch: opt(ev.branch, 120),
        worktree: opt(ev.worktree, 200),
        phase: opt(ev.phase, 32),
      })
      appendFileSync(eventsFile, line + "\n")
    })
  } catch {
    // fail-open: an events.jsonl write failure must never alter tool results
  }
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
  const pass = tasks.filter((t) => t?.status === "pass" || t?.status === "verified_pass").length
  const fail = tasks.filter((t) => t?.status === "fail" || t?.status === "verified_fail" || t?.status === "blocked").length
  const allPitfalls = readPitfalls(run)
  const pitfalls = allPitfalls.length
  const recentPitfalls = allPitfalls.slice(-2).map((p) => clean(p, 70))
  const pitfallSuffix = recentPitfalls.length ? ` (recent: ${recentPitfalls.join("; ")})` : ""
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
    `Tasks: ${pass}/${tasks.length} pass, ${fail} fail. Open pitfalls: ${pitfalls}${pitfallSuffix}.`,
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
        // SEC-1: task ids become keys of state/costs maps and path/branch segments.
        // Refuse the whole plan (before anything is written) on any unsafe id.
        for (const t of input.tasks || []) {
          const ids = [t?.id, ...(Array.isArray(t?.dependsOn) ? t.dependsOn : [])]
          const i = ids.findIndex((id: unknown) => typeof id !== "string" || !isSafeTaskId(id))
          if (i !== -1) {
            return { content: `refused: invalid task id "${clean(ids[i], 32)}" (must be a single segment matching ${TASK_ID})` }
          }
        }
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
            tasks: nullMap(Object.fromEntries(tasks.map((t: any) => [t.id, { status: "pending", round: 0 }]))),
            updatedAt: new Date().toISOString(),
          })
        }
        // Use ?? (nullish coalescing) so budgetUsd: 0 is respected as "no budget"
        const budget = input.budgetUsd ?? 20
        const costsFile = join(run, "costs.json")
        const callSession = typeof context?.sessionID === "string" ? context.sessionID : undefined
        // Same lock as the cost tool so a re-plan cannot race a concurrent cost call.
        await withFileLock(costsFile, async () => {
          const existing = readJson<any>(costsFile, undefined)
          if (!existing) {
            writeJson(costsFile, {
              sessionId,
              rootSessionIds: callSession ? [callSession] : [],
              budgetUsd: budget,
              budgetSource: input.budgetSource ? clean(input.budgetSource, 32) : "default",
              spentUsd: 0,
              byTask: nullMap(),
              byTaskTokens: nullMap(),
              updatedAt: new Date().toISOString(),
            })
          } else {
            existing.byTaskTokens = nullMap(existing.byTaskTokens)
            existing.byTask = nullMap(existing.byTask)
            if (callSession) {
              const currentRoots = Array.isArray(existing.rootSessionIds) ? existing.rootSessionIds : []
              if (!currentRoots.includes(callSession)) {
                existing.rootSessionIds = [...currentRoots, callSession]
              }
            }
            if (
              existing.budgetUsd !== budget ||
              (input.budgetSource && existing.budgetSource !== clean(input.budgetSource, 32))
            ) {
              // Update the budget/source but PRESERVE accumulated spend and
              // per-task buckets (a re-plan must not wipe the run's measured cost).
              existing.budgetUsd = budget
              if (input.budgetSource) existing.budgetSource = clean(input.budgetSource, 32)
            }
            existing.updatedAt = new Date().toISOString()
            writeJson(costsFile, existing)
          }
          // Establish the native cost baseline for the calling session, preserving
          // any baselines already recorded for other sessions (merge, don't clobber).
          const now = new Date().toISOString()
          const snaps = readSnapshots(join(run, "snapshots.json")) ?? { sessionId, rootSessionIds: [], bySession: {} }
          snaps.sessionId = sessionId
          if (!snaps.rootSessionIds) snaps.rootSessionIds = []
          if (callSession && !snaps.rootSessionIds.includes(callSession)) {
            snaps.rootSessionIds.push(callSession)
          }
          const usage = await readSessionUsage(ctx, callSession)
          if (callSession && usage && !snaps.bySession[callSession]) {
            snaps.bySession[callSession] = { lastCost: usage.cost, lastTokens: usage.tokens, timestamp: now }
          }
          writeSnapshots(join(run, "snapshots.json"), snaps)
        })
        touch(join(run, "pitfalls.md"), "# Pitfalls\n\n_answer-agnostic failure modes; one per line_\n")
        await appendEvent(run, { event: "run_created", sessionId, taskId: null, from: null, to: "pending", round: 0, phase: "DAG_BUILD" })
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
        "Read the run budget and report real spend across the full session tree (Sentinel + all workers/verifiers). Uses OpenCode's native cost and token tracking; falls back to manual addUsd when client/db is unavailable. Warns at 80%.",
      input: { type: "object", properties: { sessionId: { type: "string" }, addUsd: { type: "number" }, taskId: { type: "string" } }, additionalProperties: false },
      execute: async (input: any, context: any) => {
        // SEC-1: the taskId becomes a costs.byTask key. Refuse unsafe ids (e.g.
        // "__proto__", "a/b") before any read or write.
        if (input?.taskId && (typeof input.taskId !== "string" || !isSafeTaskId(input.taskId))) {
          return { content: `refused: invalid task id "${clean(input.taskId, 32)}" (must be a single segment matching ${TASK_ID})` }
        }
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
          // Null-prototype maps (SEC-1): no bucket name can collide with an inherited member.
          costs.byTask = nullMap(costs.byTask)
          // Additive key: tolerate its absence in costs.json written before it existed.
          costs.byTaskTokens = nullMap(costs.byTaskTokens)
          const budget = costs.budgetUsd ?? 20

          const snaps = readSnapshots(snapshotsFile) ?? { sessionId: basename(run), rootSessionIds: [], bySession: {} }
          snaps.sessionId = basename(run)
          if (!snaps.rootSessionIds) snaps.rootSessionIds = []
          if (callSession && !snaps.rootSessionIds.includes(callSession)) {
            snaps.rootSessionIds.push(callSession)
          }
          if (Array.isArray(costs.rootSessionIds)) {
            for (const r of costs.rootSessionIds) {
              if (typeof r === "string" && !snaps.rootSessionIds.includes(r)) {
                snaps.rootSessionIds.push(r)
              }
            }
          }

          const addToBucket = (bucketName: string, amount: number) => {
            if (amount <= 0) return
            costs.byTask[bucketName] = Math.round(((costs.byTask[bucketName] || 0) + amount) * 1e4) / 1e4
          }

          const treeResult = await readSessionTreeUsage(ctx, snaps.rootSessionIds, callSession)
          let source: string

          if (treeResult && treeResult.sessions.length > 0) {
            const now = new Date().toISOString()
            const totalTokens: TokenUsage = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

            for (const s of treeResult.sessions) {
              const prev = snaps.bySession[s.id]
              const delta = prev
                ? Math.round((s.cost - prev.lastCost) * 1e4) / 1e4
                : Math.round(s.cost * 1e4) / 1e4

              snaps.bySession[s.id] = {
                lastCost: s.cost,
                lastTokens: s.tokens,
                agent: s.agent,
                timestamp: now,
              }

              let bucket: string
              if (s.id === callSession && input.taskId) {
                bucket = clean(input.taskId, 64)
              } else if (snaps.rootSessionIds.includes(s.id)) {
                bucket = input.taskId ? clean(input.taskId, 64) : "_sentinel"
              } else if (s.agent) {
                bucket = input.taskId ? clean(input.taskId, 64) : clean(s.agent, 64)
              } else {
                bucket = input.taskId ? clean(input.taskId, 64) : "_unattributed"
              }
              if (delta > 0) addToBucket(bucket, delta)
              accumulateTokenDelta(costs, bucket, s.tokens, prev)

              totalTokens.input += s.tokens.input
              totalTokens.output += s.tokens.output
              totalTokens.reasoning += s.tokens.reasoning
              totalTokens.cache.read += s.tokens.cache.read
              totalTokens.cache.write += s.tokens.cache.write
            }

            costs.spentUsd =
              Math.round(Object.values(costs.byTask).reduce((a: number, b: any) => a + (Number(b) || 0), 0) * 1e4) / 1e4
            costs.tokens = totalTokens
            costs.rootSessionIds = snaps.rootSessionIds
            costs.updatedAt = now
            writeJson(file, costs)
            writeSnapshots(snapshotsFile, snaps)
            source = `opencode session tree (${treeResult.sessions.length} sessions, via ${treeResult.source})`
          } else if (callSession) {
            const usage = await readSessionUsage(ctx, callSession)
            if (usage) {
              const now = new Date().toISOString()
              const prev = snaps.bySession[callSession]
              const delta = prev
                ? Math.round((usage.cost - prev.lastCost) * 1e4) / 1e4
                : Math.round(usage.cost * 1e4) / 1e4
              snaps.bySession[callSession] = { lastCost: usage.cost, lastTokens: usage.tokens, timestamp: now }
              const bucket = input.taskId ? clean(input.taskId, 64) : "_unattributed"
              if (delta > 0) addToBucket(bucket, delta)
              accumulateTokenDelta(costs, bucket, usage.tokens, prev)
              costs.spentUsd =
                Math.round(Object.values(costs.byTask).reduce((a: number, b: any) => a + (Number(b) || 0), 0) * 1e4) / 1e4
              costs.updatedAt = now
              writeJson(file, costs)
              writeSnapshots(snapshotsFile, snaps)
              source = `opencode session ${callSession}`
            } else if (typeof input?.addUsd === "number" && Number.isFinite(input.addUsd)) {
              if (input.addUsd < 0) return { content: "Error: addUsd must be non-negative" }
              const bucket = input.taskId ? clean(input.taskId, 64) : "_unattributed"
              addToBucket(bucket, input.addUsd)
              costs.spentUsd =
                Math.round(Object.values(costs.byTask).reduce((a: number, b: any) => a + (Number(b) || 0), 0) * 1e4) / 1e4
              costs.updatedAt = new Date().toISOString()
              writeJson(file, costs)
              source = "manual (client unavailable)"
            } else {
              source = "manual (client unavailable)"
            }
          } else if (typeof input?.addUsd === "number" && Number.isFinite(input.addUsd)) {
            if (input.addUsd < 0) return { content: "Error: addUsd must be non-negative" }
            const bucket = input.taskId ? clean(input.taskId, 64) : "_unattributed"
            addToBucket(bucket, input.addUsd)
            costs.spentUsd =
              Math.round(Object.values(costs.byTask).reduce((a: number, b: any) => a + (Number(b) || 0), 0) * 1e4) / 1e4
            costs.updatedAt = new Date().toISOString()
            writeJson(file, costs)
            source = "manual (client unavailable)"
          } else {
            source = "manual (client unavailable)"
          }

          const pct = budget ? Math.floor((costs.spentUsd / budget) * 100) : 0
          const warn = pct >= 80 ? `\n⚠ ${pct}% of budget used — halt non-essential workers and ask the user.` : ""
          // SEC-3: the bucket key is echoed to the caller, so it is sanitised too.
          const taskBreakdown = Object.entries(costs.byTask).map(([k, v]) => `    ${clean(k, 64)}: $${v}`).join("\n")
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

    editor.add({
      name: "next",
      description:
        "Determine the next actionable tasks in the DAG based on dependencies and current lifecycle states. Returns tasks ready for worker dispatch, tasks ready for verifier dispatch, in-progress tasks, or signals completion/deadlock.",
      input: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Teamwork session id (defaults to active run)." },
        },
        additionalProperties: false,
      },
      execute: async (input: any) => {
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string

        const plan = readJson<any>(join(run, "plan.dag.json"), undefined)
        const state = readJson<any>(join(run, "state.json"), undefined)
        if (!plan || !Array.isArray(plan.tasks)) {
          return { content: `No valid plan.dag.json found for run ${basename(run)}.` }
        }
        if (!state || typeof state.tasks !== "object") {
          return { content: `No valid state.json found for run ${basename(run)}.` }
        }

        const taskDefs = new Map<string, any>(plan.tasks.map((t: any) => [t.id, t]))
        const taskStates = nullMap<any>(state.tasks)

        const isPassed = (id: string) => {
          const s = taskStates[id]?.status
          return s === "verified_pass" || s === "pass"
        }

        const isBlocked = (id: string) => {
          const s = taskStates[id]?.status
          const r = Number(taskStates[id]?.round) || 0
          const maxR = Number(taskDefs.get(id)?.maxRounds) || 4
          return s === "blocked" || (s === "verified_fail" && r >= maxR) || (s === "fail" && r >= maxR)
        }

        const readyForWorker: any[] = []
        const readyForVerifier: any[] = []
        const inProgress: any[] = []
        const blockedTasks: any[] = []
        const passedTasks: any[] = []

        for (const [id, def] of taskDefs.entries()) {
          const st = taskStates[id] || { status: "pending", round: 0 }
          const status = st.status || "pending"
          const round = Number(st.round) || 0
          const maxRounds = Number(def.maxRounds) || 4
          const deps = Array.isArray(def.dependsOn) ? def.dependsOn : []

          if (isPassed(id)) {
            passedTasks.push({ id, status, round })
            continue
          }

          if (isBlocked(id)) {
            blockedTasks.push({ id, status, round, reason: "Max rounds exceeded or explicitly blocked" })
            continue
          }

          const blockedDep = deps.find(isBlocked)
          if (blockedDep) {
            blockedTasks.push({ id, status: "blocked", reason: `Dependency ${blockedDep} failed/blocked` })
            continue
          }

          const allDepsPassed = deps.every(isPassed)

          if (status === "worker_done") {
            readyForVerifier.push({
              id,
              agent: "team/verifier",
              branch: st.branch || `teamwork/${basename(run)}-${id}`,
              round,
              summary: st.summary,
            })
          } else if (status === "worker_active" || status === "verifier_active" || status === "running") {
            inProgress.push({
              id,
              status,
              round,
              branch: st.branch,
            })
          } else if (allDepsPassed && (status === "pending" || ((status === "verified_fail" || status === "fail") && round < maxRounds))) {
            const pitfalls = readPitfalls(run, id)
            readyForWorker.push({
              id,
              agent: def.agent || "team/worker",
              round: (status === "verified_fail" || status === "fail") ? round + 1 : (round || 1),
              maxRounds,
              requirements: def.requirements || [],
              dependsOn: deps,
              branch: st.branch || `teamwork/${basename(run)}-${id}`,
              feedback: st.feedback,
              avoidPitfalls: pitfalls,
            })
          }
        }

        if (passedTasks.length === taskDefs.size) {
          const auditFile = join(run, "verify", "security-audit.json")
          const audit = existsSync(auditFile) ? readJson<any>(auditFile, undefined) : undefined

          if (!audit || audit.status !== "PASS") {
            const auditFailed = audit && audit.status === "FAIL"
            if (state.phase !== "SECURITY_AUDIT" && !auditFailed) {
              state.phase = "SECURITY_AUDIT"
              writeJson(join(run, "state.json"), state)
            }

            if (auditFailed) {
              const crit = Number(audit?.severityCounts?.critical) || 0
              const high = Number(audit?.severityCounts?.high) || 0
              return {
                content: `BLOCKED_BY_SECURITY: All tasks passed functional verification, but security audit FAILED with ${crit} Critical and ${high} High findings.\nFix findings before final merge.\nReport: ${auditFile}`,
                status: "BLOCKED_BY_SECURITY",
                auditReport: auditFile,
                passedCount: passedTasks.length,
              }
            }

            return {
              content: `READY_FOR_SECURITY_AUDIT: All ${taskDefs.size} tasks passed functional verification and are merged into base.\nMandatory Security Gate: Dispatch team/security-auditor on sentinel worktree before final merge.\nRun teamwork_security_audit tool when audit completes.`,
              status: "READY_FOR_SECURITY_AUDIT",
              agent: "team/security-auditor",
              passedCount: passedTasks.length,
            }
          }

          if (state.phase !== "MERGE" && state.phase !== "DONE") {
            state.phase = "MERGE"
            writeJson(join(run, "state.json"), state)
          }

          return {
            content: `ALL_TASKS_PASSED: All ${taskDefs.size} tasks have passed verification and security audit PASSED. Ready to merge Sentinel base worktree to user branch and present final artifact.`,
            status: "ALL_PASSED",
            passedCount: passedTasks.length,
            securityAuditPassed: true,
          }
        }

        if (!readyForWorker.length && !readyForVerifier.length && !inProgress.length) {
          return {
            content: `DEADLOCK_OR_BLOCKED: No tasks can proceed.\nBlocked tasks (${blockedTasks.length}):\n` +
              blockedTasks.map((t) => `  - ${t.id}: ${t.reason}`).join("\n"),
            status: "DEADLOCK",
            blocked: blockedTasks,
          }
        }

        const lines = [`DAG Status for run ${basename(run)}:`]
        if (readyForWorker.length) {
          lines.push(`\n▶ READY FOR WORKER (${readyForWorker.length}): Dispatch worker subagent for each in parallel:`)
          for (const t of readyForWorker) {
            lines.push(`  - Task: ${t.id} (Agent: ${t.agent}, Round: ${t.round}/${t.maxRounds})`)
            lines.push(`    Branch: ${t.branch}`)
            if (t.feedback) lines.push(`    Verifier Feedback: ${clean(t.feedback, 120)}`)
            if (t.avoidPitfalls?.length) {
              lines.push(`    ⚠ Avoid Known Pitfalls: ${t.avoidPitfalls.slice(0, 3).map((p: string) => clean(p, 80)).join("; ")}`)
            }
          }
        }
        if (readyForVerifier.length) {
          lines.push(`\n▶ READY FOR VERIFIER (${readyForVerifier.length}): Dispatch verifier subagent against worker branch:`)
          for (const t of readyForVerifier) {
            lines.push(`  - Task: ${t.id} (Verifier: ${t.agent}, Branch: ${t.branch})`)
          }
        }
        if (inProgress.length) {
          lines.push(`\n⏳ IN PROGRESS (${inProgress.length}):`)
          for (const t of inProgress) {
            lines.push(`  - ${t.id}: ${t.status} (round ${t.round})`)
          }
        }
        lines.push(`\nProgress: ${passedTasks.length}/${taskDefs.size} passed, ${blockedTasks.length} blocked.`)

        return {
          content: lines.join("\n"),
          readyForWorker,
          readyForVerifier,
          inProgress,
          passedCount: passedTasks.length,
          totalTasks: taskDefs.size,
        }
      },
    })

    editor.add({
      name: "task_update",
      description:
        "Update a task's lifecycle status, round, branch, and verification report in state.json. Lifecycle: pending -> worker_active -> worker_done -> verifier_active -> verified_pass | verified_fail | blocked.",
      input: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          taskId: { type: "string", description: "The task ID defined in plan.dag.json." },
          status: {
            type: "string",
            description: "pending | worker_active | worker_done | verifier_active | verified_pass | verified_fail | blocked",
          },
          agent: {
            type: "string",
            description:
              "Optional. The actor that performed this transition (e.g. team/worker or team/verifier). Recorded in events.jsonl; when omitted the calling session's agent, then the plan-declared agent, is recorded.",
          },
          round: { type: "number" },
          branch: { type: "string" },
          worktree: { type: "string" },
          summary: { type: "string", description: "Short summary of what worker implemented." },
          feedback: { type: "string", description: "Feedback from verifier for the next worker round." },
          verification: {
            type: "object",
            properties: {
              status: { type: "string", description: "PASS | FAIL" },
              passedChecks: { type: "number" },
              totalChecks: { type: "number" },
              fatalFindings: { type: "array", items: { type: "string" } },
            },
          },
        },
        required: ["taskId", "status"],
        additionalProperties: false,
      },
      execute: async (input: any, context: any) => {
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string
        const stateFile = join(run, "state.json")
        const planFile = join(run, "plan.dag.json")
        const callSession = typeof context?.sessionID === "string" ? context.sessionID : undefined

        const taskId = clean(input.taskId, 64)
        if (!taskId) return { content: "Error: taskId is required" }

        return await withFileLock(stateFile, async () => {
          const state = readJson<any>(stateFile, undefined)
          if (!state || typeof state.tasks !== "object") {
            return { content: `Error: No state.json found for run ${basename(run)}.` }
          }
          // SEC-1: null-prototype task map; existence is an OWN-property check, never truthiness.
          state.tasks = nullMap(state.tasks)
          const plan = readJson<any>(planFile, undefined)
          const def = Array.isArray(plan?.tasks) ? plan.tasks.find((t: any) => t.id === taskId) : undefined
          if (!def && !Object.prototype.hasOwnProperty.call(state.tasks, taskId)) {
            return { content: `Error: Task "${taskId}" not found in plan or state.` }
          }

          let status = clean(input.status, 32)
          if (status === "pass") status = "verified_pass"
          else if (status === "fail") status = "verified_fail"
          else if (status === "running") status = "worker_active"

          const VALID_STATUSES = new Set([
            "pending",
            "worker_active",
            "worker_done",
            "verifier_active",
            "verified_pass",
            "verified_fail",
            "blocked",
          ])
          if (!VALID_STATUSES.has(status)) {
            return { content: `Error: Invalid status "${status}". Allowed: ${Array.from(VALID_STATUSES).join(", ")}` }
          }

          const current = state.tasks[taskId] || { status: "pending", round: 0 }
          const fromStatus = typeof current.status === "string" ? current.status : "pending"
          const maxRounds = Number(def?.maxRounds) || 4
          let round = Number.isFinite(input.round) ? Number(input.round) : (Number(current.round) || 0)

          if (status === "worker_active" && !Number.isFinite(input.round)) {
            round = Math.max(1, (Number(current.round) || 0) + (current.status === "verified_fail" ? 1 : 0))
          }

          if ((status === "verified_fail" || status === "fail") && round >= maxRounds) {
            status = "blocked"
          }

          state.tasks[taskId] = {
            ...current,
            status,
            round,
            ...(input.branch ? { branch: clean(input.branch, 120) } : {}),
            ...(input.worktree ? { worktree: clean(input.worktree, 200) } : {}),
            ...(input.summary ? { summary: clean(input.summary, 300) } : {}),
            ...(input.feedback ? { feedback: clean(input.feedback, 500) } : {}),
            ...(input.verification ? { verification: input.verification } : {}),
            updatedAt: new Date().toISOString(),
          }

          const allTasks = Object.values(state.tasks) as any[]
          const allPassed = allTasks.every((t) => t.status === "verified_pass")
          const anyActive = allTasks.some((t) => t.status === "worker_active" || t.status === "verifier_active")
          if (allPassed) {
            const auditFile = join(run, "verify", "security-audit.json")
            const audit = existsSync(auditFile) ? readJson<any>(auditFile, undefined) : undefined
            state.phase = audit?.status === "PASS" ? "MERGE" : "SECURITY_AUDIT"
          } else if (!anyActive && allTasks.some((t) => t.status === "blocked")) {
            state.phase = "PRESENT_PARTIAL"
          }

          state.updatedAt = new Date().toISOString()
          writeJson(stateFile, state)

          // Actor precedence (best-effort, fail-open): explicit input.agent, then the
          // calling session's agent, then the plan-declared agent. clean() runs in appendEvent too.
          const explicitAgent = typeof input.agent === "string" ? clean(input.agent, 64).trim() : ""
          const callerAgent = explicitAgent ? undefined : await deriveCallerAgent(ctx, run, callSession)
          const planAgent = def?.agent ? clean(def.agent, 64) : undefined
          const recordedAgent = explicitAgent || callerAgent || planAgent || null

          // Log what actually landed in state.json (post-normalisation, post-coercion).
          await appendEvent(run, {
            event: "task_transition",
            sessionId: basename(run),
            taskId,
            from: fromStatus,
            to: status,
            round,
            agent: recordedAgent,
            branch: input.branch ?? current.branch ?? null,
            worktree: input.worktree ?? current.worktree ?? null,
            phase: state.phase ?? null,
          })

          return {
            // SEC-3: the branch is echoed to the caller, so it is sanitised like every other field.
            content: `Task ${taskId} updated: status=${status}, round=${round}${input.branch ? `, branch=${clean(input.branch, 120)}` : ""}${status === "blocked" ? " (BLOCKED: max rounds reached)" : ""}`,
            taskId,
            status,
            round,
          }
        })
      },
    })

    editor.add({
      name: "security_audit",
      description:
        "Record the findings of team/security-auditor and enforce the pre-merge security gate. Writes verify/security-audit.json. If Critical or High findings exist, marks status as FAIL and blocks final merge.",
      input: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          status: { type: "string", description: "PASS | FAIL" },
          findings: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                severity: { type: "string", description: "Critical | High | Medium | Low" },
                location: { type: "string" },
                description: { type: "string" },
              },
              required: ["severity", "description"],
            },
          },
          summary: { type: "string", description: "Summary of the security audit." },
        },
        required: ["status"],
        additionalProperties: false,
      },
      execute: async (input: any) => {
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string
        const verifyDir = join(run, "verify")
        mkdirSync(verifyDir, { recursive: true })
        const auditFile = join(verifyDir, "security-audit.json")

        const findings = Array.isArray(input.findings) ? input.findings : []
        const counts = {
          critical: findings.filter((f: any) => String(f.severity).toLowerCase() === "critical").length,
          high: findings.filter((f: any) => String(f.severity).toLowerCase() === "high").length,
          medium: findings.filter((f: any) => String(f.severity).toLowerCase() === "medium").length,
          low: findings.filter((f: any) => String(f.severity).toLowerCase() === "low").length,
        }

        let status = clean(input.status, 16).toUpperCase()
        if (counts.critical > 0 || counts.high > 0) {
          status = "FAIL"
        }

        const report = {
          sessionId: basename(run),
          status,
          timestamp: new Date().toISOString(),
          severityCounts: counts,
          summary: input.summary ? clean(input.summary, 500) : "",
          findings: findings.map((f: any) => ({
            id: clean(f.id || "", 32),
            severity: clean(f.severity, 16),
            location: clean(f.location || "", 120),
            description: clean(f.description, 300),
          })),
        }
        writeJson(auditFile, report)

        const stateFile = join(run, "state.json")
        const state = readJson<any>(stateFile, undefined)
        if (state) {
          if (status === "PASS") {
            state.phase = "MERGE"
          } else {
            // Append critical/high findings to pitfalls so they become known
            for (const f of findings) {
              if (["critical", "high"].includes(String(f.severity).toLowerCase())) {
                const line = `- [security] ${clean(f.severity, 16).toUpperCase()}: ${clean(f.description, 160)}${f.location ? ` at ${clean(f.location, 64)}` : ""}\n`
                appendFileSync(join(run, "pitfalls.md"), line)
              }
            }
          }
          state.updatedAt = new Date().toISOString()
          writeJson(stateFile, state)
        }

        await appendEvent(run, {
          event: "security_audit",
          sessionId: basename(run),
          to: status,
          phase: state?.phase ?? null,
        })

        if (status === "FAIL") {
          return {
            content: `SECURITY AUDIT FAILED: ${counts.critical} Critical, ${counts.high} High, ${counts.medium} Medium findings. Final merge is BLOCKED until remediated.\nReport saved to: ${auditFile}`,
            status: "FAIL",
            reportPath: auditFile,
          }
        }

        return {
          content: `SECURITY AUDIT PASSED: ${findings.length} findings (${counts.medium} Medium, ${counts.low} Low, 0 High/Critical). Final merge is APPROVED.\nReport saved to: ${auditFile}`,
          status: "PASS",
          reportPath: auditFile,
        }
      },
    })

    editor.add({
      name: "worktree",
      description:
        "Deterministic git worktree manager for Teamwork runs: setup, diff, merge, resolve, and cleanup. Prevents in-repo nesting and isolates worker branches.",
      input: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          action: {
            type: "string",
            description: "setup | diff | merge | resolve | cleanup",
          },
          role: {
            type: "string",
            description: "Role for setup action: sentinel | worker | verifier",
          },
          taskId: {
            type: "string",
            description: "Task ID (required for worker/verifier setup, diff, merge, and resolve)",
          },
          commitMessage: {
            type: "string",
            description: "Commit message for resolve action",
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
      execute: async (input: any) => {
        const resolved = resolveRun(root, input?.sessionId)
        if (resolved.error) return { content: resolved.error }
        const run = resolved.run as string
        const runId = basename(run)

        const action = clean(input.action, 16)
        // SEC-1: validate at the entry point, before any path or branch is built.
        // Raw value is checked (not clean()ed) so nothing is silently truncated.
        const rawTaskId = input.taskId ? String(input.taskId) : undefined
        if (rawTaskId !== undefined && !isSafeTaskId(rawTaskId)) {
          return { content: `refused: invalid task id "${clean(rawTaskId, 32)}" (must be a single segment matching ${TASK_ID})` }
        }
        const taskId = rawTaskId

        const worktreesBase = process.env.TEAMWORK_WORKTREES_DIR
          ? process.env.TEAMWORK_WORKTREES_DIR
          : join(root, "..", ".teamwork-worktrees")
        const runWorktreesDir = join(worktreesBase, runId)
        const baseBranch = `teamwork/base-${runId}`

        const execGit = (args: string[], cwd = root) => {
          try {
            return {
              stdout: execFileSync("git", args, { cwd, encoding: "utf8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"] }).trim(),
              code: 0,
            }
          } catch (e: any) {
            return {
              stdout: String(e.stdout ?? "").trim(),
              stderr: String(e.stderr ?? e.message ?? "").trim(),
              code: typeof e.status === "number" ? e.status : 1,
            }
          }
        }

        const isGit = execGit(["rev-parse", "--is-inside-work-tree"])
        if (isGit.code !== 0) {
          return { content: "Skipped worktree operation: current directory is not a git repository." }
        }

        if (action === "setup") {
          const role = clean(input.role || "worker", 16)
          let targetDir: string
          let branch: string

          if (role === "sentinel") {
            targetDir = join(runWorktreesDir, "sentinel")
            branch = baseBranch
            // SEC-1: containment must hold before ANY mkdir / rmSync / worktree add.
            const escape = containmentError(runWorktreesDir, targetDir)
            if (escape) return { content: escape }
            const branchExists = execGit(["rev-parse", "--verify", branch]).code === 0
            mkdirSync(dirname(targetDir), { recursive: true })
            if (existsSync(targetDir)) {
              const check = execGit(["rev-parse", "--is-inside-work-tree"], targetDir)
              if (check.code !== 0) {
                // rmSync only after re-proving containment (defence in depth).
                if (!containmentError(runWorktreesDir, targetDir)) {
                  try { rmSync(targetDir, { recursive: true, force: true }) } catch {}
                }
                execGit(["worktree", "prune"])
              }
            }
            if (!existsSync(targetDir)) {
              const res = branchExists
                ? execGit(["worktree", "add", targetDir, branch])
                : execGit(["worktree", "add", "-b", branch, targetDir])
              if (res.code !== 0) {
                return { content: `Error creating sentinel worktree: ${res.stderr || res.stdout}` }
              }
            }
            return {
              content: `Sentinel worktree ready at: ${targetDir}\nBranch: ${branch}`,
              worktreePath: targetDir,
              branch,
              baseBranch,
            }
          } else {
            if (!taskId) return { content: "Error: taskId is required for worker/verifier setup." }
            targetDir = join(runWorktreesDir, role === "verifier" ? `verifier-${taskId}` : taskId)
            branch = `teamwork/${runId}-${taskId}`
            // SEC-1: containment must hold before ANY mkdir / rmSync / worktree add.
            const escape = containmentError(runWorktreesDir, targetDir)
            if (escape) return { content: escape }

            const hasBase = execGit(["rev-parse", "--verify", baseBranch]).code === 0
            const startPoint = hasBase ? baseBranch : "HEAD"

            mkdirSync(dirname(targetDir), { recursive: true })
            if (existsSync(targetDir)) {
              const check = execGit(["rev-parse", "--is-inside-work-tree"], targetDir)
              if (check.code !== 0) {
                // rmSync only after re-proving containment (defence in depth).
                if (!containmentError(runWorktreesDir, targetDir)) {
                  try { rmSync(targetDir, { recursive: true, force: true }) } catch {}
                }
                execGit(["worktree", "prune"])
              }
            }
            if (!existsSync(targetDir)) {
              const branchExists = execGit(["rev-parse", "--verify", branch]).code === 0
              const res = branchExists
                ? execGit(["worktree", "add", targetDir, branch])
                : execGit(["worktree", "add", "-b", branch, targetDir, startPoint])
              if (res.code !== 0) {
                return { content: `Error creating ${role} worktree: ${res.stderr || res.stdout}` }
              }
            }
            return {
              content: `${role} worktree ready at: ${targetDir}\nBranch: ${branch}\nBase: ${startPoint}`,
              worktreePath: targetDir,
              branch,
              baseBranch: startPoint,
            }
          }
        }

        if (action === "diff") {
          if (!taskId) return { content: "Error: taskId is required for diff." }
          const branch = `teamwork/${runId}-${taskId}`
          const hasBranch = execGit(["rev-parse", "--verify", branch]).code === 0
          if (!hasBranch) {
            return { content: `Error: branch "${branch}" not found.` }
          }
          const hasBase = execGit(["rev-parse", "--verify", baseBranch]).code === 0
          const baseRef = hasBase ? baseBranch : "HEAD"
          const diffRes = execGit(["diff", `${baseRef}..${branch}`])
          const statRes = execGit(["diff", "--stat", `${baseRef}..${branch}`])

          return {
            content: `Diff for ${taskId} (${baseRef}..${branch}):\n${statRes.stdout || "No changes."}\n\n${diffRes.stdout || ""}`,
            hasChanges: diffRes.stdout.length > 0,
            stat: statRes.stdout,
          }
        }

        if (action === "merge") {
          if (!taskId) return { content: "Error: taskId is required for merge." }
          const branch = `teamwork/${runId}-${taskId}`
          const sentinelDir = join(runWorktreesDir, "sentinel")
          const targetCwd = existsSync(sentinelDir) ? sentinelDir : root

          const mergeRes = execGit(["merge", "--no-ff", branch, "-m", `Merge task ${taskId} (${branch})`], targetCwd)
          if (mergeRes.code !== 0) {
            const conflictingFiles = mergeRes.stdout
              .split("\n")
              .filter((l) => l.includes("CONFLICT"))
              .map((l) => clean(l.replace(/CONFLICT\s*\([^)]*\):\s*/, ""), 120))

            const oursDiff = execGit(["diff", `${branch}...${baseBranch}`], targetCwd).stdout
            const theirsDiff = execGit(["diff", `${baseBranch}...${branch}`], targetCwd).stdout

            execGit(["merge", "--abort"], targetCwd)

            const synDir = join(run, "synthesis")
            mkdirSync(synDir, { recursive: true })
            const conflictFile = join(synDir, `conflict-${taskId}.json`)
            const conflictArtifact = {
              taskId,
              sessionId: runId,
              baseBranch,
              incomingBranch: branch,
              conflictingFiles,
              diffOurs: oursDiff.slice(0, 10000),
              diffTheirs: theirsDiff.slice(0, 10000),
              timestamp: new Date().toISOString(),
            }
            writeJson(conflictFile, conflictArtifact)

            return {
              content: `MERGE CONFLICT for task ${taskId} into ${baseBranch}:\n${conflictingFiles.join("\n") || mergeRes.stderr || mergeRes.stdout}\n\nConflict artifact generated at: ${conflictFile}\n(Merge was aborted; worktree remains clean. Sentinel should dispatch team/synthesizer to resolve conflict.)`,
              conflict: true,
              conflictArtifact: conflictFile,
              conflictingFiles,
              output: mergeRes.stdout,
            }
          }

          return {
            content: `Successfully merged ${branch} into ${baseBranch}.\n${mergeRes.stdout}`,
            conflict: false,
            merged: true,
          }
        }

        if (action === "resolve") {
          if (!taskId) return { content: "Error: taskId is required for resolve." }
          const sentinelDir = join(runWorktreesDir, "sentinel")
          const targetCwd = existsSync(sentinelDir) ? sentinelDir : root
          const statusRes = execGit(["status", "--porcelain"], targetCwd)
          if (!statusRes.stdout) {
            return { content: `No modified files to commit for conflict resolution in ${sentinelDir}.` }
          }
          execGit(["add", "-A"], targetCwd)
          const commitMsg = clean(input.commitMessage || `Resolve merge conflict for task ${taskId}`, 200)
          const commitRes = execGit(["commit", "-m", commitMsg], targetCwd)
          return {
            content: `Committed conflict resolution for ${taskId}:\n${commitRes.stdout}`,
            resolved: true,
          }
        }

        if (action === "cleanup") {
          if (existsSync(runWorktreesDir)) {
            execGit(["worktree", "prune"])
            try {
              const entries = readdirSync(runWorktreesDir)
              for (const entry of entries) {
                const p = join(runWorktreesDir, entry)
                execGit(["worktree", "remove", "--force", p])
              }
            } catch {}
            execGit(["worktree", "prune"])
          }
          return {
            content: `Cleaned up worktrees for run ${runId} at ${runWorktreesDir}.`,
            cleaned: true,
          }
        }

        return { content: `Error: unknown action "${action}". Allowed: setup | diff | merge | resolve | cleanup` }
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

  // Read-only guarantee for critic/verifier/security-auditor agents, enforced in code.
  await ctx.permission.hook("evaluate", (event: any) => {
    const deny = READ_ONLY_ACTIONS[event.agent]
    if (deny && deny.has(event.action)) {
      event.effect = "deny"
      event.message = `${event.agent} is restricted during a Teamwork run (${event.action} denied).`
      return
    }

    // Network constraint enforcement for worker/verifier
    if (event.action === "webfetch" && (event.agent === "team/worker" || event.agent === "team/verifier")) {
      const { run } = resolveRun(root)
      if (run) {
        try {
          const specPath = join(run, "prompt_draft.md")
          if (existsSync(specPath)) {
            const specText = readFileSync(specPath, "utf8")
            if (/network:\s*["']?denied["']?/i.test(specText)) {
              event.effect = "deny"
              event.message = "Network access is denied by run spec constraints."
            }
          }
        } catch {}
      }
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
