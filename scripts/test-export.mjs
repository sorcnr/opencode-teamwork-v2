// opencode-teamwork-v2 — run export test suite
//
// Hermetic, zero-dependency coverage for `lib/export.mjs` and the
// `opencode-teamwork export` CLI. Every fixture is a synthetic run directory
// inside its own mkdtemp dir. The CLI is spawned with cwd set to the fixture
// root and HOME pointed at an empty temp dir, so neither the developer's real
// ~/.config/opencode nor the live .opencode/teamwork/ tree is ever read.
//
// Run with plain Node (no test framework): failures are counted, printed, and
// make the process exit non-zero.

import { buildExportData, renderExport } from "../lib/export.mjs"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import assert from "node:assert"

const here = dirname(fileURLToPath(import.meta.url))
const cliPath = join(here, "..", "bin", "opencode-teamwork.mjs")

// Root temp dir for this run; every fixture lives under it and it is removed in the end.
const testDir = mkdtempSync(join(tmpdir(), "teamwork-export-test-"))

// An empty HOME: any accidental read of ~/.config/opencode finds nothing.
const emptyHome = mkdtempSync(join(testDir, "home-"))

// Keep the in-process environment hermetic too.
process.env.HOME = emptyHome
process.env.USERPROFILE = emptyHome
process.env.XDG_CONFIG_HOME = join(emptyHome, ".config")

const SESSION = "20261018-100000-ex01"
const MISSING = "20261018-999999-none"
const XSS = "<script>alert(1)</script>"

let passed = 0
let failed = 0

/** Run one named check; a thrown assertion is recorded and the suite continues. */
async function check(name, fn) {
  try {
    await fn()
    passed++
    console.log(`✓ ${name}`)
  } catch (err) {
    failed++
    console.error(`✗ ${name}\n    ${err && err.message ? err.message : err}`)
  }
}

function makeRoot() {
  return mkdtempSync(join(testDir, "root-"))
}

function runDirOf(root, id) {
  return join(root, ".opencode", "teamwork", id)
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n")
}

// ---------------------------------------------------------------- fixtures

// A healthy run, shaped after docs/ARTIFACTS.md:
//   alpha: verified_pass in round 2, benign summary, a PASS report.
//   beta:  verified_fail in round 1; its summary and feedback carry the XSS payload.
// Nothing in here contains an http(s) URL, so the HTML must contain none either.
const EVENTS = [
  { ts: "2026-10-18T10:00:00.000Z", event: "run_created", sessionId: SESSION, taskId: null, from: null, to: "pending", round: 0, agent: null, branch: null, worktree: null, phase: "DAG_BUILD" },
  { ts: "2026-10-18T10:00:05.000Z", event: "task_transition", sessionId: SESSION, taskId: "alpha", from: "pending", to: "worker_active", round: 1, agent: "team/worker", branch: "teamwork/ex-alpha", worktree: "/wt/alpha", phase: "DISPATCH" },
  { ts: "2026-10-18T10:00:10.000Z", event: "task_transition", sessionId: SESSION, taskId: "beta", from: "pending", to: "worker_active", round: 1, agent: "team/worker", branch: "teamwork/ex-beta", worktree: "/wt/beta", phase: "DISPATCH" },
  { ts: "2026-10-18T10:01:00.000Z", event: "task_transition", sessionId: SESSION, taskId: "beta", from: "worker_active", to: "verified_fail", round: 1, agent: "team/verifier", branch: "teamwork/ex-beta", worktree: "/wt/beta", phase: "VERIFY" },
  { ts: "2026-10-18T10:02:00.000Z", event: "task_transition", sessionId: SESSION, taskId: "alpha", from: "worker_active", to: "verified_pass", round: 2, agent: "team/verifier", branch: "teamwork/ex-alpha", worktree: "/wt/alpha", phase: "VERIFY" },
]

const STATE = {
  version: 1,
  sessionId: SESSION,
  phase: "SECURITY_AUDIT",
  tasks: {
    alpha: {
      status: "verified_pass",
      round: 2,
      branch: "teamwork/ex-alpha",
      worktree: "/wt/alpha",
      summary: "Implemented the alpha module",
      feedback: null,
      verification: { status: "PASS", passedChecks: 4, totalChecks: 4, fatalFindings: [] },
      updatedAt: "2026-10-18T10:02:00.000Z",
    },
    beta: {
      status: "verified_fail",
      round: 1,
      branch: "teamwork/ex-beta",
      worktree: "/wt/beta",
      summary: `Beta summary ${XSS}`,
      feedback: `Verifier says: ${XSS}`,
      verification: { status: "FAIL", passedChecks: 1, totalChecks: 3, fatalFindings: ["empty input crashes"] },
      updatedAt: "2026-10-18T10:01:00.000Z",
    },
  },
  updatedAt: "2026-10-18T10:02:00.000Z",
}

const PLAN = {
  sessionId: SESSION,
  topology: "iterative-coding",
  tasks: [
    { id: "alpha", dependsOn: [], requirements: ["R1"], agent: "team/worker", maxRounds: 4, status: "verified_pass", round: 2 },
    { id: "beta", dependsOn: [], requirements: ["R2"], agent: "team/worker", maxRounds: 4, status: "verified_fail", round: 1 },
  ],
}

const COSTS = {
  sessionId: SESSION,
  rootSessionIds: ["ses_root"],
  budgetUsd: 5,
  budgetSource: "manual",
  spentUsd: 0.21,
  byTask: { alpha: 0.12, beta: 0.05, _sentinel: 0.01, _unattributed: 0.02 },
  byTaskTokens: { alpha: { input: 1234, output: 567, reasoning: 8, cache: { read: 90, write: 11 } } },
  updatedAt: "2026-10-18T10:02:00.000Z",
  tokens: { input: 1000, output: 200, reasoning: 0, cache: { read: 5, write: 6 } },
}

const SECURITY = {
  status: "PASS",
  timestamp: "2026-10-18T10:03:00.000Z",
  summary: "No blocking findings.",
  findings: [{ id: "SEC-1", severity: "low", location: "lib/example.mjs:12", description: "Minor hardening suggestion." }],
}

const REPORT_ALPHA = {
  taskId: "alpha",
  round: 2,
  status: "PASS",
  verifierAgent: "team/verifier",
  verifierModel: "opencode/example-model",
  checks: [{ passed: true }, { passed: true }, { passed: true }, { passed: true }],
  fatalFindings: [],
}

const REPORT_BETA = {
  taskId: "beta",
  round: 1,
  status: "FAIL",
  verifierAgent: "team/verifier",
  feedbackForWorker: `Fix the crash. ${XSS}`,
  checks: [{ passed: true }, { passed: false }, { passed: false }],
  fatalFindings: [{ where: "src/beta.mjs:3", why: "empty input crashes", fix: "guard the empty case" }],
}

/**
 * Write a run directory under a fresh root and return the root.
 * Pass `null` for any file to omit it.
 */
function makeRun({ id = SESSION, events = EVENTS, state = STATE, plan = PLAN, costs = COSTS, security = SECURITY, reports = [REPORT_ALPHA, REPORT_BETA] } = {}) {
  const root = makeRoot()
  const dir = runDirOf(root, id)
  mkdirSync(dir, { recursive: true })
  if (events !== null) writeFileSync(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n")
  if (state !== null) writeJson(join(dir, "state.json"), state)
  if (plan !== null) writeJson(join(dir, "plan.dag.json"), plan)
  if (costs !== null) writeJson(join(dir, "costs.json"), costs)
  if (security !== null) writeJson(join(dir, "verify", "security-audit.json"), security)
  for (const report of reports) writeJson(join(dir, "verify", `report-${report.taskId}.json`), report)
  return root
}

const healthyRoot = makeRun()
const healthyData = buildExportData(healthyRoot, SESSION)

// Isolated CLI runner. cwd MUST be the fixture root: the CLI resolves runs from process.cwd().
function runCli(args, cwd) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HOME: emptyHome, NO_COLOR: "" },
  })
}

// ==========================================
// 1. HTML generation from a healthy fixture
// ==========================================

await check("HTML: healthy fixture builds without error", () => {
  assert.strictEqual(healthyData.error, null, `buildExportData must succeed, got: ${healthyData.error}`)
  assert.strictEqual(healthyData.tasks.length, 2)
})

await check("HTML: output starts with a <!DOCTYPE> declaration", () => {
  const html = renderExport(healthyData, { format: "html" })
  assert(html.startsWith("<!DOCTYPE"), `must start with <!DOCTYPE, got: ${JSON.stringify(html.slice(0, 40))}`)
})

await check("HTML: CSS is embedded in a <style> block", () => {
  const html = renderExport(healthyData, { format: "html" })
  assert(/<style>/.test(html), "output must contain an embedded <style> block")
  assert(!/<link[^>]+rel=["']?stylesheet/i.test(html), "output must not link an external stylesheet")
})

await check("HTML: task status badges are rendered", () => {
  const html = renderExport(healthyData, { format: "html" })
  assert(/class="badge b-pass"[^>]*>PASS</.test(html), "verified_pass must render a PASS badge")
  assert(/class="badge b-fail"[^>]*>FAIL</.test(html), "verified_fail must render a FAIL badge")
})

await check("HTML: contains no external URLs (no http:// and no https://)", () => {
  const html = renderExport(healthyData, { format: "html" })
  assert(!html.includes("http://"), "output must not contain http://")
  assert(!html.includes("https://"), "output must not contain https://")
})

// ==========================================
// 2. Markdown structure
// ==========================================

await check("Markdown: contains a GFM table row", () => {
  const md = renderExport(healthyData, { format: "markdown" })
  assert(/^\|.*\|$/m.test(md), "Markdown must contain at least one |-delimited table row")
})

await check("Markdown: contains a GFM table separator row (|---|---|)", () => {
  const md = renderExport(healthyData, { format: "markdown" })
  assert(/^\|(\s*:?-+:?\s*\|)+\s*$/m.test(md), "Markdown must contain a table separator row such as |---|---|")
})

await check("Markdown: contains a checklist line (- [ ] or - [x])", () => {
  const md = renderExport(healthyData, { format: "markdown" })
  assert(/^- \[[ x]\] /m.test(md), "Markdown must contain a checklist item")
  assert(/^- \[x\] alpha: /m.test(md), "the passed task must be a checked item")
  assert(/^- \[ \] beta: /m.test(md), "the failed task must be an unchecked item")
})

// ==========================================
// 3. HTML entity escaping (XSS)
// ==========================================

await check("XSS: <script> payload in feedback/summary is escaped to &lt;script&gt;", () => {
  const html = renderExport(healthyData, { format: "html" })
  assert(html.includes("&lt;script&gt;"), "escaped payload must appear as &lt;script&gt;")
})

await check("XSS: raw <script>alert(1) substring never appears in HTML output", () => {
  const html = renderExport(healthyData, { format: "html" })
  assert(!html.includes("<script>alert(1)"), "raw <script>alert(1) must not appear in the HTML")
  assert(!/<script[\s>]/i.test(html), "no <script> element may appear in the HTML")
})

await check("XSS: a payload in the Markdown output is not a live HTML tag", () => {
  const md = renderExport(healthyData, { format: "markdown" })
  assert(!md.includes("<script>"), "raw <script> must not appear in the Markdown")
})

// ==========================================
// 4. Missing / invalid session id exits 1
// ==========================================

await check("CLI: a well-formed but nonexistent session id exits 1 with a stderr message", () => {
  const res = runCli(["export", MISSING], healthyRoot)
  assert.strictEqual(res.status, 1, `missing session must exit 1, got ${res.status}`)
  assert(res.stderr.trim().length > 0, "missing session must explain itself on stderr")
  assert.strictEqual(res.stdout, "", "no document may be produced for a missing session")
})

await check("CLI: an invalid session id (../../etc) exits 1 with a stderr message", () => {
  const res = runCli(["export", "../../etc"], healthyRoot)
  assert.strictEqual(res.status, 1, `invalid id must exit 1, got ${res.status}`)
  assert(res.stderr.trim().length > 0, "invalid id must explain itself on stderr")
})

// ==========================================
// 5. --output and -o -
// ==========================================

await check("CLI: `-o <file>` writes a file whose content matches the rendered HTML", () => {
  const res = runCli(["export", SESSION, "-o", "report-out.html"], healthyRoot)
  assert.strictEqual(res.status, 0, `valid export must exit 0, got ${res.status}: ${res.stderr}`)
  const file = join(healthyRoot, "report-out.html")
  assert(existsSync(file), "-o must create the named file")
  const written = readFileSync(file, "utf8")
  assert.strictEqual(written, renderExport(healthyData, { format: "html" }), "file content must equal the rendered document")
  assert(res.stdout.trim().endsWith("report-out.html"), `stdout must name the written path, got ${JSON.stringify(res.stdout)}`)
})

await check("CLI: `-o -` writes the document to stdout and creates no file", () => {
  const before = readdirSync(healthyRoot).sort()
  const res = runCli(["export", SESSION, "-o", "-"], healthyRoot)
  assert.strictEqual(res.status, 0, `-o - must exit 0, got ${res.status}: ${res.stderr}`)
  assert.strictEqual(res.stdout, renderExport(healthyData, { format: "html" }), "stdout must be exactly the rendered document")
  assert.deepStrictEqual(readdirSync(healthyRoot).sort(), before, "-o - must not create any file in the project root")
  assert(!existsSync(join(runDirOf(healthyRoot, SESSION), "report.html")), "-o - must not write the default report.html either")
})

await check("CLI: `-o ../escape.html` is refused with exit 1 and nothing is written", () => {
  const res = runCli(["export", SESSION, "-o", "../escape.html"], healthyRoot)
  assert.strictEqual(res.status, 1, `traversal output must exit 1, got ${res.status}`)
  assert(res.stderr.trim().length > 0, "a refused output path must explain itself on stderr")
  assert(!existsSync(join(testDir, "escape.html")), "nothing may be written outside the project root")
})

// ---------------------------------------------------------------- cleanup

rmSync(testDir, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed ? 1 : 0
