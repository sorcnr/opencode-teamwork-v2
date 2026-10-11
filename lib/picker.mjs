// opencode-teamwork-v2 — interactive model picker
//
// Dependency-free (node:readline only). Detects the models OpenCode actually
// has available (via `opencode models`) and lets the user assign one to each
// team agent, either with a single shared model or per-agent.

import { execFile } from "node:child_process"
import readline from "node:readline/promises"
import { TEAM_AGENTS, DEFAULT_MODELS } from "./team.mjs"

/** Return the list of `provider/model` ids from `opencode models`, or []. */
export function detectAvailableModels({ timeout = 20000 } = {}) {
  return new Promise((resolve) => {
    execFile("opencode", ["models"], { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error || !stdout) return resolve([])
      const models = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._:-]+$/.test(line))
      resolve([...new Set(models)])
    })
  })
}

function parseModelToken(input, available, fallback) {
  const value = String(input ?? "").trim()
  if (!value) return fallback
  if (/^\d+$/.test(value)) {
    const index = Number.parseInt(value, 10)
    if (index >= 1 && index <= available.length) return available[index - 1]
    return fallback
  }
  return value
}

function printModelList(available, current) {
  if (!available.length) {
    console.log("  (couldn't detect models from `opencode models` — type provider/model manually)")
    return
  }
  console.log("\nAvailable models:")
  available.forEach((model, i) => {
    const used = Object.values(current).includes(model) ? " *" : ""
    console.log(`  ${String(i + 1).padStart(3)}. ${model}${used}`)
  })
  console.log("  ( * = already assigned in this session )\n")
}

/**
 * Run the interactive picker. Returns a full model map keyed by agent id.
 * Never throws; falls back to the supplied defaults on any problem.
 */
export async function pickModels({ current = {}, available = [], input = process.stdin, output = process.stdout } = {}) {
  const base = { ...DEFAULT_MODELS, ...current }
  const rl = readline.createInterface({ input, output })
  const ask = async (prompt, fallback = "") => {
    try {
      const answer = (await rl.question(prompt)).trim()
      return answer === "" ? fallback : answer
    } catch {
      return fallback
    }
  }

  try {
    console.log("\nopencode-teamwork-v2 — model assignment")
    console.log("Pick a model for each of the 10 team agents. Press Enter to keep the current value.")
    console.log("\nHow would you like to assign models?")
    console.log("  1) Keep current / default models")
    console.log("  2) Use one model for every agent")
    console.log("  3) Configure each agent individually")
    const choice = await ask("Choice [1]: ", "1")

    if (choice === "1") return base

    if (choice === "2") {
      printModelList(available, base)
      const answer = await ask(`Model for all agents [${base[TEAM_AGENTS[0].id]}]: `, "")
      const model = parseModelToken(answer, available, base[TEAM_AGENTS[0].id])
      const map = {}
      for (const agent of TEAM_AGENTS) map[agent.id] = model
      return map
    }

    if (choice === "3") {
      printModelList(available, base)
      const map = { ...base }
      for (let i = 0; i < TEAM_AGENTS.length; i++) {
        const agent = TEAM_AGENTS[i]
        console.log(`[${i + 1}/${TEAM_AGENTS.length}] ${agent.id} — ${agent.role}`)
        const answer = await ask(`      model [${map[agent.id]}]: `, "")
        map[agent.id] = parseModelToken(answer, available, map[agent.id])
      }
      return map
    }

    console.log("Unrecognised choice — keeping current models.")
    return base
  } finally {
    rl.close()
  }
}

/** Apply CLI overrides (`--all`, repeated `--model id=provider/model`) to a map. */
export function applyOverrides(models, { all, assignments = {} } = {}) {
  const next = { ...models }
  if (all) for (const agent of TEAM_AGENTS) next[agent.id] = all
  for (const [id, value] of Object.entries(assignments)) {
    const key = id.startsWith("team/") ? id : `team/${id}`
    next[key] = value
  }
  return next
}
