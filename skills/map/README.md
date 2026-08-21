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
- deterministic CLI operations for initializing, inspecting, relating, and settling state;
- dependency-aware frontier calculation with conditional branches;
- promotion of a parked future-goal idea into active user intent;
- a chore-tracker fixture reproducing the initial regression case from `/grill` development.

Not implemented yet: the actual `/map` SKILL.md/agents, general promotion targets, supersession/revision workflows, affected-descendant analysis, rich context queries, or crash-recovery session commands.

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

### Evolution test

The fixture also contains `shared-household` as a parked, non-binding idea. Promotion turns that same record into active user intent and can attach it below an existing intent:

```bash
map-state promote shared-household --parent chores
map-state show shared-household
map-state ideas
```

After promotion it should be `kind: intent`, `state: active`, `authority: user`, and should no longer appear in `map-state ideas`.

The prototype intentionally does not invent the decisions required by the new intent. A reasoning agent would discover those. To simulate that step manually:

```bash
map-state add-node shared-membership decision open user "How should household membership work?"
map-state relate shared-household contains shared-membership
map-state frontier
```

That new decision should participate in the frontier while previously settled decisions remain settled.

Inspect state directly through the CLI:

```bash
map-state status
map-state list
map-state show chores
map-state ideas
```

Use `--root <path>` before the subcommand to operate on another directory without changing into it:

```bash
map-state --root C:/tmp/map-test status
```

## Prototype invariants

- `.map/db` is authoritative structured state.
- Session/checkpoint records are workflow state, not user intent.
- Parked ideas are queryable but do not enter the required decision frontier.
- Promoting an idea activates intent; it does not fabricate downstream decisions.
- Dependency conditions use a tiny non-executable vocabulary owned by the CLI.
- External execution systems such as Beads are consumers of Map, not Map responsibilities.
- The state layer should remain useful even when `/map` is not explicitly invoked.

The larger design/history is intentionally kept outside this repository in the separate `persist` repository so development can be reconstructed if a chat/session is lost.
