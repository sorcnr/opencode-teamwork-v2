# awesome-opencode submission

Draft for a pull request to [`awesome-opencode/awesome-opencode`](https://github.com/awesome-opencode/awesome-opencode).

The list has no `CONTRIBUTING.md`; entries are `<details>` blocks inside the
`PLUGINS` section of `README.md`, kept in case-insensitive alphabetical order by
display name.

## Insert location

Inside the `🧩 PLUGINS` `<details open>` block, alphabetically **before
`Opencode Telemetry`** (it also sits next to the other orchestration plugins:
FlowDeck, OpenCode Ensemble, OpenCode Swarm, OpenCode Mission Control).

## Entry HTML (insert verbatim)

```html
<details>
  <summary><b>OpenCode Teamwork</b> <img src="https://badgen.net/github/stars/sorcnr/opencode-teamwork-v2" height="14"/> - <i>Antigravity-style multi-agent orchestration with verification loops</i></summary>
  <blockquote>
    Brings the Antigravity-style Teamwork orchestration model to OpenCode V2: 10 specialist agents (Sentinel, Orchestrator, Crafter, Scout, Worker, Proof Worker, Proposer, Falsifier, Synthesizer, Verifier) and 7 slash commands. Ships a DAG task runner, per-agent git worktrees, a verification engine that loops until PASS, cost tracking, and a 9-step prompt-crafting wizard. Install from npm (<code>opencode-teamwork-v2</code>) or directly from GitHub; an interactive installer asks which model each agent should use.
    <br><br>
    <a href="https://github.com/sorcnr/opencode-teamwork-v2">🔗 <b>View Repository</b></a>
  </blockquote>
</details>
```

## PR title

```
Add OpenCode Teamwork — multi-agent orchestration plugin
```

## PR body

```markdown
## What is this?

**OpenCode Teamwork** is an OpenCode V2 plugin that brings the Antigravity-style
Teamwork orchestration model to the terminal: a Sentinel coordinator dispatches a
DAG of specialist agents, each in its own git worktree, and a verifier gates every
task until it passes.

- **Repo:** https://github.com/sorcnr/opencode-teamwork-v2
- **npm:** `opencode-teamwork-v2`
- **Install:** `opencode plugin add opencode-teamwork-v2` (or `github:sorcnr/opencode-teamwork-v2`)

## Highlights

- 10 agents: Sentinel, Orchestrator, Crafter, Scout, Worker, Proof Worker,
  Proposer, Falsifier, Synthesizer, Verifier
- 7 slash commands (`/teamwork`, `/teamwork-craft`, `/team-orchestrate`,
  `/team-propose`, `/team-falsify`, `/team-synthesize`, `/team-review`)
- DAG runner, per-agent git worktrees, verification loops until PASS, cost tracking
- 9-step prompt-crafting wizard
- Interactive installer that asks which model each agent should use
  (writes agent frontmatter + `teamwork.json`)

## Checklist

- [x] Added one entry to the `PLUGINS` section in alphabetical order
- [x] Follows the existing `<details>` / `<blockquote>` format
- [x] Links to the public repository
- [x] MIT licensed

Thanks for maintaining the list!
```
