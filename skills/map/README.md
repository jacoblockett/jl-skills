# Map

Early prototype of `/map`, a durable, queryable intent graph for agents.

The database is authoritative. `/map` and ordinary agents query it through a CLI rather than reading storage files directly. Authoritative graph state and temporary workflow/session continuity are deliberately separate.

## Install with `jl-skill`

Map is packaged for the generic `jl-skill` installer. The requested scope controls where the skill, harness integration, runtime, and project state are provisioned.

Examples:

```bash
jl-skill map --scope user
jl-skill map --scope cwd
jl-skill map --scope "C:\Programming\my-project"

jl-skill map --scope cwd --agent codex
jl-skill map --scope cwd --agent codex --agent claude
```

If `--agent` is omitted, `jl-skill` detects supported harnesses and selects all detected ones. Detection does not alter scope. For example, `--scope cwd` installs only at current-project scope even when Codex or Claude were detected from user-level application/configuration paths.

Current first adapters:

- Codex: project skill resources under `.agents/skills`, project instructions in `AGENTS.md`.
- Claude Code: project skill resources under `.claude/skills`, project instructions in `CLAUDE.md`.

For project/path scope, the current Map Python runtime and package files are also provisioned below the target's `.jl-skill/` directory. Map state lives below the target's `.map/` directory. User-level writes for a project-scoped install are limited to `jl-skill` bookkeeping/receipts needed to find and update the installation later.

`skills/map/install.py` and `map_exec.py` were development bootstrap experiments and are no longer the installation contract.

## Build the installer during development

From the repository root:

```bash
go build -o jl-skill.exe .
```

Then, from a disposable project directory:

```bash
/path/to/jl-skill.exe map --scope cwd
```

The current Map runtime still requires Python 3.11+ on the target machine. `jl-skill` installs Map's Python dependency into a scope-local runtime directory rather than modifying the harness's Python environment.

## Package manifest

`jl-skill.json` declares the Map package to the generic installer. It identifies the skill entry, runtime files/dependencies, ordinary-agent instruction fragment, and project initializer. Harness-specific filesystem placement belongs to `jl-skill` adapters rather than this manifest.

`AGENTS.fragment.md` is installer-managed instruction content for ordinary agents. Adapters render the same package contribution into the appropriate instruction file for the selected harness/scope using deterministic managed blocks.

## Current milestone

The Python prototype uses the SurrealDB SDK in embedded `surrealkv://` mode. No SurrealDB server or daemon is required; state persists under `<working-root>/.map/db/`.

Proven locally so far:

- graph nodes for intents, decisions, constraints, criteria, ideas, and facts;
- semantic relation tables and conditional dependencies;
- dependency-aware global and focused frontiers;
- parked idea promotion without fabricated downstream decisions;
- non-destructive decision revision with multi-hop `supersedes` history;
- dependent decisions marked `needs_review` and re-evaluated against current revisions;
- read-only `history`, `context`, `related`, `validate`, `search`, and `explain` queries;
- current-context queries exclude superseded history while history remains queryable;
- durable session setup/confirmation/frontier checkpoints across fresh CLI processes;
- raw-answer recovery before authoritative mutation;
- applied-answer recovery before session finalization;
- atomic single-decision settlement plus session marker;
- atomic multi-decision settlement batches plus one session marker, preserving JSON value types.

A first functional `SKILL.md` exists and uses the proven parent-agent + CLI workflow without adding a child-agent fleet.

Still intentionally incomplete: atomic pending-answer forms for revision/promotion and other structural mutations, transitive affected-descendant mutation, atomic initial baseline creation, general promotion/revision semantics beyond proven fixtures, and polished public packaging.

## Direct prototype development

For direct CLI development from `skills/map/`:

```bash
pip install -e .
```

This is not the agent-skill installation mechanism. It only exposes `map-state` inside the currently active Python environment.

Use a disposable working directory for prototype testing:

```bash
map-state init
map-state seed-chores
```

`seed-chores` is a development fixture only.

## Read/query surface

Ordinary-agent oriented, non-mutating queries:

```bash
map-state history <node>
map-state context <node>
map-state related <node>
map-state validate
map-state search <text>
map-state explain <node>
```

`history` reconstructs supersession lineage. `context` returns compact current authoritative state for a branch. `related` exposes literal direct graph edges. `validate` checks structural invariants without repair. `search` performs deterministic lexical retrieval and excludes superseded history unless `--include-history` is supplied. `explain` gathers graph-supported lineage, ancestors, constraints, prerequisites, dependents, supports, and direct relations without inventing rationale that was never stored.

## Durable workflow session prototype

Session state lives in `map_session`, not the authoritative graph.

Key ordering invariant:

1. persist the exact presented frontier;
2. persist the raw user answer;
3. apply authoritative settlement mutations and the session marker atomically;
4. clear the pending answer and advance.

Single settlement:

```bash
map-state session apply-settle clear-backlog one
```

Batch settlement:

```bash
map-state session apply-settles '{"late-anchor":"preserve-original","local-persistence":true}'
```

Both use the same transaction-safe batch engine. Every target must be actionable and must have appeared in the exact presented frontier for the pending answer.

## Prototype invariants

- `.map/db` is authoritative structured state.
- Session/checkpoint records are workflow state, not user intent.
- No semantic graph mutation should occur through `/map` before scope/setup confirmation.
- Parked ideas are queryable but do not enter the required decision frontier.
- Focus limits candidate decisions, not outside prerequisites needed to evaluate them.
- Historical decisions are preserved rather than overwritten.
- Superseded prerequisites resolve to their current replacement for frontier/context evaluation.
- A changed prerequisite must not leave dependent settled state silently trusted.
- Read/query commands do not mutate authoritative graph state.
- Pending-answer authoritative mutations must not use a split mutation/application-marker sequence.
- External execution systems such as Beads are consumers of Map, not Map responsibilities.

The larger design/history and installer specifications live in the separate private `persist` repository.
