// opencode-teamwork — Teamwork engine tools + hooks (V2 plugin API)
//
// Turns the mechanics that the prompts used to describe in prose (run dir,
// plan, state, cost, pitfalls, resume) into real tools, and uses hooks to
// enforce the read-only guarantee and to inject run context automatically.
//
// No OpenCode imports: tool definitions are plain objects, so the loader never
// has to resolve node_modules for this package.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from "node:fs"
import { dirname, join } from "node:path"

const RUN_ROOT = ".opencode/teamwork"
const READ_ONLY_AGENTS = new Set(["team/verifier", "team/falsifier", "team/scout"])

const pad = (n: number) => String(n).padStart(2, "0")

function newSessionId(): string {
  const d = new Date()
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const hex = Math.random().toString(16).slice(2, 6)
  return `${ts}-${hex}`
}

function runsDir(root: string) {
  return join(root, RUN_ROOT)
}

function listRuns(root: string) {
  const dir = runsDir(root)
  if (!existsSync(dir)) return [] as { name: string; path: string; mtime: number }[]
  return readdirSync(dir)
    .map((name) => {
      const path = join(dir, name)
      let mtime = 0
      try {
        mtime = statSync(path).mtimeMs
      } catch {}
      return { name, path, mtime }
    })
    .filter((e) => {
      try {
        return statSync(e.path).isDirectory()
      } catch {
        return false
      }
    })
    .sort((a, b) => b.mtime - a.mtime)
}

function resolveRun(root: string, sessionId?: string) {
  if (sessionId) return join(runsDir(root), sessionId)
  return listRuns(root)[0]?.path
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T
  } catch {
    return fallback
  }
}

function writeJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n")
}

function touch(file: string, content: string) {
  mkdirSync(dirname(file), { recursive: true })
  if (!existsSync(file)) writeFileSync(file, content)
}

/** Compact run summary injected into team agents' system prompt. */
export function describeRun(root: string): string | undefined {
  const run = resolveRun(root)
  if (!run) return undefined
  const state = readJson<any>(join(run, "state.json"), undefined)
  if (!state) return undefined
  const tasks = Object.values(state.tasks || {}) as any[]
  const pass = tasks.filter((t) => t.status === "pass").length
  const fail = tasks.filter((t) => t.status === "fail").length
  let pitfalls = 0
  try {
    pitfalls = readFileSync(join(run, "pitfalls.md"), "utf8").split("\n").filter((l) => l.trim().startsWith("-")).length
  } catch {}
  return [
    `[teamwork] active run ${state.sessionId} — phase ${state.phase}.`,
    `Tasks: ${pass}/${tasks.length} pass, ${fail} fail. Open pitfalls: ${pitfalls}.`,
    `State: ${join(run, "state.json")} (read it before dispatching).`,
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
        "Create a Teamwork run directory and write plan.dag.json + state.json + costs.json. Returns the run path. Call this once before dispatching workers.",
      input: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Reuse an existing session id; omit to create one." },
          topology: { type: "string", description: "small-focused | iterative-coding | distributed-coding | proof | massive-proof | document-review" },
          budgetUsd: { type: "number" },
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
      execute: async (input: any) => {
        const sessionId = input.sessionId || newSessionId()
        const run = join(runsDir(root), sessionId)
        mkdirSync(run, { recursive: true })
        const tasks = (input.tasks || []).map((t: any) => ({
          id: t.id,
          dependsOn: t.dependsOn || [],
          requirements: t.requirements || [],
          agent: t.agent || "team/worker",
          status: "pending",
          round: 0,
          maxRounds: t.maxRounds ?? 4,
        }))
        writeJson(join(run, "plan.dag.json"), { sessionId, topology: input.topology, tasks })
        if (!existsSync(join(run, "state.json"))) {
          writeJson(join(run, "state.json"), {
            version: 1,
            sessionId,
            phase: "DISPATCH",
            tasks: Object.fromEntries(tasks.map((t: any) => [t.id, { status: "pending", round: 0 }])),
            updatedAt: new Date().toISOString(),
          })
        }
        touch(join(run, "costs.json"), JSON.stringify({ sessionId, budgetUsd: input.budgetUsd ?? 20, spentUsd: 0, byTask: {}, updatedAt: new Date().toISOString() }, null, 2) + "\n")
        touch(join(run, "pitfalls.md"), "# Pitfalls\n\n_answer-agnostic failure modes; one per line_\n")
        return { content: `Planned ${tasks.length} task(s) for ${sessionId}.\nRun dir: ${run}\nplan.dag.json + state.json + costs.json written.` }
      },
    })

    editor.add({
      name: "status",
      description: "Read the active (or given) Teamwork run and summarize per-task progress.",
      input: {
        type: "object",
        properties: { sessionId: { type: "string" } },
        additionalProperties: false,
      },
      execute: async (input: any) => {
        const run = resolveRun(root, input?.sessionId)
        if (!run) return { content: "No Teamwork run found under " + runsDir(root) }
        const state = readJson<any>(join(run, "state.json"), {})
        const tasks = state.tasks || {}
        const lines = Object.entries(tasks).map(([id, t]: any) => `  ${id}: ${t.status} (round ${t.round}${t.lastReport ? `, ${t.lastReport}` : ""})`)
        const pass = Object.values(tasks).filter((t: any) => t.status === "pass").length
        return { content: `Run ${state.sessionId || "(unknown)"} — phase ${state.phase}\n${pass}/${lines.length} pass\n${lines.join("\n")}` }
      },
    })

    editor.add({
      name: "resume",
      description: "Return the tasks that still need work (pending/running/fail) so a restarted Sentinel can continue where it stopped.",
      input: {
        type: "object",
        properties: { sessionId: { type: "string" } },
        additionalProperties: false,
      },
      execute: async (input: any) => {
        const run = resolveRun(root, input?.sessionId)
        if (!run) return { content: "No Teamwork run to resume." }
        const state = readJson<any>(join(run, "state.json"), {})
        const open = Object.entries(state.tasks || {}).filter(([, t]: any) => t.status !== "pass")
        if (!open.length) return { content: `Run ${state.sessionId} is complete (all tasks pass).` }
        return {
          content: `Resume ${state.sessionId} at phase ${state.phase}. Open tasks:\n` + open.map(([id, t]: any) => `  ${id}: ${t.status} round ${t.round}${t.lastReport ? ` — see ${t.lastReport}` : ""}`).join("\n"),
        }
      },
    })

    editor.add({
      name: "cost",
      description: "Read the run budget and optionally add a spend amount. Warns at 80%.",
      input: {
        type: "object",
        properties: { sessionId: { type: "string" }, addUsd: { type: "number" }, taskId: { type: "string" } },
        additionalProperties: false,
      },
      execute: async (input: any) => {
        const run = resolveRun(root, input?.sessionId)
        if (!run) return { content: "No Teamwork run found." }
        const file = join(run, "costs.json")
        const costs = readJson<any>(file, { budgetUsd: 20, spentUsd: 0, byTask: {} })
        if (typeof input?.addUsd === "number") {
          costs.spentUsd = Math.round(((costs.spentUsd || 0) + input.addUsd) * 1e4) / 1e4
          if (input.taskId) costs.byTask[input.taskId] = Math.round(((costs.byTask[input.taskId] || 0) + input.addUsd) * 1e4) / 1e4
          costs.updatedAt = new Date().toISOString()
          writeJson(file, costs)
        }
        const pct = costs.budgetUsd ? Math.round((costs.spentUsd / costs.budgetUsd) * 100) : 0
        const warn = pct >= 80 ? `\n⚠ ${pct}% of budget used — halt non-essential workers and ask the user.` : ""
        return { content: `Budget: $${costs.budgetUsd} · spent: $${costs.spentUsd} (${pct}%)${warn}` }
      },
    })

    editor.add({
      name: "pitfall",
      description: "Append an answer-agnostic failure mode to the run's pitfall registry.",
      input: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          round: { type: "number" },
          taskId: { type: "string" },
          pitfall: { type: "string" },
        },
        required: ["pitfall"],
        additionalProperties: false,
      },
      execute: async (input: any) => {
        const run = resolveRun(root, input?.sessionId)
        if (!run) return { content: "No Teamwork run found." }
        const line = `- [round ${input.round ?? "?"}] ${input.pitfall}${input.taskId ? ` — seen in ${input.taskId}` : ""}\n`
        appendFileSync(join(run, "pitfalls.md"), line)
        return { content: `Logged pitfall: ${line.trim()}` }
      },
    })
  })
}

export async function registerTeamworkHooks(ctx: any, root: string) {
  // Read-only guarantee for critic/verifier agents, enforced in code rather
  // than trusting the model to obey its prompt.
  try {
    await ctx.permission?.hook?.("evaluate", (event: any) => {
      if (READ_ONLY_AGENTS.has(event.agent) && (event.action === "edit" || event.action === "write" || event.action === "shell")) {
        event.effect = "deny"
        event.message = `${event.agent} is read-only during a Teamwork run.`
      }
    })
  } catch {}

  // Inject the active run's state + pitfalls into every team agent's context.
  try {
    await ctx.session?.hook?.("context", (event: any) => {
      if (typeof event.agent === "string" && event.agent.startsWith("team/")) {
        const text = describeRun(root)
        if (text) event.system.push({ type: "text", text })
      }
    })
  } catch {}
}
