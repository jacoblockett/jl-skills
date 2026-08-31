# `/map` durable intent graph

Status: accepted target contract for the Map v2 Rust rewrite.

This document replaces the previous Map ontology and CLI contract. The old Python runtime in `jacoblockett/jl-skills/skills/map/` implemented the obsolete v1 model and is not authoritative for v2 behavior. V2 is a clean Rust implementation and should follow this contract rather than preserve old command/state compatibility.

Map remains intentionally small. Add machinery only when the semantic model requires it or real use demonstrates a need.

## 1. Purpose

Map is a durable, local, queryable graph of user intent and the reasoning artifacts needed to clarify that intent.

It is domain-agnostic. A Map can represent software, products, purchases, trips, research, fictional worldbuilding, business ideas, personal projects, or any other request that benefits from progressive clarification.

The graph preserves:

- user intents;
- questions discovered while exploring those intents;
- decisions made by the user or assistant;
- facts relevant to graph nodes;
- parked ideas;
- dependencies;
- provenance/reasoning where required;
- abandonment and replacement history;
- enough lifecycle state for an agent to know what has been examined, asked, answered, finalized, or deliberately discarded.

Map is not a task tracker, universal export system, rules engine, or generic knowledge graph.

The `.map/` graph is authoritative semantic state. Session state is conversational recovery only.

## 2. Clean-slate rewrite rule

The v1 semantic model is obsolete.

Do not preserve or reintroduce these v1 concepts merely for compatibility:

```text
constraint node
criterion node
decision-as-question
decision value stored on question/decision hybrid
related_to
constrains
supports
conditional dependency expressions
decision frontier/frontier terminology
needs_review propagation
promote
generic add
revise
```

No migration from v1 `.map/` state is required for this rewrite unless explicitly requested later.

The Rust implementation is the canonical v2 behavior source. Do not maintain a parallel Python v2 implementation or compatibility layer.

## 3. Storage and path resolution

The public executable is:

```text
map
```

Global grammar:

```text
map [--path PATH] [--config PATH] <command>
```

Except for `map init`, normal commands require an existing `.map` container.

### 3.1 Map path resolution

Resolve the target in this order:

1. `--path PATH`;
2. `path` from `.maprc` found at the `--config` location;
3. `path` from `.maprc` in the current working directory;
4. current working directory.

A selected path may name either:

```text
/path/to/project
/path/to/project/.map
```

For normal commands, either form is valid only when it resolves to the same existing `.map` container.

If steps 1, 2, or 3 provide a path and that selection cannot resolve to a valid Map, reject. Do not silently continue to lower-priority path sources.

Step 4 is used only when no path was supplied by steps 1-3.

### 3.2 `map init`

```text
map [--path PATH] [--config PATH] init [--schema PATH]
```

`init` uses the same path-selection order, but its purpose is to create the `.map` container.

The selected project/root location must be resolvable. If the selected path explicitly names a not-yet-created `.map`, its parent must be resolvable.

If a `.map` already exists at the selected target, reject. `init` never reinitializes or overwrites an existing Map.

Schema resolution:

1. `--schema PATH`;
2. schema entry from `.maprc` at the `--config` location;
3. schema entry from `.maprc` in cwd;
4. `schema.surql` in the installed runtime's own scope-local tooling root, resolved from the running executable (`<scope>/.jl-skills/map/bin/map[.exe]` -> `<scope>/.jl-skills/map/schema.surql`).

If an explicitly/config-selected schema path cannot be resolved, reject rather than falling back.

A direct development build that is not running from the installed scope-local tooling layout should supply `--schema` or configure a schema path explicitly.

The exact `.maprc` serialization format is an implementation detail for the rewrite, but it must support the path/schema lookup semantics above.

### 3.3 Storage boundary

All Map-owned project semantic/recovery data lives under the resolved `.map` container. The embedded database remains local and requires no SurrealDB daemon or listening port.

Agents must use the Map CLI rather than edit SurrealKV directly.

Project identity metadata is also local to the `.map` container and is defined in section 31. There is no machine-level Map project registry.

## 4. Map-level discovery settings

Each Map stores:

```text
depth:  mvp | thorough
stance: normal | adversarial
```

Defaults:

```text
depth:  mvp
stance: normal
```

These are Map-wide settings.

An intent may optionally have its own fields named exactly:

```text
depth
stance
```

If an intent's field exists, it overrides the Map value for that intent. If absent, the intent inherits the Map value.

Do not rename these concepts to `defaultDepth`, `depthOverride`, etc.

Map-level mutation:

```text
map set depth <mvp|thorough>
map set stance <normal|adversarial>
```

Intent-level mutation:

```text
map set <intent-id> depth <mvp|thorough|null>
map set <intent-id> stance <normal|adversarial|null>
```

`null` removes the intent-specific value and restores inheritance.

If changing a Map-level or intent-level value makes the effective discovery requirement stricter for an already closed intent, that intent must become `closed=false`. Specifically:

```text
mvp -> thorough
normal -> adversarial
```

Relaxing the requirement does not automatically close anything.

### 4.1 Depth

`mvp`: discover the material questions necessary to make the smallest coherent useful result possible. No arbitrary question quota.

`thorough`: also discover consequential adjacent questions that materially improve completeness, robustness, maintainability, usability, feasibility, or downstream decision quality. It still excludes speculative branch explosion.

### 4.2 Stance

`normal`: clarify without unnecessary challenge.

`adversarial`: actively test assumptions, contradictions, feasibility, dependency/failure conditions, and material edge cases.

Stance changes challenge level, not breadth by itself.

## 5. Node ontology

V2 has exactly five node kinds:

```text
intent
question
decision
idea
fact
```

No `constraint` or `criterion` kind exists.

Every node has:

```text
id
kind
primary semantic payload
keywords: string[]
abandoned: bool
abandonedReason: string | none
abandonedBy: user | assistant | none
```

The exact internal field name used for the primary semantic payload may be node-type-specific or shared, but the public CLI must not recreate the old confusing `subject` + generic `value` model.

`keywords` are optional retrieval hints. They do not change semantic behavior.

Normal creation generates and returns a node ID. The public v2 creation API does not need caller-supplied IDs unless a later concrete import/testing requirement establishes the need.

## 6. Intent nodes

Creation:

```text
map create intent <intent> [--context CONTEXT] [--depth DEPTH] [--stance STANCE]
```

An intent is something the user wants to achieve, define, resolve, decide, or develop.

The intent payload should remain brief. `--context` carries additional clarification when the short payload is insufficient for later recovery/understanding.

Intent-specific fields:

```text
context: string | none
explored: bool
closed: bool
depth: mvp | thorough | none
stance: normal | adversarial | none
```

Defaults:

```text
explored: false
closed: false
depth: none
stance: none
```

### 6.1 `explored`

`explored=true` means an LLM has actually examined/reasoned about the intent at least once.

It does NOT mean:

- all possible questions have been discovered;
- the intent has any questions at all;
- existing questions are answered;
- further exploration would have no value;
- the intent is complete.

It is explicitly a durable hint answering:

> Has an LLM even looked at this intent yet?

Only the LLM/user workflow explicitly changes it:

```text
map set <intent-id> explored <true|false>
```

Adding questions, decisions, dependencies, facts, ideas, or other graph material does not implicitly reset `explored`.

### 6.2 `closed`

`closed=true` means the intent has been explored thoroughly enough for its effective `depth` and `stance` and is currently considered finalized for Map purposes.

Mutation:

```text
map set <intent-id> close <true|false>
```

`close true` must reject unless closure invariants hold.

At minimum:

- `explored=true`;
- all current non-abandoned questions in the intent's active scope are answered or abandoned;
- all intent dependencies are satisfied by closed prerequisite intents;
- all non-abandoned contained child intents that remain part of the scope are closed;
- no current non-abandoned decision in the intent's active scope is `soft=true`.

`close false` is always legal.

The runtime must automatically set `closed=false` when new graph structure makes the existing closure claim stale, including at least:

- adding/attaching a new unanswered question to the closed intent;
- adding any new intent dependency to a closed intent, even when the prerequisite is already closed;
- adding/attaching a new non-abandoned unclosed child intent;
- increasing the effective depth or stance as described above.

These events do not change `explored`.

## 7. Question nodes

Creation:

```text
map create question <question> --intent <intent-id> [--reason REASON]
```

A question is an unresolved question the model may present to the user while clarifying an intent.

Questions are first-class nodes. They do not store answers directly.

Fields:

```text
reason: string | none
asked: bool
```

Default:

```text
asked: false
```

`--reason` is encouraged when the reason for asking will not be obvious from the question itself.

Mutation:

```text
map set <question-id> asked <true|false>
```

A question is **answered** when it has a current non-abandoned decision related as its answer. `answered` is derived state, not a mutable boolean.

A question may have at most one current answering decision. Historical replaced decisions do not violate that invariant.

Attaching a decision to an already-answered question rejects unless the existing decision has first been replaced/abandoned/detached as appropriate.

## 8. Decision nodes

Creation:

```text
map create decision <decision>
    [--question QUESTION_ID]
    [--source user|assistant]
    [--assistant-reasoning REASONING]
    [--notes NOTES]
    [--soft]
```

A decision is an actual choice/asserted answer. It is not an unresolved question.

A decision may directly answer a question, or it may be created independently and related to an intent later.

`--question` immediately creates the question-answer relationship.

`source` defaults to `user` when omitted.

Fields:

```text
source: user | assistant
assistantReasoning: string | none
notes: string | none
soft: bool
```

Rules:

- if `source=assistant`, `--assistant-reasoning` is required;
- if `source=user`, assistant reasoning is forbidden;
- `notes` may qualify the decision but must not duplicate the decision payload or be used as a dumping ground for assistant reasoning;
- `soft=true` still counts as an answered/usable decision during ordinary traversal;
- any current soft decision in an intent's active scope prevents that intent from being closed.

Mutation:

```text
map set <decision-id> soft <true|false>
```

Hardening a soft decision is therefore:

```text
map set <decision-id> soft false
```

## 9. Idea nodes

Creation:

```text
map create idea <idea>
```

An idea is a parked/non-binding possibility worth remembering without expanding into active intent/work yet.

Ideas have no special lifecycle field beyond common abandonment/replacement history.

An idea may later be related as context or replaced by a new idea. V2 does not need the old `promote` command; if an idea becomes a real intent, create the intent and preserve whatever explicit history/relationship is actually needed rather than mutating kinds.

## 10. Fact nodes

Creation:

```text
map create fact <fact> [--made-by user|assistant]
```

A fact is established contextual information relevant to one or more nodes.

Fields:

```text
madeBy: user | assistant
```

`madeBy` defaults to `user` when omitted.

Facts are contextual information, not dependency gates.

## 11. Abandonment

Every node kind can be abandoned:

```text
map abandon <id> --by user|assistant --reason REASON
```

Abandonment means the semantic item is deliberately being thrown out while retaining it so Map does not accidentally revive/recreate it later.

The operation atomically records:

```text
abandoned=true
abandonedBy=<by>
abandonedReason=<reason>
```

Abandoned nodes:

- are retained;
- remain available through explicit historical/abandoned inspection;
- are excluded from normal current inspection/readiness;
- do not become current merely because another node still has an old literal edge to them.

There is no normal `unabandon` operation in v2. If a discarded concept genuinely returns, represent the new current semantic state explicitly rather than erasing the abandonment event.

Abandoning an answering decision makes its question unanswered again unless another current decision answers it. If that question belongs to a closed intent, the intent must reopen.

An abandoned question does not block intent closure.

An abandoned prerequisite question counts as disposed for question-dependency readiness. An abandoned prerequisite intent does not satisfy an intent dependency; the dependent intent remains blocked until the relationship/state is changed deliberately.

## 12. `map set`

`set` is for small, explicit state/config mutations. It is not a generic node-content editor.

Map-level:

```text
map set depth <mvp|thorough>
map set stance <normal|adversarial>
```

Node-level:

```text
map set <id> <property> <value>
```

Legal node properties:

```text
intent:
  explored <bool>
  close <bool>
  depth <mvp|thorough|null>
  stance <normal|adversarial|null>
  keywords <string[]>

question:
  asked <bool>
  keywords <string[]>

decision:
  soft <bool>
  keywords <string[]>

idea:
  keywords <string[]>

fact:
  keywords <string[]>
```

Attempting to set a property that does not exist for the target node kind rejects.

Semantic payload text, provenance, reasons, notes, and replacement history are not generic `set` fields. Use the appropriate creation/replacement/action semantics instead.

## 13. Relationship model

Public grammar:

```text
map relate <source-id> <target-id...> [--dependent]
```

Callers do not provide relation names. The runtime infers and stores the semantic relation from endpoint kinds plus `--dependent`.

All endpoints must already exist.

Only the relationship shapes defined here are legal. Everything else rejects.

### 13.1 Intent -> question

```text
map relate <intent> <question...>
```

Attaches questions to an intent.

`map create question ... --intent` is the common atomic creation form; `relate` exists because nodes may need to be attached later without recreating them.

Attaching an unanswered question to a closed intent reopens it.

### 13.2 Question -> decision

```text
map relate <question> <decision>
```

Marks the decision as the current answer to the question.

A question may have at most one current non-abandoned answering decision.

`map create decision ... --question` is the common atomic form.

### 13.3 Intent -> decision

```text
map relate <intent> <decision...>
```

Attaches a preemptive/standalone decision directly to an intent when no question was needed.

### 13.4 Intent -> intent

Without `--dependent`:

```text
map relate <intent> <intent...>
```

Creates hierarchical intent containment/sub-intent structure.

Containment must be acyclic.

With `--dependent`:

```text
map relate <intent> <intent...> --dependent
```

The first intent depends on every following intent.

Dependency direction is:

```text
SOURCE depends on TARGET(S)
```

Each prerequisite target must be `closed=true` before the source dependency is satisfied.

Intent dependency graphs must be acyclic. Codependencies/cycles are rejected in v2.

Adding any new intent dependency to a closed source intent reopens the source, even if every new prerequisite is already closed. The dependency changes what the source's previous closure assertion was based on.

### 13.5 Question -> question dependency

```text
map relate <question> <question...> --dependent
```

The first question depends on every following question.

Each prerequisite question must be answered or abandoned before the source question is ready.

Question dependency graphs must be acyclic. Codependencies/cycles are rejected in v2.

A question-to-question relation without `--dependent` has no defined MVP semantics and rejects.

### 13.6 Any -> fact

```text
map relate <any-node> <fact...>
```

Attaches relevant fact context to the source node.

This is contextual association, not dependency.

### 13.7 Any -> idea

```text
map relate <any-node> <idea...>
```

Attaches a parked idea to the source node as contextual possibility.

This is contextual association, not dependency.

### 13.8 Internal representation

The CLI intentionally hides relation-table names, but the database must still store enough typed semantics to distinguish:

- containment;
- question answer;
- dependency;
- fact context;
- idea context;
- replacement/history.

Do not collapse these into one semantically opaque generic edge.

## 14. Removing relationships

A relationship must be correctable without deleting either endpoint.

Public grammar:

```text
map unrelate <source-id> <target-id...> [--dependent]
```

It uses the same endpoint/flag inference as `map relate` and removes only the matching inferred relationship.

The runtime must reject an ambiguous or nonexistent relationship rather than guess.

Removing a relationship must leave the graph structurally valid. If a future invariant makes a specific removal unsafe, reject rather than silently repair unrelated nodes.

This command exists because otherwise an accidentally-created dependency/attachment could not be corrected.

## 15. Replacement and history

Normal replacement:

```text
map replace <old-id> <new-id> --reason REASON
```

Rules:

- both nodes must already exist;
- nodes must be the same kind;
- reason is mandatory;
- the old node becomes historical/inert;
- the new node becomes current in the old node's semantic graph position;
- current semantic relationships that belonged to the old node transfer/follow to the replacement where valid;
- replacement must be atomic and reject if transferring the position would violate an invariant;
- normal inspection resolves to the current replacement;
- the old node remains available through history.

Replacement history must be acyclic and have an unambiguous current node.

### 15.1 In-place replacement

```text
map replace <old-id> <new-id> --reason REASON --in-place
```

This is intentionally destructive.

The new node takes the old node's graph position. The old node and its incident old-position relationships are removed rather than retained as a superseded historical node.

The new node's own valid preexisting relationships are retained. Transferring the old position must not create duplicates/cycles/cardinality violations; reject atomically if it would.

The replacement reason must still be retained as replacement metadata even though the old node itself is removed. Exact internal storage is an implementation detail.

`--in-place` is not an update/mutate-in-place operation. The command still has distinct old/new node IDs.

## 16. Physical deletion

```text
map delete <id...> [--force]
```

Deletion is different from abandonment:

```text
abandon = retain semantic history, stop considering it current
delete  = physically remove data
```

Without `--force`, reject deletion when the node has incident semantic relationships whose removal could affect other graph nodes. This includes dependencies in either direction and other structural/current relationships.

The normal workflow should surface those affected relationships to the user before retrying destructively.

With `--force`:

- delete the selected node(s);
- delete their incident edges;
- do not recursively delete neighboring nodes;
- do not invent replacement relationships;
- do not silently cascade into unrelated records.

Historical/replacement relationships count as incident relationships for safety.

## 17. Inspection principles

Normal inspection is current-state oriented.

Unless the command exists specifically to inspect history:

- resolve replaced nodes to their current version;
- exclude abandoned nodes by default;
- exclude closed/answered material where the command's normal workflow does not need it;
- return IDs when the purpose is discovery/filtering;
- return raw/structured node data when the purpose is inspection.

All output ordering must be deterministic.

## 18. `map get`

### 18.1 Intents

```text
map get intents
    [--id ID...]
    [--explored | --unexplored]
    [--closed]
    [--abandoned]
    [--limit N]
```

Default:

- current intents;
- both explored and unexplored;
- excludes closed;
- excludes abandoned.

`--closed` includes closed intents.

`--abandoned` includes abandoned intents.

`--explored` and `--unexplored` are mutually exclusive filters.

Returns IDs.

### 18.2 Questions

```text
map get questions
    [--id ID...]
    [--intent ID...]
    [--asked | --unasked]
    [--answered]
    [--abandoned]
    [--include-blocked]
    [--limit N]
```

Default returns questions that are:

- current;
- not abandoned;
- unanswered;
- dependency-ready.

Both asked and unasked are included unless filtered.

`--include-blocked` additionally includes unanswered questions whose prerequisite questions are not yet resolved.

`--answered` additionally includes answered questions.

`--abandoned` additionally includes abandoned questions.

`--asked` and `--unasked` are mutually exclusive filters.

Returns IDs.

This default is the v2 replacement for the old frontier concept: normal retrieval should return questions the agent can act on now.

### 18.3 Decisions

```text
map get decisions
    [--id ID...]
    [--question ID...]
    [--intent ID...]
    [--soft]
    [--decided-by user|assistant]
    [--abandoned]
    [--limit N]
```

Default includes current non-abandoned hard and soft decisions from both sources.

`--soft` filters to soft decisions.

`--decided-by` filters provenance.

`--abandoned` includes abandoned decisions.

Returns IDs.

### 18.4 Ideas

```text
map get ideas
    [--id ID...]
    [--abandoned]
    [--limit N]
```

Default returns current non-abandoned ideas.

`--abandoned` includes abandoned ideas.

Returns IDs.

### 18.5 Facts

```text
map get facts
    [--id ID...]
    [--made-by user|assistant]
    [--abandoned]
    [--limit N]
```

Default returns current non-abandoned facts from both sources.

`--made-by` filters provenance.

`--abandoned` includes abandoned facts.

Returns IDs.

## 19. `map show`

```text
map show <id...>
```

Returns structured data for one or more nodes.

If an ID belongs to a normally replaced historical node, `show` returns the current replacement rather than historical raw state. `map history` is the explicit historical inspection path.

For intents, inspection should expose both stored `depth`/`stance` and their effective inherited values.

## 20. `map context`

```text
map context <id>
```

Returns a compact current working slice around the node so an agent does not need many independent `get/show` calls merely to understand one local area.

Context should include only material current data, such as applicable:

- the requested node/current replacement;
- containing/contained intents;
- attached questions and their current answers;
- direct decisions;
- dependencies and whether they are satisfied;
- attached facts;
- attached ideas;
- effective intent depth/stance;
- relevant lifecycle flags.

It excludes abandoned/history by default.

`context` is a read convenience. It must not invent semantic relationships or rationale absent from the graph.

## 21. `map status`

```text
map status
```

Operational diagnostic, not semantic mutation.

At minimum report:

- resolved `.map` path;
- Map/schema/runtime version information available to the runtime;
- Map-level `depth`;
- Map-level `stance`;
- node counts by kind/current-vs-abandoned where practical;
- whether a recovery session exists.

Its purpose is to answer: am I using the Map I think I am, and does it look structurally available?

## 22. `map validate`

```text
map validate
```

Read-only, non-repairing integrity audit.

Validation must cover the v2 invariants, including at least:

- known node kinds/field shapes;
- legal node/property combinations;
- missing relation endpoints;
- illegal relation type combinations;
- containment cycles;
- intent dependency cycles;
- question dependency cycles;
- self-dependencies;
- multiple current decisions answering one question;
- replacement type mismatch;
- replacement cycles/ambiguous current replacements;
- abandoned/replaced nodes incorrectly participating as current;
- closed intent with `explored=false`;
- closed intent with unanswered non-abandoned questions;
- closed intent with unsatisfied intent dependency;
- closed intent with relevant unclosed child intent;
- closed intent with current soft decision;
- broken/dangling current graph positions after replacement/delete;
- duplicate semantic edges.

Known-invalid writes should also reject before mutation where practical. `validate` remains necessary for legacy/import/corruption detection and whole-graph auditing.

## 23. Search and history

Search:

```text
map search <query> [--limit N] [--include-history]
```

Searches current node semantic text plus `keywords`.

Normal search excludes replaced historical nodes and abandoned nodes unless the explicit query mode later says otherwise. `--include-history` includes replacement history; abandonment remains explicit through typed inspection unless later broadened deliberately.

Exact normalized semantic matches should outrank weaker lexical matches.

History:

```text
map history <id> [--limit N]
```

Returns replacement lineage for the node, including replacement reasons where retained.

History is the explicit command where historical node versions are the point of inspection.

## 24. Session recovery capsule

Session remains separate from the semantic graph.

Surface:

```text
map session init
map session summary [new_summary]
map session exchange [-u MESSAGE | -a MESSAGE] [--depth N]
map session pending [new_pending | --clear]
map session end [--force]
```

Session data lives in the selected `.map` and follows the same global `--path`/`--config` resolution.

### 24.1 Purpose

Session is crash/context-loss recovery memory:

```text
Map graph = authoritative semantic memory
session   = disposable conversational recovery memory
```

It is not a second graph and owns no intent/question/decision mutations.

### 24.2 Summary

- compact completed conversational history;
- maximum 2200 Unicode characters;
- deterministic whitespace normalization;
- oversize input rejects rather than truncates;
- skill writes concise Classical Chinese while preserving names, identifiers, technical terms, jargon, quotations, user phrasing, decisions, uncertainty, rationale, and anything that cannot be safely translated.

### 24.3 Exchange

- exact recent raw messages with roles;
- default depth 6 messages;
- minimum depth 2;
- oldest entries fall off when depth is exceeded.

### 24.4 Pending

Stores exact questions/work whose semantic consequence may not yet be safely reflected in Map.

Recovery must compare pending/raw exchange against the authoritative graph before replaying anything.

Clear pending only after the represented semantic consequence is verified durable or explicitly established to require no graph mutation.

### 24.5 End

`map session end` rejects while pending exists.

`map session end --force` explicitly discards potentially unpersisted conversational work and should be used only with user direction.

## 25. Session-first persistence invariant

For substantive Map conversation:

```text
A. Persist recovery state first.
B. Apply/verify semantic Map mutations.
C. Clear pending only after B is durable.
```

Assistant response/question flow:

1. construct response;
2. append exact assistant message to exchange;
3. set pending if unresolved work/questions are being exposed;
4. perform semantic graph writes;
5. verify;
6. return the already-persisted response.

User response flow:

1. append exact user message;
2. update compressed summary for completed conversational material;
3. leave pending intact;
4. interpret/apply semantic graph consequences;
5. verify;
6. clear pending only when resolved.

A crash between semantic write and pending clear must recover by verification, not blind replay.

## 26. Discovery behavior

An agent exploring an intent should use its effective `depth` and `stance`.

`explored` is explicit process memory only. The runtime must never infer it from question count, answer count, or readiness state.

Question materiality:

> Ask when the answer could materially change correctness, usability, safety, performance, coherence, feasibility, or satisfaction of the user's outcome at the requested depth/stance.

Retained guidance:

- concrete requests raise the threshold for extra questions;
- no arbitrary question quota;
- dependent questions wait for prerequisites;
- do not ask semantic duplicates of already-answered choices;
- optional capabilities stay out unless the user introduced them or they are materially necessary;
- if a choice can safely be postponed and the requested outcome can still be built/verified, it is usually not MVP-worthy;
- adversarial stance challenges assumptions rather than merely increasing question count.

After actually examining an intent, the LLM explicitly records:

```text
map set <intent> explored true
```

When it believes the intent has been explored sufficiently and closure invariants hold:

```text
map set <intent> close true
```

No absence-of-questions heuristic may implicitly mark an intent explored or closed.

## 27. CLI summary

Primary v2 semantic surface:

```text
map [--path PATH] [--config PATH] init [--schema PATH]

map create intent <intent> [--context CONTEXT] [--depth DEPTH] [--stance STANCE]
map create question <question> --intent <intent-id> [--reason REASON]
map create decision <decision> [--question ID] [--source user|assistant]
    [--assistant-reasoning REASONING] [--notes NOTES] [--soft]
map create idea <idea>
map create fact <fact> [--made-by user|assistant]

map relate <source-id> <target-id...> [--dependent]
map unrelate <source-id> <target-id...> [--dependent]

map set depth <mvp|thorough>
map set stance <normal|adversarial>
map set <id> <property> <value>

map replace <old-id> <new-id> --reason REASON [--in-place]
map abandon <id> --by user|assistant --reason REASON
map delete <id...> [--force]

map get intents ...
map get questions ...
map get decisions ...
map get ideas ...
map get facts ...

map show <id...>
map context <id>
map status
map validate
map search <query> [--limit N] [--include-history]
map history <id> [--limit N]

map session ...
```

No v1 aliases are required.

## 28. Rewrite/testing requirements

The old v1 runtime and stress tests encode obsolete semantics. Delete/replace that semantic code rather than layering v2 compatibility on top.

The v2 test suite must exercise the public Rust CLI against the real embedded DB across separate processes.

Minimum behavioral coverage:

- path/config resolution and no-fallback rejection;
- init refusal when `.map` already exists;
- schema resolution, including installed scope-local executable-relative fallback;
- Map depth/stance inheritance and intent overrides;
- explicit explored semantics;
- closure invariants and automatic reopening triggers;
- question readiness and `--include-blocked`;
- question-answer cardinality;
- soft-decision closure blocking/hardening;
- legal/illegal relation matrix;
- dependency direction and cycle rejection;
- abandonment for every node kind;
- replacement/history;
- destructive in-place replacement;
- guarded delete and `--force`;
- relation removal;
- keyword search;
- current-vs-history inspection behavior;
- context/status/validate;
- recovery-session invariants;
- local project identity creation on init;
- project move with identity preserved;
- copied Map self-containment with copied local identity;
- missing/malformed local project identity rejection;
- Windows redirected UTF-8 output.

Tests should validate behavior, not preserve v1 implementation structure.

## 29. Explicit non-goals for v2 MVP

Do not add without demonstrated need:

- constraint/criterion node kinds;
- generic `related_to`;
- arbitrary user-specified relation names;
- conditional dependency expression language;
- codependent/cyclic dependency semantics;
- generic rules engine;
- vector/embedding search;
- GUI/web service;
- universal export/integration layer;
- task-tracker ownership;
- recursive destructive delete cascades;
- automatic discovery-complete inference;
- automatic closure from zero questions;
- parallel Python v2 runtime;
- v1 compatibility/migration machinery;
- machine-level Map project registry;
- synchronization of duplicated/copied Map projects;
- whole-drive scanning for unknown `.map` containers;
- heuristic reconstruction of manually altered project identity.

## 30. Implementation note

The accepted semantic target is this document. The Rust runtime is the canonical v2 implementation.

Implementation should remain YAGNI-oriented:

- small direct functions;
- explicit invariants;
- typed semantic relationships internally;
- minimal public commands;
- no speculative abstraction layers;
- no compatibility scaffolding for deleted v1 behavior.

Where implementation details remain unspecified, choose the smallest deterministic design that satisfies this contract and does not expand the product semantics.

## 31. Map-local project identity

Every initialized Map owns its identity inside its own `.map` container. There is no machine-level registry of Map projects.

Identity metadata is operational project metadata, not semantic graph or recovery-session state. The graph remains authoritative for intents, questions, decisions, facts, ideas, relationships, history, and recovery-session data.

### 31.1 Identity file

Each initialized Map contains:

```text
.map/project.json
```

It stores at least:

```text
projectId
createdAtMs
```

The project ID is a stable opaque ID generated by Map. The current native shape is 20 lowercase ASCII alphanumeric characters.

Normal `map init` does not accept an arbitrary caller-supplied project ID.

### 31.2 Identity creation is part of `map init`

Successful `map init` must create both:

1. the `.map` semantic/storage container; and
2. `.map/project.json` with a valid generated identity.

These are one logical initialization operation. If creating the identity fails during initialization, fail and roll back the newly created `.map` state where practical rather than knowingly leaving a partially initialized Map.

The jl-skills installer must never create `.map` or project identity metadata because installing the skill is not project initialization.

### 31.3 Normal open

Before normal semantic operation, the resolved `.map/project.json` must exist and parse as a valid Map project identity.

Missing or malformed identity is an error. Do not silently mint a replacement identity during ordinary open and do not infer one from the path, timestamps, graph contents, or other heuristics.

No global path registration check occurs.

### 31.4 Moves and copies

Because identity is self-contained inside `.map`, moving/renaming a project preserves its identity automatically. No machine-level path metadata needs refreshing.

Copying a complete `.map` also copies its local project identity. The copy remains independently operable because Map has no global registry that attempts to enforce one machine-wide location per project ID.

Map does not synchronize copied projects or infer authority between them. If a future product requirement needs copy separation or global duplicate detection, that must be introduced explicitly rather than reconstructed through hidden filesystem scanning.

### 31.5 Removal and discovery boundary

Map does not maintain a list of project paths outside each project.

Tooling that removes Map-generated project data must therefore operate from a user-supplied project/scope path and detect the local `.map` narrowly. It must not recursively crawl user drives looking for Maps.

Deleting `.map` permanently deletes that project's Map graph, recovery state, and local project identity together. Neighboring project files remain untouched.

### 31.6 Simplicity boundary

The accepted identity lifecycle intentionally uses only local primitives:

- generate identity on init;
- validate identity on normal open;
- carry identity naturally with project moves/copies;
- fail on missing/malformed identity rather than guessing.

Do not reintroduce a machine registry, path-refresh bookkeeping, distributed synchronization, filesystem archaeology, or heuristic identity reconstruction without a new concrete requirement.
