<!-- Managed by jl-skills. Do not edit inside this block; reinstall/update replaces it. -->
## Map

If `.map/` exists, treat it as authoritative durable state for user intent, questions, decisions, ideas, facts, dependencies, and semantic history. Session data inside Map is recovery state only.

Do not create or initialize `.map/` merely because these instructions are present.

Before making choices that may depend on established user intent, query Map rather than reconstructing that intent from chat history or guessing. Prefer the smallest relevant read, usually `context`, `show`, or `search`.

Use the installer-provisioned CLI at `{{JL_MAP_CLI}}`. Invoke that path using the active shell's normal executable syntax. Do not read or modify `.map/db` directly and do not execute SurrealQL as a substitute for the CLI.

Common read-only commands:

```text
{{JL_MAP_CLI}} status
{{JL_MAP_CLI}} get intents
{{JL_MAP_CLI}} get questions
{{JL_MAP_CLI}} show <id>
{{JL_MAP_CLI}} context <id>
{{JL_MAP_CLI}} search "<query>"
{{JL_MAP_CLI}} validate
```

If the user explicitly invokes `$map` or asks to start/resume Map clarification, load the installed `map` skill and follow that workflow. `jl-skills` installs Map's required specialists into the selected harness's native subagent directory. The parent should invoke the exact named specialist for each required stage; the registered subagent definition owns its semantic contract. Do not replace a required specialist with a generic child or improvised parent-thread judgment; if a required named subagent cannot run, report that stage as blocked.

Outside an explicit Map workflow, ordinary agents may query Map as a read-only primitive. Do not silently create questions, decisions, intents, replacements, abandonment, forced deletion, or closure merely because Map exists.

For additional commands and exact flags:

```text
{{JL_MAP_CLI}} --help
{{JL_MAP_CLI}} <command> --help
```
