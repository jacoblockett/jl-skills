# Map

Early prototype of `/map`, a durable, queryable intent graph for agents.

The database is authoritative. `/map` and ordinary agents query it through a CLI rather than reading storage files directly. Authoritative graph state and temporary workflow/session continuity are deliberately separate.

## Install the actual agent skill

Keeping `SKILL.md` inside this repository is source control only. It is not automatically discoverable by Codex or another agent harness from `skills/map/`.

Map installs at user scope under the shared Agent Skills path:

```text
~/.agents/skills/map/
```

From the repository root:

```bash
python skills/map/install.py
```

The installer creates `~/.agents/skills/map` as a directory link/junction back to this repository's `skills/map` directory, so a normal `git pull` updates the installed skill immediately. It deliberately does not create a duplicate custom copy under `~/.codex/skills`.

It also creates a dedicated Map runtime outside the repository (`%LOCALAPPDATA%/jl-map/venv` on Windows, the XDG/local-share equivalent elsewhere), installs the Python prototype there, and verifies both skill discovery files and the runtime executable.

The installed skill invokes Map through:

```bash
python "$HOME/.agents/skills/map/map_exec.py" ...
```

so the harness does not need an activated Conda/venv or a globally visible `map-state` executable.

Restart/reload a harness after first install if it caches skill discovery.

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
- validation of the current regression fixture with zero errors/warnings;
- durable session setup/confirmation/frontier checkpoints across fresh CLI processes;
- raw-answer recovery before authoritative mutation;
- applied-answer recovery before session finalization;
- atomic single-decision settlement plus session marker;
- atomic multi-decision settlement batches plus one session marker, preserving JSON value types.

A first functional `SKILL.md` now exists. It deliberately uses the proven parent-agent + CLI workflow without adding a child-agent fleet. The next milestone is end-to-end conversational evaluation of that skill.

Still intentionally incomplete: atomic pending-answer forms for revision/promotion and other structural mutations, transitive affected-descendant mutation, atomic initial baseline creation, general promotion/revision semantics beyond proven fixtures, and polished public packaging.

## Prototype development install

For direct CLI development from `skills/map/`:

```bash
pip install -e .
```

This is **not** the agent-skill installation mechanism. It only exposes `map-state` inside the currently active Python environment.

Use a disposable working directory for prototype testing:

```bash
map-state init
map-state seed-chores
```

`seed-chores` is a development fixture only and is not intended as a production command.

## Skill

`SKILL.md` is the first executable conversational workflow for Map. It defines:

- startup and unfinished-session recovery;
- new-vs-existing scope resolution;
- mandatory scope/setup confirmation;
- `mvp|thorough` depth and `normal|adversarial` stance;
- material-question discovery policy;
- exact frontier checkpointing before questions;
- raw-answer persistence before interpretation/mutation;
- atomic settlement batches;
- read-only query behavior;
- conservative failure handling when a needed mutation does not yet have a safe atomic primitive.

The skill does not spawn subagents by default. Additional agents should be introduced only when a concrete evaluation proves that an independent semantic transaction improves correctness enough to justify the orchestration cost.

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

`history` reconstructs the full supersession lineage. `context` returns compact current authoritative state for a branch. `related` exposes literal direct graph edges. `validate` checks structural invariants without repair. `search` performs deterministic lexical retrieval and excludes superseded history unless `--include-history` is supplied. `explain` gathers graph-supported lineage, ancestors, constraints, prerequisites, dependents, supports, and direct relations without inventing rationale that was never stored.

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

A pending raw answer always takes priority over asking a new question. The old manual `session applied` path is rejected when a pending graph operation exists, preventing the unsafe split between graph mutation and application marker.

Other session controls:

```bash
map-state session status
map-state session confirm
map-state session checkpoint <ids...>
map-state session answer "<raw answer>"
map-state session resume
map-state session advance --phase discovery
map-state session pause
map-state session abandon
map-state session finish
```

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

The larger design/history and integration logs live in the separate private `persist` repository.
