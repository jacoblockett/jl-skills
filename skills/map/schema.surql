-- /map prototype schema.
-- Keep this intentionally small. The ontology should grow only when fixtures prove
-- that a new type or relation is necessary.

DEFINE TABLE IF NOT EXISTS node SCHEMAFULL TYPE NORMAL;
DEFINE FIELD IF NOT EXISTS kind ON node TYPE
    "intent" | "decision" | "constraint" | "criterion" | "idea" | "fact";
DEFINE FIELD IF NOT EXISTS state ON node TYPE
    "active" | "open" | "settled" | "satisfied" | "parked" |
    "inapplicable" | "superseded" | "dormant" | "abandoned" |
    "needs_review" | "invalidated";
DEFINE FIELD IF NOT EXISTS authority ON node TYPE
    "user" | "inferred" | "external" | "derived" | "none";
DEFINE FIELD IF NOT EXISTS subject ON node TYPE string;
DEFINE FIELD IF NOT EXISTS detail ON node TYPE option<string>;
DEFINE FIELD IF NOT EXISTS value ON node TYPE option<any>;
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
-- A deliberately opaque object for the prototype. The CLI, not arbitrary SurrealQL,
-- will own the supported condition vocabulary.
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

-- Workflow continuity lives beside, but not inside, the authoritative intent graph.
DEFINE TABLE IF NOT EXISTS map_session SCHEMAFULL TYPE NORMAL;
DEFINE FIELD IF NOT EXISTS status ON map_session TYPE "active" | "paused" | "complete" | "abandoned";
DEFINE FIELD IF NOT EXISTS phase ON map_session TYPE string;
DEFINE FIELD IF NOT EXISTS focus_nodes ON map_session TYPE array<record<node>> DEFAULT [];
DEFINE FIELD IF NOT EXISTS raw_invocation ON map_session TYPE option<string>;
DEFINE FIELD IF NOT EXISTS interpreted_request ON map_session TYPE option<string>;
DEFINE FIELD IF NOT EXISTS depth ON map_session TYPE "mvp" | "thorough" DEFAULT "mvp";
DEFINE FIELD IF NOT EXISTS stance ON map_session TYPE "normal" | "adversarial" DEFAULT "normal";
DEFINE FIELD IF NOT EXISTS setup_confirmed ON map_session TYPE bool DEFAULT false;
DEFINE FIELD IF NOT EXISTS presented_frontier ON map_session TYPE array<record<node>> DEFAULT [];
DEFINE FIELD IF NOT EXISTS pending_user_answer ON map_session TYPE option<string>;
DEFINE FIELD IF NOT EXISTS pending_operation ON map_session TYPE option<string>;
DEFINE FIELD IF NOT EXISTS created_at ON map_session TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON map_session TYPE datetime DEFAULT time::now();
