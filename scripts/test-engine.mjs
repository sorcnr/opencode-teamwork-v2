import { registerTeamworkTools } from "../plugins/opencode-teamwork/tools.ts"
import { listTeamworkRuns, inspectTeamworkRun, pruneTeamworkWorktrees } from "../lib/runs.mjs"
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import assert from "node:assert"

const testDir = mkdtempSync(join(tmpdir(), "teamwork-engine-test-"))

try {
  let registeredTools = {}
  const mockCtx = {
    tool: {
      transform: async (cb) => {
        const editor = {
          namespace: () => {},
          add: (tool) => {
            registeredTools[tool.name] = tool
          },
        }
        await cb(editor)
      },
    },
    session: { get: async () => undefined },
  }

  await registerTeamworkTools(mockCtx, testDir)

  assert(registeredTools.next, "next tool must be registered")
  assert(registeredTools.task_update, "task_update tool must be registered")
  assert(registeredTools.security_audit, "security_audit tool must be registered")
  assert(registeredTools.worktree, "worktree tool must be registered")

  // ==========================================
  // Part 1: DAG Engine & Dynamic Pitfall Injection
  // ==========================================
  console.log("Testing DAG Engine & Dynamic Pitfall Injection...")

  const planRes = await registeredTools.plan.execute({
    sessionId: "20261018-000000-test",
    topology: "distributed-coding",
    tasks: [
      { id: "T1", dependsOn: [], maxRounds: 2 },
      { id: "T2", dependsOn: ["T1"], maxRounds: 2 },
    ],
  })
  assert(planRes.content.includes("Planned 2 task(s)"), "Plan should create 2 tasks")

  // Log a known pitfall for T1
  await registeredTools.pitfall.execute({
    sessionId: "20261018-000000-test",
    taskId: "T1",
    round: 1,
    pitfall: "Do not assume non-empty array",
  })

  // Step 1: Initial state -> T1 readyForWorker with avoidPitfalls
  let nextRes = await registeredTools.next.execute({ sessionId: "20261018-000000-test" })
  assert.strictEqual(nextRes.readyForWorker.length, 1, "Only T1 should be ready for worker")
  assert.strictEqual(nextRes.readyForWorker[0].id, "T1")
  assert(nextRes.readyForWorker[0].avoidPitfalls.some((p) => p.includes("Do not assume non-empty array")), "Pitfall should be injected into readyForWorker")
  assert.strictEqual(nextRes.readyForVerifier.length, 0)

  // Step 2: Worker starts T1 -> worker_active
  await registeredTools.task_update.execute({
    sessionId: "20261018-000000-test",
    taskId: "T1",
    status: "worker_active",
  })
  nextRes = await registeredTools.next.execute({ sessionId: "20261018-000000-test" })
  assert.strictEqual(nextRes.readyForWorker.length, 0)
  assert.strictEqual(nextRes.inProgress.length, 1)
  assert.strictEqual(nextRes.inProgress[0].id, "T1")

  // Step 3: Worker commits -> worker_done
  await registeredTools.task_update.execute({
    sessionId: "20261018-000000-test",
    taskId: "T1",
    status: "worker_done",
    branch: "teamwork/20261018-000000-test-T1",
    summary: "Implemented T1",
  })
  nextRes = await registeredTools.next.execute({ sessionId: "20261018-000000-test" })
  assert.strictEqual(nextRes.readyForVerifier.length, 1)
  assert.strictEqual(nextRes.readyForVerifier[0].id, "T1")

  // Step 4: Verifier fails T1 (round 1) -> readyForWorker again for round 2
  await registeredTools.task_update.execute({
    sessionId: "20261018-000000-test",
    taskId: "T1",
    status: "verifier_active",
  })
  await registeredTools.task_update.execute({
    sessionId: "20261018-000000-test",
    taskId: "T1",
    status: "verified_fail",
    feedback: "Fix edge case in validation",
  })
  nextRes = await registeredTools.next.execute({ sessionId: "20261018-000000-test" })
  assert.strictEqual(nextRes.readyForWorker.length, 1)
  assert.strictEqual(nextRes.readyForWorker[0].id, "T1")
  assert.strictEqual(nextRes.readyForWorker[0].round, 2, "Should advance to round 2")
  assert.strictEqual(nextRes.readyForWorker[0].feedback, "Fix edge case in validation")

  // Step 5: T1 passes on round 2
  await registeredTools.task_update.execute({
    sessionId: "20261018-000000-test",
    taskId: "T1",
    status: "worker_active",
    round: 2,
  })
  await registeredTools.task_update.execute({
    sessionId: "20261018-000000-test",
    taskId: "T1",
    status: "worker_done",
  })
  await registeredTools.task_update.execute({
    sessionId: "20261018-000000-test",
    taskId: "T1",
    status: "verified_pass",
    verification: { status: "PASS", passedChecks: 5, totalChecks: 5 },
  })

  // Step 6: T1 passed -> T2 is unblocked and ready for worker!
  nextRes = await registeredTools.next.execute({ sessionId: "20261018-000000-test" })
  assert.strictEqual(nextRes.readyForWorker.length, 1)
  assert.strictEqual(nextRes.readyForWorker[0].id, "T2", "T2 should now be ready for worker")

  // Step 7: T2 passes -> Pre-merge security gate triggers!
  await registeredTools.task_update.execute({
    sessionId: "20261018-000000-test",
    taskId: "T2",
    status: "verified_pass",
  })
  nextRes = await registeredTools.next.execute({ sessionId: "20261018-000000-test" })
  assert.strictEqual(nextRes.status, "READY_FOR_SECURITY_AUDIT", "Should require security audit before all-passed")

  // Step 8: Security Audit fails (Critical finding) -> BLOCKED_BY_SECURITY
  const failAuditRes = await registeredTools.security_audit.execute({
    sessionId: "20261018-000000-test",
    status: "FAIL",
    findings: [{ id: "SEC-1", severity: "Critical", description: "Hardcoded API key in config", location: "config.js:10" }],
    summary: "Critical secret detected",
  })
  assert.strictEqual(failAuditRes.status, "FAIL")

  nextRes = await registeredTools.next.execute({ sessionId: "20261018-000000-test" })
  assert.strictEqual(nextRes.status, "BLOCKED_BY_SECURITY", "Should block final merge when audit fails")

  // Step 9: Remediate and run clean Security Audit -> ALL_PASSED
  const passAuditRes = await registeredTools.security_audit.execute({
    sessionId: "20261018-000000-test",
    status: "PASS",
    findings: [{ id: "SEC-2", severity: "Low", description: "Missing cache header", location: "server.js:20" }],
    summary: "All critical/high issues resolved",
  })
  assert.strictEqual(passAuditRes.status, "PASS")

  nextRes = await registeredTools.next.execute({ sessionId: "20261018-000000-test" })
  assert.strictEqual(nextRes.status, "ALL_PASSED", "Should report ALL_PASSED when security audit passes")

  console.log("✓ DAG engine, dynamic pitfall injection & security gate verified")

  // ==========================================
  // Part 2: Max Rounds & Deadlock Detection
  // ==========================================
  console.log("Testing Max Rounds & Deadlock Detection...")

  await registeredTools.plan.execute({
    sessionId: "20261018-000000-deadlock",
    topology: "distributed-coding",
    tasks: [
      { id: "A", dependsOn: [], maxRounds: 1 },
      { id: "B", dependsOn: ["A"], maxRounds: 2 },
    ],
  })

  // Task A fails at round 1 (maxRounds is 1) -> transitions to blocked
  const updateBlockRes = await registeredTools.task_update.execute({
    sessionId: "20261018-000000-deadlock",
    taskId: "A",
    status: "verified_fail",
    round: 1,
  })
  assert.strictEqual(updateBlockRes.status, "blocked", "Task should be blocked when round >= maxRounds")

  const deadlockNext = await registeredTools.next.execute({ sessionId: "20261018-000000-deadlock" })
  assert.strictEqual(deadlockNext.status, "DEADLOCK", "Should report DEADLOCK when all runnable paths are blocked")

  console.log("✓ Max rounds & deadlock detection verified")

  // ==========================================
  // Part 3: Git Worktree Operations & Synthesizer Conflict Artifact
  // ==========================================
  console.log("Testing Git Worktree Tool & Conflict Resolution...")

  const gitRepoDir = mkdtempSync(join(tmpdir(), "teamwork-git-test-"))
  try {
    execFileSync("git", ["init"], { cwd: gitRepoDir, stdio: ["pipe", "pipe", "pipe"] })
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: gitRepoDir, stdio: ["pipe", "pipe", "pipe"] })
    execFileSync("git", ["config", "user.name", "Test Runner"], { cwd: gitRepoDir, stdio: ["pipe", "pipe", "pipe"] })
    writeFileSync(join(gitRepoDir, "README.md"), "# Teamwork Test Repo\n")
    execFileSync("git", ["add", "README.md"], { cwd: gitRepoDir, stdio: ["pipe", "pipe", "pipe"] })
    execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: gitRepoDir, stdio: ["pipe", "pipe", "pipe"] })

    const gitTools = {}
    await registerTeamworkTools(
      {
        tool: {
          transform: async (cb) => {
            await cb({
              namespace: () => {},
              add: (tool) => {
                gitTools[tool.name] = tool
              },
            })
          },
        },
      },
      gitRepoDir,
    )

    const gitSessionId = `20261018-000000-${Math.random().toString(16).slice(2, 6)}`
    await gitTools.plan.execute({
      sessionId: gitSessionId,
      topology: "distributed-coding",
      tasks: [{ id: "feature-1" }],
    })

    // 1. Setup sentinel worktree
    const sentinelSetup = await gitTools.worktree.execute({
      sessionId: gitSessionId,
      action: "setup",
      role: "sentinel",
    })
    assert(sentinelSetup.worktreePath, "Sentinel worktree path should be returned")
    assert.strictEqual(sentinelSetup.branch, `teamwork/base-${gitSessionId}`)

    // 2. Setup worker worktree
    const workerSetup = await gitTools.worktree.execute({
      sessionId: gitSessionId,
      action: "setup",
      role: "worker",
      taskId: "feature-1",
    })
    assert(workerSetup.worktreePath, "Worker worktree path should be returned")
    assert.strictEqual(workerSetup.branch, `teamwork/${gitSessionId}-feature-1`)

    // 3. Make change in worker worktree and commit
    writeFileSync(join(workerSetup.worktreePath, "feature.txt"), "hello world\n")
    execFileSync("git", ["add", "feature.txt"], { cwd: workerSetup.worktreePath, stdio: ["pipe", "pipe", "pipe"] })
    execFileSync("git", ["commit", "-m", "Add feature.txt"], { cwd: workerSetup.worktreePath, stdio: ["pipe", "pipe", "pipe"] })

    // 4. Test diff
    const diffRes = await gitTools.worktree.execute({
      sessionId: gitSessionId,
      action: "diff",
      taskId: "feature-1",
    })
    assert(diffRes.hasChanges, "Diff should detect worker changes")
    assert(diffRes.content.includes("feature.txt"), "Diff content should mention feature.txt")

    // 5. Test merge into sentinel base
    const mergeRes = await gitTools.worktree.execute({
      sessionId: gitSessionId,
      action: "merge",
      taskId: "feature-1",
    })
    assert(mergeRes.merged, "Merge should succeed without conflict")
    assert(!mergeRes.conflict)

    // 6. Test conflict handling: worker modifies file differently than sentinel
    writeFileSync(join(sentinelSetup.worktreePath, "conflict.txt"), "sentinel version\n")
    execFileSync("git", ["add", "conflict.txt"], { cwd: sentinelSetup.worktreePath, stdio: ["pipe", "pipe", "pipe"] })
    execFileSync("git", ["commit", "-m", "Sentinel commit"], { cwd: sentinelSetup.worktreePath, stdio: ["pipe", "pipe", "pipe"] })

    writeFileSync(join(workerSetup.worktreePath, "conflict.txt"), "worker conflicting version\n")
    execFileSync("git", ["add", "conflict.txt"], { cwd: workerSetup.worktreePath, stdio: ["pipe", "pipe", "pipe"] })
    execFileSync("git", ["commit", "-m", "Worker conflicting commit"], { cwd: workerSetup.worktreePath, stdio: ["pipe", "pipe", "pipe"] })

    const conflictMergeRes = await gitTools.worktree.execute({
      sessionId: gitSessionId,
      action: "merge",
      taskId: "feature-1",
    })
    assert(conflictMergeRes.conflict, "Should detect merge conflict")
    assert(conflictMergeRes.conflictArtifact, "Should generate conflict artifact path")
    assert(existsSync(conflictMergeRes.conflictArtifact), "Conflict artifact file must exist on disk")

    // 7. Test conflict resolution action
    writeFileSync(join(sentinelSetup.worktreePath, "conflict.txt"), "synthesized combined version\n")
    const resolveRes = await gitTools.worktree.execute({
      sessionId: gitSessionId,
      action: "resolve",
      taskId: "feature-1",
      commitMessage: "Resolve conflict.txt via synthesizer",
    })
    assert(resolveRes.resolved, "Resolve action should succeed")

    // 8. Cleanup worktrees
    const cleanupRes = await gitTools.worktree.execute({
      sessionId: gitSessionId,
      action: "cleanup",
    })
    assert(cleanupRes.cleaned, "Cleanup should succeed")

    console.log("✓ Git worktree operations, conflict artifact generation & resolve action verified")
  } finally {
    rmSync(gitRepoDir, { recursive: true, force: true })
  }

  // ==========================================
  // Part 4: CLI Run Management Helpers
  // ==========================================
  console.log("Testing CLI Run Management Helpers...")

  const runsList = listTeamworkRuns(testDir)
  assert(runsList.length >= 2, "Should list created test runs")
  const testRun = runsList.find((r) => r.sessionId === "20261018-000000-test")
  assert(testRun, "Test run should be present in list")
  assert.strictEqual(testRun.securityStatus, "PASS", "Security status should be PASS")

  const inspected = inspectTeamworkRun(testDir, "20261018-000000-test")
  assert(!inspected.error, "Inspect should succeed")
  assert.strictEqual(inspected.run.sessionId, "20261018-000000-test")
  assert(inspected.audit, "Security audit report should be included")
  assert(inspected.pitfalls.length > 0, "Pitfalls should be included")

  console.log("✓ CLI run management helpers verified")
} finally {
  rmSync(testDir, { recursive: true, force: true })
}
