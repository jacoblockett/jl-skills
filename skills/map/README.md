# Map

Early prototype of `/map`, a durable, queryable intent graph for agents.

The database is authoritative. `/map` and ordinary agents query it through a CLI rather than reading storage files directly. Authoritative graph state and temporary workflow/session continuity are deliberately separate.

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
- validation of the current regression fixture with zero errors/warnings.

Implemented but awaiting local integration proof:

- durable `/map` session start/confirmation/checkpoint/resume state;
- raw-answer persistence before graph mutation;
- explicit recovery priority after a process/session interruption.

Still intentionally unimplemented: the conversational `/map` SKILL.md/agents, transitive affected-descendant analysis, atomic coupling of multi-write graph mutation with session recovery markers, general promotion/revision semantics beyond proven fixtures, and public packaging.

## Install

From `skills/map/`:

```bash
pip install -e .
```

Rerun that after pulling a revision that changes `pyproject.toml`.

Use a disposable working directory for prototype testing:

```bash
map-state init
map-state seed-chores
```

`seed-chores` is a development fixture only and is not intended as a production command.

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

```bash
map-state session start --invocation "map chores" --interpreted "Continue chore decisions" --focus chores
map-state session status
map-state session confirm
map-state session checkpoint clear-backlog
map-state session answer "Keep clearing one occurrence." --operation "settle clear-backlog one"
map-state session resume
```

Key ordering invariant:

1. persist the exact presented frontier;
2. persist the raw user answer;
3. apply graph mutation;
4. mark that application successful;
5. clear the pending answer and advance.

Recovery commands:

```bash
map-state session applied
map-state session advance --phase discovery
map-state session resume
map-state session pause
map-state session abandon
map-state session finish
```

A pending raw answer always takes priority over asking a new question. The prototype refuses to discard an unapplied answer unless `session advance --no-mutation` explicitly states no graph mutation was required.

The graph mutation and `session applied` marker are not yet one atomic transaction, so full crash-atomic mutation is not claimed yet.

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
- External execution systems such as Beads are consumers of Map, not Map responsibilities.

The larger design/history and integration logs live in the separate private `persist` repository.
