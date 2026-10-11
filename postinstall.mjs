// opencode-teamwork-v2 — postinstall hook
//
// Installs the 10 `team/*` agent markdown files into the OpenCode config
// directory and asks the user which model each agent should use.
//
// It deliberately does NOT edit opencode.json: OpenCode's own
// `opencode plugin add` handles registration, and silently rewriting a user's
// config from a lifecycle script is more surprising than helpful. Use
// `opencode-teamwork init` when the plugin was installed another way.
//
// The hook is best-effort: it never fails the surrounding install and skips
// entirely in CI or when OPENCODE_TEAMWORK_SKIP=1.

import {
  PACKAGE_NAME,
  resolveConfigDir,
  currentModels,
  writeModelMap,
  installAgents,
} from "./lib/team.mjs"
import { detectAvailableModels, pickModels } from "./lib/picker.mjs"

function truthy(value) {
  return value === "1" || value === "true" || value === "yes"
}

async function main() {
  // `npx <pkg> ...` / `npm exec` installs a throwaway copy just to run the CLI.
  // The CLI (`init`) does the real setup, so running here too would double-prompt.
  if (process.env.npm_command === "exec") return

  if (truthy(process.env.OPENCODE_TEAMWORK_SKIP) || truthy(process.env.CI)) {
    console.log(`[${PACKAGE_NAME}] Skipping interactive setup (CI / OPENCODE_TEAMWORK_SKIP).`)
    console.log(`[${PACKAGE_NAME}] Run \`npx ${PACKAGE_NAME} init\` to choose agent models.`)
    return
  }

  const configDir = resolveConfigDir()
  const current = currentModels(configDir)

  let models = current
  const interactive = Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY)
  if (interactive) {
    try {
      const available = await detectAvailableModels()
      models = await pickModels({ current, available })
    } catch {
      models = current
    }
  }

  writeModelMap(configDir, models)
  const install = installAgents({ configDir, models })
  console.log(
    `[${PACKAGE_NAME}] Installed ${install.created.length} agent(s), updated ${install.updated.length} in ${configDir}/agents/team.`,
  )
  console.log(`[${PACKAGE_NAME}] Models saved to ${configDir}/teamwork.json.`)
  if (!interactive) {
    console.log(`[${PACKAGE_NAME}] (non-interactive) Run \`npx ${PACKAGE_NAME} init\` to choose models per agent.`)
  }
  console.log(`[${PACKAGE_NAME}] If the plugin isn't registered yet, run \`opencode plugin add ${PACKAGE_NAME}\`.`)
}

main().catch((error) => {
  console.log(`[${PACKAGE_NAME}] postinstall skipped: ${error?.message || error}`)
})
