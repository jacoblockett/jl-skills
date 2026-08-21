# Map

Early prototype of `/map`, a durable, queryable intent graph for agents.

The database is authoritative. `/map` and ordinary agents query it through a stable CLI rather than reading storage files directly. The current prototype deliberately focuses on the state primitive and read/query surface before conversational skill orchestration.

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
- frontier evaluation resolves dependency prerequisites through multi-hop supersession chains;
- read-only agent queries for history, compact current context, direct relations, and structural validation;
- a chore-tracker fixture reproducing the initial regression case from `/grill` development.

Not implemented yet: the actual `/map` SKILL.md/agents, semantic text search, higher-level explanation queries, general promotion targets, transitive affected-descendant analysis, transaction hardening for multi-write mutations, or crash-recovery session commands.

## Install the prototype

From `skills/map/`:

```bash
python -m venv .venv
# activate the venv for your shell
pip install -e .
```

When pulling a revision that changes `pyproject.toml`, rerun `pip install -e .`.

Then point the prototype at any disposable working directory:

```bash
mkdir ../../map-test
cd ../../map-test

map-state init
map-state seed-chores
map-state frontier
map-state ideas
```

`seed-chores` is a development fixture only. It is not intended as a production command.

## Read/query surface

These commands do not mutate authoritative graph state and are intended to become the ordinary-agent primitive beneath `/map`:

```bash
map-state history <node>
map-state context <node>
map-state related <node>
map-state validate
```

### `history`

Reconstructs the full linear supersession lineage containing the requested node, even when the request points at a middle or historical revision. It reports the original root, the current authoritative revision, and each preserved revision in order.

Example after revising `missed-occurrences` twice:

```bash
map-state history missed-occurrences-v2
```

Expected lineage:

```text
missed-occurrences -> missed-occurrences-v2 -> missed-occurrences-v3
```

with `missed-occurrences-v3` identified as current.

### `context`

Returns a compact current-state branch rather than a whole-database dump. Superseded nodes are omitted from the authoritative view and dependencies resolve to their current replacement.

The result includes:

- the requested node and current effective focus;
- containment ancestors without pulling sibling branches into scope;
- current descendant intents, decisions, constraints, criteria, facts, and parked ideas;
- constraints/facts attached to the focus branch or its ancestors;
- parked ideas directly related to the focus branch;
- current dependency/prerequisite state;
- the focused frontier.

Example:

```bash
map-state context chores
```

Historical revisions remain available through `history`; they are intentionally not mixed into the current authoritative context.

### `related`

Returns every directly adjacent semantic edge for one node, including relation name, direction, the neighboring node, and edge condition/note when present.

```bash
map-state related clear-backlog
```

### `validate`

Checks graph invariants without mutating state. Current validation covers:

- missing relation endpoints;
- containment cycles;
- supersession branching/merging/cycles;
- `superseded` state consistency;
- `needs_review` on non-decisions;
- malformed `depends_on` endpoints and conditions;
- duplicate semantic edges as warnings.

```bash
map-state validate
```

A clean graph reports `"ok": true` with empty `errors`.

## Conditional frontier test

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

## Evolution and locality test

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

## Revision and affected-state test

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

A second revision back to `separate` proves multi-hop resolution and reactivation:

```bash
map-state revise missed-occurrences-v2 missed-occurrences-v3 separate
map-state frontier --focus chores
```

`clear-backlog` remains `needs_review` but becomes actionable again because the current prerequisite now satisfies its condition.

## Prototype invariants

- `.map/db` is authoritative structured state.
- Session/checkpoint records are workflow state, not user intent.
- Parked ideas are queryable but do not enter the required decision frontier.
- Promoting an idea activates intent; it does not fabricate downstream decisions.
- Focus limits candidate decisions, not the external prerequisites needed to evaluate them.
- Historical decisions are preserved rather than overwritten.
- Superseded prerequisites resolve to their current replacement for frontier and context evaluation.
- A changed prerequisite must not leave already-settled dependent decisions silently trusted.
- Current context excludes superseded history while `history` keeps that history queryable.
- Read/query commands must not mutate authoritative graph state.
- Dependency conditions use a tiny non-executable vocabulary owned by the CLI.
- External execution systems such as Beads are consumers of Map, not Map responsibilities.
- The state layer should remain useful even when `/map` is not explicitly invoked.

The larger design/history is intentionally kept outside this repository in the separate `persist` repository so development can be reconstructed if a chat/session is lost.
