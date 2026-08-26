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

Questions do not store answers. A current non-abandoned decision attached to a question is its answer.

## Discovery controls

A Map stores:

```text
depth:  mvp | thorough
stance: normal | adversarial
```

An intent may store fields with the same names. If present, they override the Map values; if absent, the intent inherits them.

`explored=true` means only that an LLM has examined/reasoned about the intent at least once. Never infer it from question count or answers.

`closed=true` means discovery is sufficiently complete for the effective depth/stance and runtime closure invariants hold. Adding new unresolved structure may reopen a closed intent without changing `explored`.

After actually examining an intent:

```bash
map set <intent> explored true
```

Close only when the intent is actually ready:

```bash
map set <intent> close true
```

## Creation

```text
map create intent <intent> [--context CONTEXT] [--depth DEPTH] [--stance STANCE]
map create question <question> --intent <intent-id> [--reason REASON]
map create decision <decision> [--question ID] [--source user|assistant]
    [--assistant-reasoning REASONING] [--notes NOTES] [--soft]
map create idea <idea>
map create fact <fact> [--made-by user|assistant]
```

Assistant decisions require `--assistant-reasoning`. User decisions must not carry assistant reasoning.

`--soft` is a usable but deliberately revisit-worthy decision. Soft decisions answer questions normally but prevent closing affected intents until hardened:

```bash
map set <decision> soft false
```

## Relationships

```text
map relate <source> <target...> [--dependent]
map unrelate <source> <target...> [--dependent]
```

Do not invent relation names. Legal shapes are inferred:

```text
intent   -> question             attachment
question -> decision             answer
intent   -> decision             direct decision
intent   -> intent               sub-intent
intent   -> intent --dependent   intent dependency
question -> question --dependent question dependency
any      -> fact                 fact context
any      -> idea                 idea context
```

Dependency direction is `SOURCE depends on TARGET`. Intent and question dependency graphs are acyclic.

## Mutation and history

Small state/config changes use:

```text
map set depth <mvp|thorough>
map set stance <normal|adversarial>
map set <id> <property> <value>
```

Do not use `set` as a generic content editor.

Replace semantic content through explicit nodes:

```bash
map replace <old> <new> --reason REASON
```

Normal replacement retains history. `--in-place` is destructive: the new node takes the old graph position and the old node is physically removed.

Abandonment retains the node but removes it from normal current work:

```bash
map abandon <id> --by user|assistant --reason REASON
```

Physical deletion is stronger:

```bash
map delete <id...> [--force]
```

If deletion affects graph relationships, first surface the impact to the user; only retry with `--force` after confirmation. Forced delete removes selected nodes and incident edges only. Do not invent cascades.

## Reading

Normal retrieval is current-state oriented and excludes abandoned/history unless requested.

```text
map get intents ...
map get questions ...
map get decisions ...
map get ideas ...
map get facts ...
map show <id...>
map context <id>
map search <query> [--limit N] [--include-history]
map history <id> [--limit N]
map validate
```

`map get questions` returns unanswered dependency-ready questions by default. Use `--include-blocked` when blocked questions are also needed. Use `--answered` to include answered questions.

`map context <id>` is the preferred compact local read when an agent needs the requested node plus its material current neighborhood.

`map validate` is read-only and non-repairing. Treat reported invariant errors as a blocker to further semantic mutation until understood.

## Recovery invariant

Session state is conversational recovery, not semantic truth:

```text
map session init
map session summary [new_summary]
map session exchange [-u MESSAGE | -a MESSAGE] [--depth N]
map session pending [new_pending | --clear]
map session end [--force]
```

For substantive Map conversation:

```text
A. Persist recovery state first.
B. Apply and verify semantic mutations.
C. Clear pending only after B is durable.
```

On explicit Map invocation, if a recovery session already exists, reconcile it before starting unrelated new Map work. Never blindly replay pending work; inspect the authoritative graph first.

Summary is capped at 2200 Unicode characters. Write it in concise Classical Chinese; preserve material names, identifiers, technical terms, decisions, uncertainty, rationale, jargon, quotations, user-specific wording, and anything that cannot be safely translated without semantic loss. Recent exchange entries are exact raw messages.
