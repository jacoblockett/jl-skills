## Map

If `.map/` exists, it contains durable user intent and reasoning state.

Before making choices that may depend on established user intent, query Map for relevant intents, questions, decisions, ideas, facts, dependencies, and history.

Use the Map CLI rather than reading database files directly. The installer-provisioned CLI is at `{{JL_MAP_CLI}}`. Invoke that path using the active shell's normal executable syntax.

Do not silently alter authoritative Map state. Semantic changes, replacements, abandonment, forced deletion, or closure should follow explicit user direction or the Map skill workflow. `map validate` is read-only and may be used whenever graph integrity is uncertain.
