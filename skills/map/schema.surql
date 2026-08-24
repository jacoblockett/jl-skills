-- Map v2 schema. The Rust runtime owns semantic invariants beyond field shape.

DEFINE TABLE OVERWRITE node SCHEMAFULL TYPE NORMAL;
DEFINE FIELD OVERWRITE kind ON TABLE node TYPE string ASSERT $value IN ['intent', 'question', 'decision', 'idea', 'fact'];
DEFINE FIELD OVERWRITE text ON TABLE node TYPE string;
DEFINE FIELD OVERWRITE keywords ON TABLE node TYPE array<string> DEFAULT [];
DEFINE FIELD OVERWRITE abandoned ON TABLE node TYPE bool DEFAULT false;
DEFINE FIELD OVERWRITE abandonedReason ON TABLE node TYPE option<string>;
DEFINE FIELD OVERWRITE abandonedBy ON TABLE node TYPE option<string> ASSERT $value = NONE OR $value IN ['user', 'assistant'];

-- Intent-only fields.
DEFINE FIELD OVERWRITE context ON TABLE node TYPE option<string>;
DEFINE FIELD OVERWRITE explored ON TABLE node TYPE option<bool>;
DEFINE FIELD OVERWRITE closed ON TABLE node TYPE option<bool>;
DEFINE FIELD OVERWRITE depth ON TABLE node TYPE option<string> ASSERT $value = NONE OR $value IN ['mvp', 'thorough'];
DEFINE FIELD OVERWRITE stance ON TABLE node TYPE option<string> ASSERT $value = NONE OR $value IN ['normal', 'adversarial'];

-- Question-only fields.
DEFINE FIELD OVERWRITE reason ON TABLE node TYPE option<string>;
DEFINE FIELD OVERWRITE asked ON TABLE node TYPE option<bool>;

-- Decision-only fields.
DEFINE FIELD OVERWRITE source ON TABLE node TYPE option<string> ASSERT $value = NONE OR $value IN ['user', 'assistant'];
DEFINE FIELD OVERWRITE assistantReasoning ON TABLE node TYPE option<string>;
DEFINE FIELD OVERWRITE notes ON TABLE node TYPE option<string>;
DEFINE FIELD OVERWRITE soft ON TABLE node TYPE option<bool>;

-- Fact-only field.
DEFINE FIELD OVERWRITE madeBy ON TABLE node TYPE option<string> ASSERT $value = NONE OR $value IN ['user', 'assistant'];

DEFINE TABLE OVERWRITE contains SCHEMAFULL TYPE RELATION IN node OUT node ENFORCED;
DEFINE TABLE OVERWRITE answers SCHEMAFULL TYPE RELATION IN node OUT node ENFORCED;
DEFINE TABLE OVERWRITE depends_on SCHEMAFULL TYPE RELATION IN node OUT node ENFORCED;
DEFINE TABLE OVERWRITE fact_context SCHEMAFULL TYPE RELATION IN node OUT node ENFORCED;
DEFINE TABLE OVERWRITE idea_context SCHEMAFULL TYPE RELATION IN node OUT node ENFORCED;

DEFINE TABLE OVERWRITE replacement SCHEMAFULL TYPE NORMAL;
DEFINE FIELD OVERWRITE oldId ON TABLE replacement TYPE string;
DEFINE FIELD OVERWRITE newId ON TABLE replacement TYPE string;
DEFINE FIELD OVERWRITE reason ON TABLE replacement TYPE string;
DEFINE FIELD OVERWRITE mode ON TABLE replacement TYPE string ASSERT $value IN ['normal', 'in_place'];
DEFINE FIELD OVERWRITE createdAtMs ON TABLE replacement TYPE int;

DEFINE TABLE OVERWRITE map_meta SCHEMAFULL TYPE NORMAL;
DEFINE FIELD OVERWRITE depth ON TABLE map_meta TYPE string ASSERT $value IN ['mvp', 'thorough'];
DEFINE FIELD OVERWRITE stance ON TABLE map_meta TYPE string ASSERT $value IN ['normal', 'adversarial'];
DEFINE FIELD OVERWRITE schemaVersion ON TABLE map_meta TYPE string;

DEFINE TABLE OVERWRITE map_session SCHEMAFULL TYPE NORMAL;
DEFINE FIELD OVERWRITE summary ON TABLE map_session TYPE string DEFAULT '';
DEFINE FIELD OVERWRITE exchanges ON TABLE map_session TYPE array<object> FLEXIBLE DEFAULT [];
DEFINE FIELD OVERWRITE pending ON TABLE map_session TYPE option<string>;
DEFINE FIELD OVERWRITE depth ON TABLE map_session TYPE int ASSERT $value >= 2;
