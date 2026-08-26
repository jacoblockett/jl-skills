<!-- Managed by jl-skills. Do not edit inside this block; reinstall/update replaces it. -->
## Map

If `.map/` exists, it contains durable user intent and reasoning state. Do not create or initialize `.map/` merely because these instructions are present.

Before making choices that may depend on established user intent, query Map for relevant intents, questions, decisions, ideas, facts, dependencies, and history.

Use the installer-provisioned Map CLI at `{{JL_MAP_CLI}}`. Invoke that path using the active shell's normal executable syntax. Do not read or modify `.map/db` directly and do not execute SurrealQL as a substitute for the CLI.

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

For additional commands and exact flags:

```text
{{JL_MAP_CLI}} --help
{{JL_MAP_CLI}} <command> --help
```

Do not silently alter authoritative Map state. Semantic changes, replacements, abandonment, forced deletion, or closure should follow explicit user direction or the Map skill workflow.
