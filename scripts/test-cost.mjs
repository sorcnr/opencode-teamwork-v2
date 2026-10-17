import { registerTeamworkTools } from "../plugins/opencode-teamwork/tools.ts"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import assert from "node:assert"

const testDir = mkdtempSync(join(tmpdir(), "teamwork-test-"))

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
    session: {
      get: async ({ sessionID }) => {
        if (sessionID === "ses_mock_root") {
          return { cost: 0.15, tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } } }
        }
        return undefined
      },
    },
  }

  await registerTeamworkTools(mockCtx, testDir)

  assert(registeredTools.plan, "plan tool must be registered")
  assert(registeredTools.cost, "cost tool must be registered")

  // 1. Test plan creates run and records root session
  const planRes = await registeredTools.plan.execute(
    {
      topology: "small-focused",
      tasks: [{ id: "task-1" }],
    },
    { sessionID: "ses_eda9eef41ffe6AwWb3fM1kvOnz" },
  )

  assert(planRes.content.includes("Planned 1 task"), "Plan should succeed")

  // 2. Test cost tool reading real opencode DB session tree
  const costRes = await registeredTools.cost.execute({}, { sessionID: "ses_eda9eef41ffe6AwWb3fM1kvOnz" })
  assert(costRes.content.includes("opencode session tree"), "Should report opencode session tree as source")
  assert(costRes.content.includes("spent: $"), "Should report spent amount")
  assert(costRes.pct > 0, "Percentage should reflect total consumption")

  // 3. Second call should not double count
  const costRes2 = await registeredTools.cost.execute({}, { sessionID: "ses_eda9eef41ffe6AwWb3fM1kvOnz" })
  assert.strictEqual(costRes.pct, costRes2.pct, "Percentage should remain identical on immediate re-call")

  // 4. Test manual addUsd fallback when native client/tree is unavailable
  const mockOfflineCtx = {
    tool: mockCtx.tool,
    session: { get: async () => undefined },
  }
  let offlineTools = {}
  mockOfflineCtx.tool.transform = async (cb) => {
    await cb({
      namespace: () => {},
      add: (tool) => {
        offlineTools[tool.name] = tool
      },
    })
  }
  await registerTeamworkTools(mockOfflineCtx, testDir)

  await offlineTools.plan.execute(
    {
      topology: "small-focused",
      tasks: [{ id: "task-1" }],
    },
    { sessionID: "ses_offline_test" },
  )

  const costOffline = await offlineTools.cost.execute({ addUsd: 1.5, taskId: "T1" }, { sessionID: "ses_offline_test" })
  assert(costOffline.content.includes("spent: $1.5"), "Should record 1.5 in manual fallback mode")
  assert(costOffline.content.includes("manual (client unavailable)"), "Source should be manual")

  console.log("✓ test-cost passed: session tree aggregation & manual fallback verified")
} finally {
  rmSync(testDir, { recursive: true, force: true })
}
