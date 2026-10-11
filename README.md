# opencode-teamwork-v2

An **OpenCode V2 port** of [`opencode-teamwork`](https://github.com/aditya0si/OpenCode-Team) —
Antigravity-style multi-agent orchestration for OpenCode.

The original package only implements the **OpenCode V1 plugin API**, so it fails
to load on OpenCode V2:

```
failed to load plugin
PluginModule.LoadError: Plugin must export a default definition with an id and
an effect or setup function. (cause: SchemaError(Expected object at ["default"]))
```

This repo is the ported, V2-native version: same 10 agents and 7 slash commands,
rewritten for the V2 plugin + agent APIs. Verified against **OpenCode `v2.0.26`**.

## What changed (V1 → V2)

| Original (V1) | This port (V2) |
| --- | --- |
| Default export = async plugin function returning a `config` hook | Default export = `{ id, setup }` definition (exactly what `Plugin.define({...})` returns) |
| `config` hook injects 10 agents | **Not possible in a V2 plugin** — the `AgentEditor` has no `add`. Agents are installed as markdown files: `agents/team/*.md` |
| `config` hook injects 7 commands | Registered by the plugin via `ctx.command.transform(...)` → `editor.add(...)` |
| Commands used `{{ ... }}` handlebars + `agent:` frontmatter | V2 has neither; `$ARGUMENTS` substitution in the plugin, agent switching via `ctx.session.switchAgent(...)` |
| Agent perms `edit/bash/webfetch/task` | V2 `permissions` array: `edit/shell/webfetch/subagent` |

## Layout

```
agents/team/*.md                 # 10 team agents (markdown, V2 frontmatter)
plugins/opencode-teamwork/
├── index.ts                     # V2 plugin, registers the 7 commands
├── package.json
└── README.md
```

## Install

1. Copy the pieces into your global OpenCode config directory:

   ```sh
   CFG="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
   mkdir -p "$CFG/agents/team" "$CFG/plugins"
   cp -r agents/team/*.md "$CFG/agents/team/"
   cp -r plugins/opencode-teamwork "$CFG/plugins/"
   ```

2. Add the plugin to `$CFG/opencode.json`:

   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": [
       "/absolute/path/to/.config/opencode/plugins/opencode-teamwork"
     ]
   }
   ```

   Relative paths work too if your setup resolves them against the config
   directory; an absolute path is the least surprising.

3. Reload (or restart) OpenCode, then verify:

   ```sh
   opencode plugin list        # opencode-teamwork  local  .../plugins/opencode-teamwork/index.ts
   opencode debug agents       # should list team/sentinel, team/worker, ...
   ```

   To activate without a restart: `opencode reload`.

## Commands

| Command | Agent | Purpose |
| --- | --- | --- |
| `/teamwork` | `team/sentinel` | Main dispatcher — loads a spec, provisions a worktree, builds the DAG, dispatches workers + verifiers, merges |
| `/teamwork-craft` | `team/crafter` | 9-step elicitation wizard that produces `prompt_draft.md` |
| `/team-orchestrate` | `team/orchestrator` | Legacy v1 propose/falsify/synthesize/verify loop |
| `/team-propose` | `team/orchestrator` | Run only the propose step |
| `/team-falsify` | `team/orchestrator` | Run only the falsifier step |
| `/team-synthesize` | `team/orchestrator` | Run only the synthesizer step |
| `/team-review` | `team/orchestrator` | Run the verifier on the current artifact |

## Agents

`team/crafter`, `team/sentinel`, `team/worker`, `team/proof-worker`,
`team/verifier`, `team/orchestrator`, `team/proposer`, `team/falsifier`,
`team/synthesizer`, `team/scout`.

Model assignments live in each agent's frontmatter (`model:`). This repo ships
with DeepSeek defaults:

- `deepseek/deepseek-v4-pro`: sentinel, orchestrator, synthesizer, verifier, falsifier, proof-worker
- `deepseek/deepseek-flash`: crafter, worker, proposer, scout

Change them per agent, or set them in your `opencode.json` under `agents`.

## Notes

- The plugin is intentionally **dependency-free at runtime** — it does not import
  `@opencode/plugin`, so the loader never needs to resolve `node_modules` for it.
  The exported object shape is identical to `Plugin.define({ id, setup })`.
- V2 agents cannot be created by a plugin, so the plugin only registers commands.
  If you prefer no plugin at all, move the 7 command definitions into markdown
  files under `~/.config/opencode/commands/` (V2 discovers them natively).
- Docs: <https://opencode.ai/v2/docs/build/plugins>

## License & attribution

MIT. Ported from [`aditya0si/OpenCode-Team`](https://github.com/aditya0si/OpenCode-Team)
by Aditya Singh; the original MIT notice is preserved in [LICENSE](LICENSE).
