## Map

If `.map/` exists, it contains durable user intent and planning state.

Before making decisions that may depend on established product or user intent, query Map for relevant intents, decisions, constraints, ideas, facts, and rationale.

Use the Map CLI rather than reading database files directly. The installer-provisioned CLI is at `{{JL_MAP_CLI}}`. Invoke that path using the active shell's normal executable syntax. Read/query operations do not require explicit Map invocation.

Do not silently alter authoritative user intent. Invoke the Map skill or obtain explicit user direction before deciding, superseding, removing, or promoting intent.
