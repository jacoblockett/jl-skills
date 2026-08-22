# Map

Python prototype of `/map`, a durable, queryable graph of user intent for agents and humans.

The graph is authoritative. `/map` and ordinary agents interact with it through the Map CLI rather than reading SurrealKV files directly. Authoritative graph state and temporary workflow/session continuity are separate.

## Installation boundary

Installing the Map skill makes the capability available. It does **not** create a Map database for the installation scope.

A complete Map skill installation includes:

- the harness-discoverable `SKILL.md`;
- the Map runtime/tool used by that skill;
- Map-specific harness agent/subagent helpers where applicable;
- installer-managed ordinary-agent instructions (`AGENTS.md`, `CLAUDE.md`, or harness equivalent).

`.map/` state is created later, when Map is actually used against a working root.

For a user-scope installation, the intended installer-owned runtime layout is:

```text
%LOCALAPPDATA%\JL-Skills\
├─ registry.json
└─ map\
   └─ runtime\
      └─ <semver>\
         └─ ...Map runtime...
```

The installed skill receives the exact runtime path from `jl-skill`; the runtime does not need to sit next to `SKILL.md` or be globally on PATH.

The current prototype runtime is Python. Public-distribution packaging is intentionally deferred until the Python behavior and interface are settled.

## Package manifest

`jl-skill.json` declares Map's skill entry, Python runtime files/dependency, runtime entrypoint, CLI token, and ordinary-agent instruction fragment.

It intentionally does **not** declare an installer-time Map initializer or validator. Installing the skill must not create `.map/` state merely because the user chose an installation scope.

Harness-specific filesystem placement belongs to `jl-skill` adapters rather than the Map manifest.

## Current CLI

Direct prototype development from `skills/map/`:

```bash
pip install -e .
```

This exposes:

```text
map
```

The normal command surface is:

```text
map init
map status
map list
map show <id>
map questions [--focus <id>]
map ideas
map decide <id> <value>
map revise <id> <value>
map promote <id> [--parent <id>]
map add <kind> <subject> [options]
map relate <source> <relation> <target> [options]
map history <id>
map context <id>
map related <id>
map validate
map search <query>
map explain <id>
map session ...
```

`questions` is the human-facing command for the decision frontier. The returned structure still distinguishes `frontier`, `blocked`, and `inapplicable` decisions.

### Node creation

Normal callers do not invent database record IDs:

```bash
map add intent "Build authentication"
map add constraint "No cloud service"
map add decision "What is the minimum password length?" --authority inferred
map add idea "Support passkeys later"
```

Map generates a collision-safe record ID and returns it. `--id` remains available only as an explicit override for import/testing.

Kinds have semantic initial states:

```text
intent      active
decision    open
constraint  active
criterion   active
idea        parked
fact        active
```

State validity is constrained by kind. In particular, a decision is `open`, `decided`, `needs_review`, `inapplicable`, `invalidated`, or `superseded`. `satisfied` is not a decision state.

Authority/provenance remains independent from kind/state. Direct CLI additions default to user provenance except parked ideas, which default to `none`; agents must specify `--authority inferred`, `external`, or `derived` when that is the actual provenance.

### Decision changes

```bash
map decide <id> <value>
```

moves an actionable decision to `decided`. Calling `decide` again on an already-decided node is rejected so authoritative history cannot be silently overwritten.

```bash
map revise <id> <new-value>
```

creates a new generated decision record, marks the previous decision `superseded`, preserves the lineage, and marks directly affected decided dependents `needs_review`. `--new-id` is an explicit import/testing override rather than normal grammar.

## Read/query surface

```bash
map history <id>
map context <id>
map related <id>
map validate
map search <text>
map explain <id>
```

`history` reconstructs supersession lineage. `context` returns compact current authoritative state for a branch. `related` exposes literal direct graph edges. `validate` checks both graph structure and kind/state semantics without repair. `search` performs deterministic lexical retrieval and excludes superseded history unless `--include-history` is supplied. `explain` gathers graph-supported lineage, ancestors, constraints, prerequisites, dependents, supports, and direct relations without inventing rationale that was never stored.

## Durable workflow session prototype

Session state lives in `map_session`, not the authoritative graph. The session command names are intentionally unchanged pending a separate grammar review.

Key ordering invariant:

1. persist the exact presented frontier;
2. persist the raw user answer;
3. atomically apply authoritative decision values and the session application marker;
4. clear the pending answer and advance.

Current commands include:

```bash
map session start ...
map session status
map session confirm
map session checkpoint ...
map session answer ...
map session apply-settle ...
map session apply-settles ...
map session applied
map session advance ...
map session resume
map session pause
map session abandon
map session finish
```

The `apply-settle`/`apply-settles` names are legacy session grammar for now. Their underlying node-state result is `decided`, not `settled`.

## Current milestone

The prototype uses embedded SurrealDB/SurrealKV and persists graph state under `<working-root>/.map/db/`. No SurrealDB daemon is required.

Implemented:

- intents, decisions, constraints, criteria, ideas, and facts;
- semantic relations and conditional dependencies;
- global and focused decision frontiers;
- parked idea promotion;
- non-destructive decision revision and supersession history;
- dependent `needs_review` reopening;
- read-only history/context/related/validate/search/explain queries;
- durable setup/question/answer recovery;
- atomic single- and multi-decision pending-answer application;
- generated collision-safe node IDs;
- kind-specific state validation and migration away from the old `settled` decision state.

Still intentionally incomplete inside a pending-answer cycle: revision/promotion and other structural mutations, transitive affected-descendant mutation, atomic initial baseline creation, and a crash-safe intent-satisfaction lifecycle mutation.

`seed_chores()` remains an internal development fixture in `map_state.py` for prototype evaluation but is no longer part of the public CLI.
