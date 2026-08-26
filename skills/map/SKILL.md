---
name: map
description: Durable local graph for preserving and clarifying user intent across conversations.
---
<!-- jl-skills-meta: {"name":"map","version":"0.2.0","format":1} -->

# Map

Use `map` to persist semantic state for work whose intent, questions, decisions, facts, or parked ideas need to survive context loss or be queried later.

Map is authoritative structured state. Do not read or modify `.map/db` directly and do not execute SurrealQL as a substitute for the CLI.

## Location

Use the Map selected by:

```text
map [--path PATH] [--config PATH] <command>
```

Normal commands require an existing `.map`. Do not initialize one merely because the skill is installed. Initialize only when Map is actually being started for the target project:

```bash
map init
```

Use `map status` to verify the resolved Map before semantic work when location is uncertain.

## Semantic model

Kinds:

```text
intent    what the user wants to achieve/define/resolve
question  an unresolved question discovered while clarifying an intent
decision  an actual answer/choice
idea      a parked non-binding possibility
fact      established contextual information
```

There are no constraint/criterion nodes and no generic `related_to` edge.

## Before changing graph state

Before mutating a Map, inspect enough current state to avoid duplicating or contradicting existing nodes. At minimum, use the relevant read command for the thing you are about to change. Prefer targeted reads over dumping the whole graph.

Common reads:

```bash
map get intents
map get questions
map get decisions
map show <id>
map context <id>
map search "<query>"
map status
map validate
```

Use `map --help` and `map <command> --help` when the exact syntax is uncertain.

## Intent workflow

Create an intent when the user has a distinct thing to achieve, define, resolve, decide, or develop:

```bash
map create intent "Choose a deployment model"
```

Add context only when the short intent text is insufficient for later recovery:

```bash
map create intent "Choose a deployment model" --context "For the production API, optimizing for low operations burden."
```

Intent discovery controls:

```bash
map set depth <mvp|thorough>
map set stance <normal|adversarial>
map set <intent-id> depth <mvp|thorough|null>
map set <intent-id> stance <normal|adversarial|null>
```

`mvp` discovers the material questions needed for the smallest coherent useful result. `thorough` also discovers consequential adjacent questions. `adversarial` actively tests assumptions, contradictions, feasibility, and failure conditions.

After actually examining an intent, mark it explored:

```bash
map set <intent-id> explored true
```

`explored` means an LLM has examined the intent. It does not mean the intent is complete.

Close an intent only when its effective discovery requirement is satisfied:

```bash
map set <intent-id> close true
```

Closure rejects while material current questions remain unanswered, dependencies are not satisfied, child intents remain open, or current decisions are soft.

## Questions and decisions

Create questions under the intent they clarify:

```bash
map create question "Which database fits the workload?" --intent <intent-id>
```

Record a reason when it will not be obvious later:

```bash
map create question "Which database fits the workload?" --intent <intent-id> --reason "The write pattern determines whether the current design is viable."
```

Mark a question asked only when it has actually been presented to the user:

```bash
map set <question-id> asked true
```

Create the answer as a decision:

```bash
map create decision "Use PostgreSQL" --question <question-id>
```

Assistant-made decisions require explicit reasoning:

```bash
map create decision "Use PostgreSQL" --question <question-id> --source assistant --assistant-reasoning "It satisfies the stated consistency and operational constraints."
```

Use `--soft` for a provisional answer that should remain usable but block intent closure:

```bash
map create decision "Probably PostgreSQL" --question <question-id> --soft
map set <decision-id> soft false
```

## Facts and ideas

Use facts for established contextual information:

```bash
map create fact "The service must run on Windows" --made-by user
```

Use ideas for non-binding possibilities worth preserving without turning them into active work:

```bash
map create idea "Consider a local-first mode later"
```

Relate contextual facts/ideas to the relevant node when needed:

```bash
map relate <node-id> <fact-id>
map relate <node-id> <idea-id>
```

## Relationships

`map relate` infers relation semantics from endpoint kinds.

Containment/context:

```bash
map relate <intent-id> <question-id>
map relate <intent-id> <decision-id>
map relate <parent-intent-id> <child-intent-id>
```

Dependencies use `--dependent` and read left-to-right as “source depends on target”:

```bash
map relate <dependent-intent> <prerequisite-intent> --dependent
map relate <dependent-question> <prerequisite-question> --dependent
```

Remove an inferred relationship with the same endpoint shape:

```bash
map unrelate <source-id> <target-id>
map unrelate <source-id> <target-id> --dependent
```

## Replacement, abandonment, deletion

Replace a current node while preserving history:

```bash
map replace <old-id> <new-id> --reason "Requirements changed"
```

Use `--in-place` when the old node itself should be removed while replacement history remains:

```bash
map replace <old-id> <new-id> --reason "Corrected wording" --in-place
```

Abandon material that is deliberately no longer part of the current graph:

```bash
map abandon <id> --by user --reason "No longer relevant"
```

Abandonment preserves the node in history and keeps it from becoming current accidentally.

Physical deletion is guarded. Prefer abandonment/replacement when semantic history matters:

```bash
map delete <id>
map delete <id> --force
```

## Recovery session capsule

Map can persist a compact conversational recovery capsule independently of semantic graph state.

Start or inspect it with:

```bash
map session init
map session summary
map session pending
```

Record exchanges explicitly:

```bash
map session exchange -u "<user message>"
map session exchange -a "<assistant message>"
```

Replace the rolling summary when needed:

```bash
map session summary "<new summary>"
```

Set or clear a pending continuation:

```bash
map session pending "<what should happen next>"
map session pending --clear
```

End the capsule when no longer needed:

```bash
map session end
```

Use `--force` only when deliberately discarding non-empty pending recovery state.

## Retrieval discipline

Prefer the smallest read that answers the immediate question.

- `get` for filtered/current sets.
- `show` for specific nodes.
- `context` for a node plus relevant surroundings.
- `search` for text/keyword retrieval.
- `history` when replacement/abandonment history matters.
- `status` for Map-wide state.
- `validate` when integrity is in question or before/after risky changes.

Normal reads exclude abandoned/historical material unless the command explicitly requests it.

## Safety

- Never edit `.map/db` directly.
- Never infer a missing answer from conversational memory when Map has a current explicit decision.
- Never silently overwrite or recreate an existing `.map` with `init`.
- Never use `--force` merely to bypass an invariant you have not understood.
- Never create speculative graph structure just because a relationship is technically legal.
- Keep intent/question/decision payloads concise; use context/reason/notes fields for supporting detail when their documented semantics fit.
