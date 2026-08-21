# Map

Early prototype of `/map`, a durable, queryable intent graph for agents.

The database is authoritative. `/map` and ordinary agents will eventually query it through a stable CLI rather than reading storage files directly. The current prototype deliberately focuses on the state primitive before any conversational skill orchestration.

## Current milestone

The prototype uses the Python SurrealDB SDK in embedded `surrealkv://` mode. No SurrealDB server or daemon is required; state is persisted under `<working-root>/.map/db/`.

Implemented so far:

- schemafull graph nodes for intent, decisions, constraints, criteria, ideas, and facts;
- first-class SurrealDB relation tables;
- explicit authority/provenance category on nodes;
- parked ideas distinct from authoritative requirements;
- a small resumable-session table kept separate from the intent graph;
- deterministic CLI operations for initializing, inspecting, relating, settling, promoting, and revising state;
- dependency-aware frontier calculation with conditional branches;
- focused frontier queries over recursively contained subgraphs;
- promotion of a parked future-goal idea into active user intent;
- non-destructive decision revision using `supersedes` history;
- direct settled decision dependents marked `needs_review` when their prerequisite is revised;
- frontier evaluation resolves dependency prerequisites through supersession chains;
- a chore-tracker fixture reproducing the initial regression case from `/grill` development.

Not implemented yet: the actual `/map` SKILL.md/agents, general promotion targets, transitive affected-descendant analysis, rich context/search/explanation queries, transaction hardening for multi-write mutations, or crash-recovery session commands.

## Try it

From `skills/map/`:

```bash
python -m venv .venv
# activate the venv for your shell
pip install -e .
```

Then point the prototype at any disposable working directory:

```bash
mkdir ../../map-test
cd ../../map-test

map-state init
map-state seed-chores
map-state frontier
map-state ideas
```

The fixture initially leaves several decisions open. `clear-backlog` is blocked because it depends on `missed-occurrences`.

Settle the prerequisite to the branch that makes the child irrelevant:

```bash
map-state settle missed-occurrences collapse
map-state frontier
```

`clear-backlog` should now appear under `inapplicable`, not the frontier.

Reset and take the other branch:

```bash
map-state seed-chores
map-state settle missed-occurrences separate
map-state frontier
```

`clear-backlog` should now become frontier-eligible.

### Evolution and locality test

The fixture also contains `shared-household` as a parked, non-binding idea. Promotion turns that same record into active user intent and can attach it below an existing intent:

```bash
map-state promote shared-household --parent chores
map-state add-node shared-membership decision open user "How should household membership work?"
map-state relate shared-household contains shared-membership
```

A global frontier still sees all unresolved work:

```bash
map-state frontier
```

A focused frontier only considers decisions in the requested containment subtree while still honoring prerequisites outside that subtree:

```bash
map-state frontier --focus shared-household
```

That focused result should contain only `shared-membership`.

### Revision and affected-state test

Map does not overwrite historical decisions. A revision creates a replacement node and a `supersedes` relation. Dependencies that still reference the historical decision resolve to the newest replacement.

```bash
map-state seed-chores
map-state settle missed-occurrences separate
map-state settle clear-backlog one
map-state revise missed-occurrences missed-occurrences-v2 collapse
```

Expected behavior:

- original `missed-occurrences` becomes `superseded`;
- `missed-occurrences-v2` is a new settled user decision with value `collapse`;
- `clear-backlog`, which had been settled based on the old decision, becomes `needs_review`;
- frontier evaluation follows the supersession chain, sees the new `collapse` value, and classifies `clear-backlog` as inapplicable rather than silently trusting stale state.

Inspect with:

```bash
map-state show missed-occurrences
map-state show missed-occurrences-v2
map-state show clear-backlog
map-state frontier --focus chores
```

## Prototype invariants

- `.map/db` is authoritative structured state.
- Session/checkpoint records are workflow state, not user intent.
- Parked ideas are queryable but do not enter the required decision frontier.
- Promoting an idea activates intent; it does not fabricate downstream decisions.
- Focus limits candidate decisions, not the external prerequisites needed to evaluate them.
- Historical decisions are preserved rather than overwritten.
- Superseded prerequisites resolve to their current replacement for frontier evaluation.
- A changed prerequisite must not leave already-settled dependent decisions silently trusted.
- Dependency conditions use a tiny non-executable vocabulary owned by the CLI.
- External execution systems such as Beads are consumers of Map, not Map responsibilities.
- The state layer should remain useful even when `/map` is not explicitly invoked.

The larger design/history is intentionally kept outside this repository in the separate `persist` repository so development can be reconstructed if a chat/session is lost.
