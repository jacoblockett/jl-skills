-- /map prototype schema.
-- Keep the ontology deliberately small and enforce state semantics by node kind.

DEFINE TABLE IF NOT EXISTS node SCHEMAFULL TYPE NORMAL;
DEFINE FIELD OVERWRITE kind ON node TYPE
    "intent" | "decision" | "constraint" | "criterion" | "idea" | "fact";

-- Compatibility migration from the earlier prototype vocabulary. Broaden the
-- field temporarily so existing prototype Maps can move away from `settled`.
DEFINE FIELD OVERWRITE state ON node TYPE string;
UPDATE node SET state = "decided" WHERE kind = "decision" AND state = "settled";
UPDATE node SET state = "active" WHERE kind IN ["constraint", "criterion", "fact"] AND state = "settled";
UPDATE node SET state = "satisfied" WHERE kind = "intent" AND state = "settled";

DEFINE FIELD OVERWRITE state ON node TYPE string ASSERT
    (kind = "intent" AND $value IN ["active", "satisfied", "dormant", "superseded", "abandoned"]) OR
    (kind = "decision" AND $value IN ["open", "decided", "inapplicable", "superseded", "needs_review", "invalidated"]) OR
    (kind = "constraint" AND $value IN ["active", "superseded", "abandoned"]) OR
    (kind = "criterion" AND $value IN ["active", "satisfied", "superseded", "abandoned"]) OR
    (kind = "idea" AND $value IN ["parked", "superseded", "abandoned"]) OR
    (kind = "fact" AND $value IN ["active", "superseded", "invalidated"]);

DEFINE FIELD OVERWRITE authority ON node TYPE
    "user" | "inferred" | "external" | "derived" | "none";
DEFINE FIELD IF NOT EXISTS subject ON node TYPE string;
DEFINE FIELD IF NOT EXISTS detail ON node TYPE option<string>;
DEFINE FIELD IF NOT EXISTS value ON node TYPE any;
DEFINE FIELD IF NOT EXISTS source_note ON node TYPE option<string>;
DEFINE FIELD IF NOT EXISTS tags ON node TYPE array<string> DEFAULT [];
DEFINE FIELD IF NOT EXISTS created_at ON node TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON node TYPE datetime DEFAULT time::now();

DEFINE INDEX IF NOT EXISTS node_kind ON node FIELDS kind;
DEFINE INDEX IF NOT EXISTS node_state ON node FIELDS state;
DEFINE INDEX IF NOT EXISTS node_authority ON node FIELDS authority;

DEFINE TABLE IF NOT EXISTS contains SCHEMAFULL TYPE RELATION IN node OUT node ENFORCED;
DEFINE FIELD IF NOT EXISTS note ON contains TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at ON contains TYPE datetime DEFAULT time::now();

DEFINE TABLE IF NOT EXISTS depends_on SCHEMAFULL TYPE RELATION IN node OUT node ENFORCED;
DEFINE FIELD IF NOT EXISTS note ON depends_on TYPE option<string>;
DEFINE FIELD IF NOT EXISTS condition ON depends_on TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS created_at ON depends_on TYPE datetime DEFAULT time::now();

DEFINE TABLE IF NOT EXISTS constrains SCHEMAFULL TYPE RELATION IN node OUT node ENFORCED;
DEFINE FIELD IF NOT EXISTS note ON constrains TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at ON constrains TYPE datetime DEFAULT time::now();

DEFINE TABLE IF NOT EXISTS supports SCHEMAFULL TYPE RELATION IN node OUT node ENFORCED;
DEFINE FIELD IF NOT EXISTS note ON supports TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at ON supports TYPE datetime DEFAULT time::now();

DEFINE TABLE IF NOT EXISTS supersedes SCHEMAFULL TYPE RELATION IN node OUT node ENFORCED;
DEFINE FIELD IF NOT EXISTS note ON supersedes TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at ON supersedes TYPE datetime DEFAULT time::now();

DEFINE TABLE IF NOT EXISTS related_to SCHEMAFULL TYPE RELATION IN node OUT node ENFORCED;
DEFINE FIELD IF NOT EXISTS note ON related_to TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at ON related_to TYPE datetime DEFAULT time::now();

-- Session is a disposable recovery capsule, not authoritative graph state.
DEFINE TABLE IF NOT EXISTS map_session SCHEMAFULL TYPE NORMAL;
DEFINE FIELD IF NOT EXISTS summary ON map_session TYPE string DEFAULT "";
DEFINE FIELD IF NOT EXISTS exchange_depth ON map_session TYPE int DEFAULT 6 ASSERT $value >= 2;
-- Remove the first recovery-capsule prototype's nested exchange schema. The
-- runtime owns the tiny {role, message} shape; SurrealDB stores the raw objects.
REMOVE FIELD IF EXISTS exchange.*.role ON map_session;
REMOVE FIELD IF EXISTS exchange.*.message ON map_session;
DEFINE FIELD OVERWRITE exchange ON map_session TYPE array<object> FLEXIBLE DEFAULT [];
DEFINE FIELD IF NOT EXISTS pending ON map_session TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at ON map_session TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON map_session TYPE datetime DEFAULT time::now();
