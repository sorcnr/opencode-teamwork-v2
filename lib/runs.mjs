// lib/runs.mjs — Teamwork run management & inspection helpers
//
// Shared by CLI commands (opencode-teamwork runs/inspect/prune) and tests.
// Zero runtime dependencies.

import { existsSync, readdirSync, readFileSync, lstatSync, rmSync } from "node:fs"
import { join, basename } from "node:path"
import { execFileSync } from "node:child_process"

const SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/

function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return fallback
  }
}

export function listTeamworkRuns(projectRoot = process.cwd()) {
  const dir = join(projectRoot, ".opencode", "teamwork")
  if (!existsSync(dir)) return []

  try {
    return readdirSync(dir)
      .filter((name) => SESSION_ID.test(name))
      .map((name) => {
        const runDir = join(dir, name)
        let mtime = 0
        try {
          mtime = lstatSync(runDir).mtimeMs
        } catch {}

        const state = readJson(join(runDir, "state.json"), {})
        const plan = readJson(join(runDir, "plan.dag.json"), {})
        const costs = readJson(join(runDir, "costs.json"), {})
        const audit = readJson(join(runDir, "verify", "security-audit.json"), undefined)

        const tasks = state.tasks ? Object.values(state.tasks) : []
        const totalTasks = plan.tasks ? plan.tasks.length : tasks.length
        const passedTasks = tasks.filter((t) => t?.status === "pass" || t?.status === "verified_pass").length
        const blockedTasks = tasks.filter((t) => t?.status === "blocked").length

        let securityStatus = "N/A"
        if (audit) {
          securityStatus = audit.status === "PASS" ? "PASS" : `FAIL (${(audit.severityCounts?.critical || 0) + (audit.severityCounts?.high || 0)} high/crit)`
        } else if (state.phase === "SECURITY_AUDIT") {
          securityStatus = "IN_PROGRESS"
        }

        const spent = Number(costs.spentUsd) || 0
        const budget = typeof costs.budgetUsd === "number" ? costs.budgetUsd : 20

        return {
          sessionId: name,
          path: runDir,
          phase: state.phase || "UNKNOWN",
          topology: plan.topology || "unknown",
          tasksPassed: passedTasks,
          tasksBlocked: blockedTasks,
          tasksTotal: totalTasks,
          securityStatus,
          spentUsd: spent,
          budgetUsd: budget,
          updatedAt: state.updatedAt || new Date(mtime).toISOString(),
          mtime,
        }
      })
      .sort((a, b) => b.mtime - a.mtime)
  } catch {
    return []
  }
}

export function inspectTeamworkRun(projectRoot = process.cwd(), sessionId = undefined) {
  const runs = listTeamworkRuns(projectRoot)
  if (!runs.length) return { error: "No Teamwork runs found." }

  const target = sessionId ? runs.find((r) => r.sessionId === sessionId) : runs[0]
  if (!target) return { error: `Run "${sessionId}" not found.` }

  const runDir = target.path
  const state = readJson(join(runDir, "state.json"), {})
  const plan = readJson(join(runDir, "plan.dag.json"), {})
  const costs = readJson(join(runDir, "costs.json"), {})
  const audit = readJson(join(runDir, "verify", "security-audit.json"), undefined)

  let pitfalls = []
  try {
    const pitFile = join(runDir, "pitfalls.md")
    if (existsSync(pitFile)) {
      pitfalls = readFileSync(pitFile, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("-"))
    }
  } catch {}

  let conflicts = []
  try {
    const synDir = join(runDir, "synthesis")
    if (existsSync(synDir)) {
      conflicts = readdirSync(synDir)
        .filter((f) => f.startsWith("conflict-") && f.endsWith(".json"))
        .map((f) => readJson(join(synDir, f), { file: f }))
    }
  } catch {}

  return {
    run: target,
    tasks: state.tasks || {},
    planTasks: plan.tasks || [],
    costs,
    audit,
    pitfalls,
    conflicts,
  }
}

export function pruneTeamworkWorktrees(projectRoot = process.cwd(), options = {}) {
  const base = process.env.TEAMWORK_WORKTREES_DIR || join(projectRoot, "..", ".teamwork-worktrees")
  if (!existsSync(base)) return { count: 0, removed: [] }

  const execGit = (args) => {
    try {
      return execFileSync("git", args, { cwd: projectRoot, encoding: "utf8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"] }).trim()
    } catch {
      return ""
    }
  }

  const removed = []
  try {
    const entries = readdirSync(base)
    for (const entry of entries) {
      if (!SESSION_ID.test(entry)) continue
      if (options.sessionId && entry !== options.sessionId) continue

      const entryPath = join(base, entry)
      if (!options.all && !options.sessionId) {
        // If neither --all nor specific --session is set, check if run is done
        const stateFile = join(projectRoot, ".opencode", "teamwork", entry, "state.json")
        const state = readJson(stateFile, {})
        const isFinished = ["MERGE", "DONE", "PRESENT_PARTIAL"].includes(state.phase)
        if (!isFinished) continue
      }

      try {
        const subdirs = readdirSync(entryPath)
        for (const sub of subdirs) {
          const subPath = join(entryPath, sub)
          execGit(["worktree", "remove", "--force", subPath])
        }
      } catch {}

      try {
        rmSync(entryPath, { recursive: true, force: true })
        removed.push(entry)
      } catch {}
    }
    execGit(["worktree", "prune"])
  } catch {}

  return { count: removed.length, removed }
}
