---
name: map
description: Build, refine, resume, or query a durable local graph of user intent, decisions, constraints, criteria, ideas, facts, and rationale. Use when the user explicitly invokes Map, asks to map out an outcome/problem, continue an existing Map, revisit a decision, or query what/why something was decided.
---

# Map

Map is persistent external memory for structured intent. The `.map/` graph is authoritative semantic state; `map_session` is only a disposable conversational recovery capsule.

The installer renders the Map CLI for this installation scope into the command below. For every Map operation, invoke:

```bash
{{JL_MAP_CLI}} <arguments...>
```

Examples use `map ...` as compact notation. Never assume `map` is globally on PATH. Never read or edit SurrealKV files directly.

## Boundaries

- Read broadly; mutate cautiously.
- Never silently overwrite user intent; preserve revision history.
- Park non-binding possibilities as ideas.
- Facts are the agent's job when evidence can establish them; material choices are the user's job.
- Do not ask the user to manufacture acceptance criteria for you.
- Do not use arbitrary SurrealQL or bypass the installed Map CLI.
- Do not spawn subagents by default.

Depth: `mvp` asks every currently necessary decision for the smallest coherent useful path; `thorough` also explores consequential adjacent choices.

Stance: `normal` clarifies without unnecessary challenge; `adversarial` actively tests assumptions, contradictions, feasibility, dependencies, and failure modes.

## Session recovery contract

Session is a crash/context-loss backup, not another graph API.

```bash
map session init
map session summary [new_summary]
map session exchange [-u MESSAGE | -a MESSAGE] [--depth N]
map session pending [new_pending | --clear]
map session end [--force]
```

`exchange` stores exact raw messages, newest last. Default depth is 6; minimum is 2. `--depth` truncates oldest entries when necessary.

`summary` is capped by the runtime at 2200 normalized characters. Maintain it in concise Classical Chinese. Preserve all material facts, decisions, constraints, uncertainty, rationale, and referents without semantic loss. Keep names, identifiers, technical terms, jargon, quotations, user-specific phrasing, and anything lacking a safe equivalent verbatim. Prefer dense clauses; omit filler and redundancy.

Do not update the summary merely because the assistant spoke. Update it only after a user response completes an assistant/user exchange, folding that completed exchange into the previous summary.

Session persistence always precedes authoritative Map mutation:

1. persist the conversational state to session as completely as possible;
2. perform and verify any semantic Map mutations;
3. clear `session pending` only after the represented work is verified durable in Map.

If step 3 did not happen, recovery must conservatively assume something may have failed between session persistence and Map persistence.

## Startup and recovery

On every explicit Map invocation, first check whether `.map/` exists. If it does, run:

```bash
map status
```

If `sessions` is nonzero, recovery outranks new work. Read:

```bash
map session summary
map session exchange
map session pending
```

Use the summary, raw exchange, and authoritative graph to reconstruct what was happening. Tell the user an unfinished session was found, briefly describe what appears to have been in progress, and ask whether to continue or abandon it.

If `pending` exists, assume its represented work may not be safely persisted. Inspect the graph before doing anything again. If the graph already contains the consequence, verify it and clear pending. If it is absent or ambiguous, explain that recovery found potentially unpersisted work and ask whether to reconcile/persist it or discard the session. Never blindly replay a mutation.

Discard unresolved recovery state only with explicit user direction:

```bash
map session end --force
```

If there is no session and the invocation is a pure read-only query, use the query workflow without creating one.

## Starting substantive work

Resolve whether the request clearly targets existing intent before creating anything:

```bash
map search "<request terms>"
map context <candidate-id>
```

Choose an existing focus only when the match is clear. Otherwise treat it as new scope.

Initialize recovery before semantic work and immediately preserve the exact user invocation:

```bash
map session init
map session exchange -u "<verbatim user invocation>"
```

Interpret the requested depth/stance and explain the intended scope. Before returning that assistant response, append the exact response:

```bash
map session exchange -a "<verbatim assistant response>"
```

If it asks the user something, also persist the exact outstanding question text before returning it:

```bash
map session pending "<exact pending questions>"
```

## New-scope baseline

After the user confirms or clarifies, first append the exact user message, then fold the completed exchange into the recovery summary:

```bash
map session exchange -u "<verbatim user response>"
map session summary "<rewritten compact summary>"
```

Only then create authoritative graph state.

Create one root intent; let Map generate IDs:

```bash
map add intent "<subject>" --detail "<durable meaning>"
```

Record only durable constraints actually established by the user:

```bash
map add constraint "<constraint>"
map relate <constraint-id> constrains <intent-id>
```

Retain non-binding possibilities as parked ideas:

```bash
map add idea "<idea>" --detail "<meaning>"
map relate <idea-id> related_to <intent-id>
```

Create unresolved decisions only when ambiguity is material. Discovery-created decisions are inferred:

```bash
map add decision "<decision question>" --authority inferred
map relate <intent-id> contains <decision-id>
```

Use `depends_on` only for real prerequisites. Then:

```bash
map validate
```

If the user's preceding response had been pending, clear it only after the required writes and validation succeed:

```bash
map session pending --clear
```

## Discovery and questions

The frontier is not a pre-enumerated questionnaire. A question is material when its answer could change correctness, usability, safety, performance, coherence, feasibility, or satisfaction of the stated outcome.

- Concrete requests raise the threshold for extra questions.
- Optional capabilities default out unless introduced or material.
- Dependent questions wait for prerequisites.
- Never ask semantic duplicates of decided choices.
- MVP rejects choices that can safely wait for implementation.
- Thorough may explore consequential adjacent choices, not speculative branch explosion.
- Adversarial changes challenge level, not breadth by itself.
- Do not force a minimum question count; about five visible questions is a cap, not a quota.

Use `map questions --focus <intent-id>` for the current frontier.

Before presenting a substantive assistant response/question batch, persist the exact assistant message and exact pending questions first. Then perform any graph writes required to represent newly discovered decisions, validate them, and only then return the already-persisted response to the user.

## On every user response

Before interpreting or mutating authoritative Map state:

```bash
map session exchange -u "<verbatim user message>"
map session summary "<summary rewritten from previous summary + completed exchange>"
```

Leave existing `pending` untouched while interpreting the response.

Apply semantic consequences only through normal Map commands such as:

```bash
map decide <id> <value>
map revise <id> <value>
map promote <id>
map add ...
map relate ...
```

Use real JSON types when applicable. Validate/inspect enough to establish that the intended consequence is durable. Only then, if the pending work has been resolved:

```bash
map session pending --clear
```

If the response requires no graph mutation, establish that explicitly before clearing pending.

Before the next assistant response, append that exact response to `exchange`; set `pending` first if it asks unresolved questions.

## Read-only queries

With no unfinished session, use as needed:

```bash
map search "<terms>"
map explain <id>
map history <id>
map context <id>
map related <id>
map validate
```

`search` excludes superseded history unless `--include-history` is requested. Never invent rationale absent from the graph.

## Ending work

A branch is done when no worthwhile eligible frontier remains under the chosen depth/stance, not when no conceivable future branch exists.

Before ending:

```bash
map validate
map questions --focus <intent-id>
```

If no pending conversational work remains, delete the disposable recovery capsule:

```bash
map session end
```

`session end` refuses while pending exists. Use `--force` only when the user explicitly chooses to discard unresolved work. Ending a session never deletes authoritative Map history.

## Failure handling

- Any CLI/database error: stop semantic work and diagnose the exact failure.
- Validation failure: stop; never continue from a graph known invalid.
- Never repair by directly editing `.map/db`.
- Never discard pending recovery state merely to make progress.
- Never substitute another workflow for an explicit Map invocation.
