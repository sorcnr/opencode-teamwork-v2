#!/usr/bin/env node
// opencode-teamwork-v2 — installer CLI
//
//   opencode-teamwork init      pick models + install agents + register plugin
//   opencode-teamwork models    pick models + reinstall agents (no config edit)
//   opencode-teamwork install   non-interactive install using defaults/flags
//   opencode-teamwork status    show what is currently configured
//   opencode-teamwork help

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  PACKAGE_NAME,
  TEAM_AGENTS,
  resolveConfigDir,
  readModelMap,
  writeModelMap,
  installAgents,
  registerPlugin,
  currentModels,
  findConfigFile,
  stripJsonComments,
  modelMapPath,
} from "../lib/team.mjs"
import { detectAvailableModels, pickModels, applyOverrides } from "../lib/picker.mjs"

const HELP = `opencode-teamwork-v2

Usage: opencode-teamwork <command> [options]

Commands:
  init       Pick a model for each team agent, install agents, register the plugin
  models     Same as init but never edits opencode.json
  install    Non-interactive install using defaults / flags
  status     Show config dir, model map, installed agents and plugin state
  help       Show this help

Options:
  -y, --yes              Accept current/default models without prompting
      --all <model>      Use one model for every agent (e.g. anthropic/claude-sonnet-4-5)
      --model <id>=<m>   Override one agent (repeatable), id may omit the "team/" prefix
      --no-register      Don't touch opencode.json(c)
      --config-dir <dir> Override the OpenCode config directory
      --dry-run          Print what would change without writing files
  -h, --help             Show this help
`

function parseArgs(argv) {
  const options = { command: undefined, yes: false, all: undefined, assignments: {}, register: true, dryRun: false, configDir: undefined, help: false }
  const rest = [...argv]
  options.command = rest.shift()
  while (rest.length) {
    const arg = rest.shift()
    switch (arg) {
      case "-y":
      case "--yes":
        options.yes = true
        break
      case "--all":
        options.all = rest.shift()
        break
      case "--model": {
        const pair = rest.shift() || ""
        const eq = pair.indexOf("=")
        if (eq > 0) options.assignments[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim()
        else console.warn(`Ignoring malformed --model "${pair}" (expected id=provider/model)`)
        break
      }
      case "--no-register":
        options.register = false
        break
      case "--config-dir":
        options.configDir = rest.shift()
        break
      case "--dry-run":
        options.dryRun = true
        break
      case "-h":
      case "--help":
        options.help = true
        break
      default:
        if (arg) console.warn(`Ignoring unknown argument: ${arg}`)
    }
  }
  return options
}

function isInteractive(options) {
  return !options.yes && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY)
}

function printSummary(configDir, models, install, registration) {
  const changed = install.created.length + install.updated.length
  console.log("")
  console.log(`Config dir : ${configDir}`)
  console.log(`Agents     : ${TEAM_AGENTS.length} (${install.created.length} created, ${install.updated.length} updated, ${install.unchanged.length} unchanged)`)
  if (install.backupDir) console.log(`Backups    : ${install.backupDir}`)
  if (install.missing.length) console.log(`Missing    : ${install.missing.join(", ")}`)
  if (registration) {
    if (registration.status === "added") console.log(`Plugin     : added "${registration.entry}" to ${registration.file}`)
    else if (registration.status === "already") console.log(`Plugin     : already configured (${registration.entry}) in ${registration.file}`)
    else if (registration.status === "unparsed") console.log(`Plugin     : could not parse ${registration.file} — add "${PACKAGE_NAME}" to "plugins" manually`)
  }
  console.log("\nModel assignment:")
  for (const agent of TEAM_AGENTS) console.log(`  ${agent.id.padEnd(20)} ${models[agent.id]}`)
  if (changed === 0 && !registration) console.log("\nNothing changed.")
  console.log("\nRestart OpenCode (or run `opencode reload`) to pick up the changes.")
}

async function run(options, { register }) {
  const configDir = resolveConfigDir(options.configDir)
  const current = currentModels(configDir)

  let models = current
  if (isInteractive(options)) {
    const available = await detectAvailableModels()
    models = await pickModels({ current, available })
  }
  models = applyOverrides(models, { all: options.all, assignments: options.assignments })

  if (!options.dryRun) writeModelMap(configDir, models)
  const install = installAgents({ configDir, models, dryRun: options.dryRun })
  const registration = register ? registerPlugin({ configDir, dryRun: options.dryRun }) : undefined

  printSummary(configDir, models, install, registration)
}

function status(options) {
  const configDir = resolveConfigDir(options.configDir)
  const models = readModelMap(configDir)
  const configFile = findConfigFile(configDir)
  console.log(`Config dir : ${configDir}`)
  console.log(`Config file: ${configFile || "(none — would create opencode.json)"}`)
  if (configFile) {
    try {
      const data = JSON.parse(stripJsonComments(readFileSync(configFile, "utf8")))
      const entries = Array.isArray(data.plugins) ? data.plugins.filter((p) => typeof p === "string" && p.includes("opencode-teamwork")) : []
      console.log(`Plugin     : ${entries.length ? entries.join(", ") : "not registered"}`)
    } catch {
      console.log("Plugin     : (config not parsed)")
    }
  }
  console.log("\nAgents:")
  for (const agent of TEAM_AGENTS) {
    const file = join(configDir, "agents", "team", agent.file)
    const present = existsSync(file)
    const model = present ? (readFileSync(file, "utf8").match(/^model:\s*(.+?)\s*$/m)?.[1] ?? "?") : "not installed"
    console.log(`  ${agent.id.padEnd(20)} ${present ? "ok " : "-- "} ${model}${models[agent.id] && models[agent.id] !== model && present ? `  (teamwork.json: ${models[agent.id]})` : ""}`)
  }
  console.log(`\nModel map  : ${modelMapPath(configDir)} (${existsSync(modelMapPath(configDir)) ? "present" : "not written"})`)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const command = options.command || (options.help ? "help" : "init")

  if (options.help || command === "help") {
    console.log(HELP)
    return
  }
  if (!["init", "models", "install", "status"].includes(command)) {
    console.error(`Unknown command: ${command}\n`)
    console.log(HELP)
    process.exitCode = 1
    return
  }

  if (command === "status") return status(options)
  if (command === "install") {
    options.yes = true
    return run(options, { register: options.register })
  }
  if (command === "models") {
    return run(options, { register: false })
  }
  return run(options, { register: options.register })
}

main().catch((error) => {
  console.error(`opencode-teamwork-v2: ${error?.message || error}`)
  process.exitCode = 1
})
