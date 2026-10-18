// opencode-teamwork-v2 — diagnostic engine
//
// Dependency-free health check shared by the `opencode-teamwork doctor` CLI and
// the plugin. It inspects the resolved OpenCode config directory, the installed
// `team/*` agents, the model map and the local git/worktree environment and
// returns a stable, ordered report:
//
//   { ok, checks: [{ name, status: "pass"|"warn"|"fail", message }] }
//
// The seven check names and their order are a fixed contract — never omit,
// rename or reorder them. `ok` is true only when no check failed.
//
// Nothing here mutates state or calls process.exit(); exit codes are the CLI's
// job. Shell probes go through execFileSync with a fixed argv array and never
// interpolate a shell string (see SECURITY notes below).

import { existsSync, readFileSync, realpathSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"
import { execFileSync } from "node:child_process"
import {
  TEAM_AGENTS,
  resolveConfigDir,
  findConfigFile,
  stripJsonComments,
  readModelFromFile,
  readRawModelMap,
  modelMapPath,
} from "./team.mjs"

/** The stable, ordered set of check names reported by runDoctor(). */
export const CHECK_NAMES = [
  "config_file",
  "plugin_registration",
  "agents_installed",
  "model_sync",
  "git_installed",
  "git_repository",
  "worktrees_dir",
]

// --- path safety ------------------------------------------------------------
//
// Every file we touch must stay inside the resolved config dir. Paths are
// always built with resolve()/join() from a trusted root and then verified with
// a relative() containment test so `..` traversal cannot escape. When the
// target exists we additionally compare realpath()s to reject symlink escapes.

/** True when `target` is `root` itself or nested inside it (both absolute). */
function isWithin(root, target) {
  const rel = relative(root, target)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/** Resolve `segments` under `root`, returning undefined if it escapes root. */
function containedJoin(root, ...segments) {
  const base = resolve(root)
  const target = resolve(base, ...segments)
  return isWithin(base, target) ? target : undefined
}

/**
 * existsSync for a path that must remain inside `root`. When the path exists we
 * resolve symlinks and re-check containment so a symlinked agent file cannot
 * point outside the config dir.
 */
function safeExists(file, root) {
  if (!file) return false
  try {
    const realFile = realpathSync(file)
    const realRoot = realpathSync(root)
    return isWithin(realRoot, realFile) && existsSync(realFile)
  } catch {
    // Missing path (or missing root): fall back to a plain existence check.
    return existsSync(file)
  }
}

// --- individual checks ------------------------------------------------------

function checkConfigFile({ configDir }) {
  const file = findConfigFile(configDir)
  if (file) return { status: "pass", message: `Found ${file}` }
  return {
    status: "warn",
    message: `No opencode.json(c) in ${configDir} — it would be created on next install`,
  }
}

function isTeamworkEntry(entry) {
  const value = typeof entry === "string" ? entry : entry && typeof entry === "object" ? entry.package : undefined
  return typeof value === "string" && value.includes("opencode-teamwork")
}

function checkPluginRegistration({ configDir }) {
  const file = findConfigFile(configDir)
  if (!file) {
    return { status: "warn", message: `No config file in ${configDir} — plugin not registered yet` }
  }

  let raw
  try {
    raw = readFileSync(file, "utf8")
  } catch (error) {
    return { status: "warn", message: `Could not read ${file}: ${error?.message || error}` }
  }

  let data
  try {
    data = JSON.parse(stripJsonComments(raw))
  } catch (error) {
    return { status: "warn", message: `Could not parse ${file}: ${error?.message || error}` }
  }

  const plugins = Array.isArray(data?.plugins) ? data.plugins : []
  const entry = plugins.find(isTeamworkEntry)
  if (entry !== undefined) {
    return { status: "pass", message: `Plugin registered in ${file}` }
  }
  return { status: "warn", message: `${file} does not register an opencode-teamwork plugin` }
}

function checkAgentsInstalled({ configDir }) {
  const targetDir = containedJoin(configDir, "agents", "team")
  const missing = []
  for (const agent of TEAM_AGENTS) {
    const file = targetDir ? containedJoin(targetDir, agent.file) : undefined
    if (!safeExists(file, configDir)) missing.push(agent.id)
  }

  if (!missing.length) {
    return { status: "pass", message: `All ${TEAM_AGENTS.length} team agents installed in ${targetDir}` }
  }
  return {
    status: "fail",
    message: `Missing ${missing.length}/${TEAM_AGENTS.length} agents: ${missing.join(", ")}`,
  }
}

function checkModelSync({ configDir }) {
  const raw = readRawModelMap(configDir)
  const entries = Object.entries(raw).filter(([, value]) => value)
  if (!existsSync(modelMapPath(configDir)) || !entries.length) {
    return { status: "pass", message: "No teamwork.json overrides to compare" }
  }

  const targetDir = containedJoin(configDir, "agents", "team")
  const disagreeing = []
  for (const [id, expected] of entries) {
    const agent = TEAM_AGENTS.find((a) => a.id === id)
    if (!agent || !targetDir) continue
    const file = containedJoin(targetDir, agent.file)
    if (!safeExists(file, configDir)) continue
    const actual = readModelFromFile(file)
    if (actual !== expected) {
      disagreeing.push(`${id} (file: ${actual || "none"}, teamwork.json: ${expected})`)
    }
  }

  if (!disagreeing.length) {
    return { status: "pass", message: `teamwork.json matches installed agents (${entries.length} entries)` }
  }
  return {
    status: "warn",
    message: `Model mismatch for ${disagreeing.length} agent(s): ${disagreeing.join("; ")}`,
  }
}

// SECURITY: the only shell probe allowed here. Fixed argv, no shell, no
// interpolation, no user input — `git --version` and nothing else.
function checkGitInstalled() {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" })
    return { status: "pass", message: "git is available on PATH" }
  } catch {
    return { status: "fail", message: "git was not found on PATH" }
  }
}

// SECURITY: same discipline as checkGitInstalled — execFileSync + fixed argv.
function checkGitRepository({ cwd }) {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, stdio: "ignore" })
    return { status: "pass", message: `${cwd} is inside a git work tree` }
  } catch {
    return { status: "warn", message: `${cwd} is not inside a git work tree` }
  }
}

function checkWorktreesDir({ cwd }) {
  const configured = process.env.TEAMWORK_WORKTREES_DIR
  let dir
  try {
    dir = configured ? resolve(configured) : resolve(cwd, "..", ".teamwork-worktrees")
  } catch (error) {
    return { status: "warn", message: `Could not resolve worktrees directory: ${error?.message || error}` }
  }
  if (!dir) return { status: "warn", message: "Could not resolve worktrees directory" }

  const exists = existsSync(dir)
  const source = configured ? " (from TEAMWORK_WORKTREES_DIR)" : ""
  return {
    status: "pass",
    message: `${dir}${source} — ${exists ? "exists" : "will be created on first run"}`,
  }
}

const PROBES = {
  config_file: checkConfigFile,
  plugin_registration: checkPluginRegistration,
  agents_installed: checkAgentsInstalled,
  model_sync: checkModelSync,
  git_installed: checkGitInstalled,
  git_repository: checkGitRepository,
  worktrees_dir: checkWorktreesDir,
}

/**
 * Run every diagnostic check and return the stable report object.
 *
 * @param {{ configDir?: string, cwd?: string }} [options]
 * @returns {{ ok: boolean, checks: Array<{ name: string, status: "pass"|"warn"|"fail", message: string }> }}
 */
export function runDoctor({ configDir, cwd } = {}) {
  const resolvedConfigDir = resolve(configDir || resolveConfigDir())
  const resolvedCwd = resolve(cwd || process.cwd())
  const context = { configDir: resolvedConfigDir, cwd: resolvedCwd }

  const checks = CHECK_NAMES.map((name) => {
    try {
      const result = PROBES[name](context)
      return { name, status: result.status, message: result.message }
    } catch (error) {
      // A probe must never take down the whole runner.
      return { name, status: "warn", message: `probe threw: ${error?.message || error}` }
    }
  })

  return { ok: checks.every((check) => check.status !== "fail"), checks }
}

/** Render a report as a plain-text table suitable for the CLI. */
export function formatDoctorReport(report) {
  const lines = []
  for (const check of report.checks) {
    const tag = check.status === "pass" ? "PASS" : check.status === "warn" ? "WARN" : "FAIL"
    lines.push(`[${tag}] ${check.name.padEnd(20)} ${check.message}`)
  }
  lines.push(report.ok ? "\nAll checks passed." : "\nOne or more checks failed.")
  return lines.join("\n")
}
