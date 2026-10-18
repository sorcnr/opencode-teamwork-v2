// opencode-teamwork-v2 — doctor diagnostics test suite
//
// Hermetic, zero-dependency coverage for `lib/doctor.mjs` and the
// `opencode-teamwork doctor` CLI. Every fixture lives in its own temp dir and
// every invocation gets an explicit `configDir` / `--config-dir` plus an
// explicit `cwd`, so the developer's real ~/.config/opencode is never touched.
//
// Run with plain Node (no test framework): an uncaught assertion exits non-zero.

import { runDoctor, CHECK_NAMES } from "../lib/doctor.mjs"
import { TEAM_AGENTS, PACKAGE_NAME, writeModelMap } from "../lib/team.mjs"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync, spawnSync } from "node:child_process"
import assert from "node:assert"

const here = dirname(fileURLToPath(import.meta.url))
const cliPath = join(here, "..", "bin", "opencode-teamwork.mjs")

// Root temp dir for this run; fixture dirs are tracked so they are always
// removed, even when an assertion throws.
const testDir = mkdtempSync(join(tmpdir(), "teamwork-doctor-test-"))
const fixtureDirs = []

/** Create (and register for cleanup) a fresh temp directory. */
function makeTemp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  fixtureDirs.push(dir)
  return dir
}

/**
 * Build a fully healthy config fixture:
 *   - opencode.json registering the teamwork plugin
 *   - all TEAM_AGENTS markdown files with a model: frontmatter line
 *   - a teamwork.json model map that matches every agent file
 */
function makeHealthyConfig() {
  const configDir = makeTemp("teamwork-doctor-config-")

  writeFileSync(
    join(configDir, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", plugins: [PACKAGE_NAME] }, null, 2) + "\n",
  )

  const agentsDir = join(configDir, "agents", "team")
  mkdirSync(agentsDir, { recursive: true })

  const models = {}
  for (const agent of TEAM_AGENTS) {
    writeFileSync(join(agentsDir, agent.file), `---\nmodel: ${agent.defaultModel}\n---\n\n# ${agent.id}\n`)
    models[agent.id] = agent.defaultModel
  }

  writeModelMap(configDir, models)
  return { configDir, models, agentsDir }
}

/** A fresh temp dir that is an actual git work tree (for the pass path). */
function makeGitRepo() {
  const dir = makeTemp("teamwork-doctor-git-")
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" })
  return dir
}

/** Assert the report carries exactly the seven checks in the fixed order. */
function assertCheckOrder(checks) {
  assert.deepStrictEqual(
    checks.map((check) => check.name),
    CHECK_NAMES,
    "checks must be present in the fixed order",
  )
}

function findCheck(report, name) {
  const check = report.checks.find((c) => c.name === name)
  assert(check, `check "${name}" must be present`)
  return check
}

try {
  // Keep worktree-dir resolution deterministic and hermetic (the check reads
  // this env var; it is inherited by CLI subprocesses too).
  process.env.TEAMWORK_WORKTREES_DIR = join(testDir, "worktrees")

  const gitRepo = makeGitRepo()

  // ==========================================
  // Part 1: Healthy environment passes every check
  // ==========================================
  console.log("Testing healthy environment...")

  const healthy = makeHealthyConfig()
  const healthyReport = runDoctor({ configDir: healthy.configDir, cwd: gitRepo })

  assert.strictEqual(healthyReport.ok, true, "healthy environment must report ok: true")
  assert.strictEqual(healthyReport.checks.length, 7, "doctor must report exactly 7 checks")
  assertCheckOrder(healthyReport.checks)
  for (const check of healthyReport.checks) {
    assert.strictEqual(check.status, "pass", `expected ${check.name} to pass, got ${check.status}: ${check.message}`)
  }

  console.log("✓ Healthy environment passes all 7 checks in fixed order (ok: true)")

  // ==========================================
  // Part 2: Missing agent file fails the run
  // ==========================================
  console.log("Testing missing agent file...")

  const missingFixture = makeHealthyConfig()
  const missingAgent = TEAM_AGENTS[2] // team/orchestrator
  rmSync(join(missingFixture.agentsDir, missingAgent.file))

  const missingReport = runDoctor({ configDir: missingFixture.configDir, cwd: gitRepo })
  const agentsCheck = findCheck(missingReport, "agents_installed")

  assert.strictEqual(agentsCheck.status, "fail", "agents_installed must fail when an agent file is missing")
  assert.strictEqual(missingReport.ok, false, "a failing check must make ok false")
  assert(
    agentsCheck.message.includes(missingAgent.id),
    `failure message must name the missing agent id (${missingAgent.id}), got: ${agentsCheck.message}`,
  )

  console.log("✓ Missing agent file fails agents_installed and sets ok: false")

  // ==========================================
  // Part 3: Desynchronized model map warns but stays healthy
  // ==========================================
  console.log("Testing desynchronized model map...")

  const desyncFixture = makeHealthyConfig()
  const desyncAgent = TEAM_AGENTS[0] // team/crafter
  writeModelMap(desyncFixture.configDir, {
    ...desyncFixture.models,
    [desyncAgent.id]: "some-other-provider/some-other-model",
  })

  const desyncReport = runDoctor({ configDir: desyncFixture.configDir, cwd: gitRepo })
  const modelCheck = findCheck(desyncReport, "model_sync")

  assert.strictEqual(modelCheck.status, "warn", "model_sync must warn when teamwork.json disagrees with the agent file")
  assert.strictEqual(desyncReport.ok, true, "a warning must not fail the run (ok must remain true)")
  assert(
    modelCheck.message.includes(desyncAgent.id),
    `mismatch message must name the desynchronized agent (${desyncAgent.id}), got: ${modelCheck.message}`,
  )
  assert(
    desyncReport.checks.every((check) => check.status !== "fail"),
    "no check may fail for the desync fixture",
  )

  console.log("✓ Desynchronized model map warns without failing the run (ok: true)")

  // ==========================================
  // Part 4: cwd outside any git work tree
  // ==========================================
  console.log("Testing non-git cwd...")

  // A bare mkdtemp dir under the OS temp root. Assert on the real result rather
  // than assuming the ancestors are repo-free.
  const noGitDir = makeTemp("teamwork-doctor-nogit-")
  const noGitReport = runDoctor({ configDir: healthy.configDir, cwd: noGitDir })
  const gitRepoCheck = findCheck(noGitReport, "git_repository")

  assert(
    gitRepoCheck.status === "warn" || gitRepoCheck.status === "fail",
    `git_repository must warn or fail outside a work tree, got ${gitRepoCheck.status}: ${gitRepoCheck.message}`,
  )

  console.log("✓ Non-git cwd yields warn/fail for git_repository")

  // ==========================================
  // Part 5: CLI --json contract
  // ==========================================
  console.log("Testing CLI JSON contract...")

  const jsonOut = execFileSync(process.execPath, [cliPath, "doctor", "--json", "--config-dir", healthy.configDir], {
    cwd: gitRepo,
    encoding: "utf8",
  })

  assert(!jsonOut.includes("\u001b["), "doctor --json stdout must not contain ANSI escape sequences")

  const parsed = JSON.parse(jsonOut)
  assert.strictEqual(parsed.ok, true, "CLI JSON must report ok: true for a healthy fixture")
  assert.strictEqual(parsed.checks.length, 7, "CLI JSON must report exactly 7 checks")
  assertCheckOrder(parsed.checks)
  assert(
    parsed.checks.every((check) => check.status === "pass"),
    "CLI JSON checks must all be pass for a healthy fixture",
  )

  console.log("✓ CLI --json emits pure parseable JSON with 7 ordered checks and no ANSI")

  // ==========================================
  // Part 6: CLI exit codes
  // ==========================================
  console.log("Testing CLI exit codes...")

  const healthyExit = spawnSync(process.execPath, [cliPath, "doctor", "--json", "--config-dir", healthy.configDir], {
    cwd: gitRepo,
    encoding: "utf8",
  })
  assert.strictEqual(healthyExit.status, 0, `healthy doctor must exit 0, got ${healthyExit.status}`)

  const brokenFixture = makeHealthyConfig()
  rmSync(join(brokenFixture.agentsDir, TEAM_AGENTS[4].file))
  const brokenExit = spawnSync(process.execPath, [cliPath, "doctor", "--json", "--config-dir", brokenFixture.configDir], {
    cwd: gitRepo,
    encoding: "utf8",
  })
  assert.strictEqual(brokenExit.status, 1, `doctor with a missing agent must exit 1, got ${brokenExit.status}`)

  console.log("✓ CLI exit codes verified (0 healthy, 1 on failure)")
} finally {
  rmSync(testDir, { recursive: true, force: true })
  for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true })
}
