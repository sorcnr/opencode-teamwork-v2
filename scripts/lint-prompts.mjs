#!/usr/bin/env node
// Prompt/agent linter for opencode-teamwork-v2.
//
// Guards the invariants we keep breaking by hand:
//   * one canonical artifact root (.opencode/teamwork/<session-id>/)
//   * one canonical topology enum (parsed from docs/ARTIFACTS.md)
//   * no duplicated "run-time reminder" blocks / self-referential "agent file"
//   * no stale references (Antigravity, defaults.ts, agent.team/*)
//   * no `effect: ask` in agents that run in parallel (would stall a run)
//   * every command template consumes $ARGUMENTS
//
// Usage: node scripts/lint-prompts.mjs   (exit 1 on any violation)

import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join, basename } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const agentsDir = join(root, "agents", "team")
const pluginFile = join(root, "plugins", "opencode-teamwork", "index.ts")
const artifactsFile = join(root, "docs", "ARTIFACTS.md")

const errors = []
const fail = (file, msg) => errors.push(`${basename(file)}: ${msg}`)

const agents = readdirSync(agentsDir).filter((f) => f.endsWith(".md"))
const read = (p) => readFileSync(p, "utf8")

// Canonical topologies, parsed from docs/ARTIFACTS.md so there is one source.
let canonical = []
if (!existsSync(artifactsFile)) {
  errors.push("docs/ARTIFACTS.md is missing")
} else {
  const md = read(artifactsFile)
  canonical = [...md.matchAll(/^\| `([a-z][a-z-]+)` \|/gm)].map((m) => m[1])
  if (canonical.length < 6) errors.push(`docs/ARTIFACTS.md: expected >=6 topologies, found ${canonical.length}`)
}

const LEGACY = ["large-swarm", "doc-review", "long-proof", "massive-proof-swarm"]
const FORBIDDEN = [
  ["Antigravity", "attribution removed; describe behavior, don't name-drop"],
  ["defaults.ts", "stale path — models live in agent frontmatter / teamwork.json"],
  ["agent.team/*", "stale V1 config key"],
  ["run-time reminder", "duplicated prompt block"],
  ["are in your agent file", "self-referential instruction"],
  ["in your agent file", "self-referential instruction"],
  [".teamwork-runs", "old artifact root"],
  ["<run-id>", "old id terminology"],
]

const PARALLEL_AGENTS = new Set([
  "proposer.md", "synthesizer.md", "worker.md", "proof-worker.md",
  "falsifier.md", "scout.md", "verifier.md",
])

for (const file of agents) {
  const path = join(agentsDir, file)
  const text = read(path)

  // Frontmatter
  const fm = text.match(/^---\n([\s\S]*?)\n---/)
  if (!fm) { fail(path, "missing frontmatter"); continue }
  for (const key of ["description", "mode", "model"]) {
    if (!new RegExp(`^${key}:`, "m").test(fm[1])) fail(path, `frontmatter missing '${key}'`)
  }

  // Forbidden references
  for (const [needle, why] of FORBIDDEN) {
    if (text.includes(needle)) fail(path, `contains '${needle}' (${why})`)
  }

  // Legacy topology names allowed only on an alias-mapping line (contains '→')
  for (const line of text.split("\n")) {
    if (line.includes("→")) continue
    for (const legacy of LEGACY) {
      if (line.includes(legacy)) fail(path, `uses legacy topology '${legacy}'`)
    }
  }

  // Parallel agents must not block on 'ask'
  if (PARALLEL_AGENTS.has(file) && /effect:\s*ask/.test(text)) {
    fail(path, "uses 'effect: ask' but runs in parallel (would stall the run)")
  }
}

// Plugin: commands must consume $ARGUMENTS and not use old paths
const plugin = read(pluginFile)
if (plugin.includes(".teamwork-runs")) fail(pluginFile, "old artifact root")
const argCount = (plugin.match(/\$ARGUMENTS/g) || []).length
const cmdCount = (plugin.match(/name:\s*"/g) || []).length
if (argCount < 1) fail(pluginFile, "no $ARGUMENTS substitution found")
if (argCount < cmdCount - 1) fail(pluginFile, `only ${argCount} $ARGUMENTS for ~${cmdCount} commands`)

// Canonical topology names must appear in the agents that route on them
for (const file of ["sentinel.md", "crafter.md"]) {
  const text = read(join(agentsDir, file))
  const missing = canonical.filter((t) => !text.includes(`\`${t}\``))
  if (missing.length) fail(join(agentsDir, file), `missing canonical topologies: ${missing.join(", ")}`)
}

if (errors.length) {
  console.error(`✗ prompt lint failed (${errors.length}):`)
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}
console.log(`✓ prompt lint passed (${agents.length} agents, ${canonical.length} topologies)`)
