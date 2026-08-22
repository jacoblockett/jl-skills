"""Deterministic state engine for the /map skill."""

from __future__ import annotations

import json
import sys
import uuid
from pathlib import Path
from typing import Any

try:
    from surrealdb import RecordID, Surreal
except ImportError as exc:  # pragma: no cover
    raise SystemExit(
        "Missing dependency: surrealdb. Install this prototype with `pip install -e .` "
        "from skills/map/."
    ) from exc


NAMESPACE = "map"
DATABASE = "state"
RELATIONS = {
    "contains",
    "depends_on",
    "constrains",
    "supports",
    "supersedes",
    "related_to",
}
NODE_KINDS = ("intent", "decision", "constraint", "criterion", "idea", "fact")
AUTHORITIES = ("user", "inferred", "external", "derived", "none")

DEFAULT_STATE = {
    "intent": "active",
    "decision": "open",
    "constraint": "active",
    "criterion": "active",
    "idea": "parked",
    "fact": "active",
}
VALID_STATES = {
    "intent": {"active", "satisfied", "dormant", "superseded", "abandoned"},
    "decision": {"open", "decided", "inapplicable", "superseded", "needs_review", "invalidated"},
    "constraint": {"active", "superseded", "abandoned"},
    "criterion": {"active", "satisfied", "superseded", "abandoned"},
    "idea": {"parked", "superseded", "abandoned"},
    "fact": {"active", "superseded", "invalidated"},
}

DECISION_READY_STATES = {"decided"}
DECISION_ACTIONABLE_STATES = {"open", "needs_review"}
DECISION_REVIEWABLE_STATES = {"decided"}


def db_dir(root: Path) -> Path:
    return root.resolve() / ".map" / "db"


def db_url(root: Path) -> str:
    return f"surrealkv://{db_dir(root).as_posix()}"


def schema_text() -> str:
    return (Path(__file__).resolve().parent / "schema.surql").read_text(encoding="utf-8")


def normalize_node_id(node_id: Any) -> str:
    text = str(node_id)
    if text.startswith("node:"):
        text = text.split(":", 1)[1]
    if text.startswith("⟨") and text.endswith("⟩"):
        text = text[1:-1]
    if not text:
        raise ValueError("Node ID must not be empty")
    return text


def rid(node_id: Any) -> RecordID:
    return RecordID("node", normalize_node_id(node_id))


def generate_node_id() -> str:
    """Generate a collision-safe simple string record key.

    uuid4().hex avoids punctuation that SurrealDB would render with escaped record-ID
    wrappers while retaining 122 bits of randomness.
    """
    return uuid.uuid4().hex


def printable(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(k): printable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [printable(v) for v in value]
    if value.__class__.__module__.startswith("surrealdb"):
        return str(value)
    return value


def emit(value: Any) -> None:
    print(json.dumps(printable(value), indent=2, ensure_ascii=False, default=str))


def check_raw_response(raw: Any) -> None:
    statements = raw.get("result", []) if isinstance(raw, dict) else raw
    if not isinstance(statements, (list, tuple)):
        return
    failures = []
    for statement in statements:
        if isinstance(statement, dict) and statement.get("status") not in (None, "OK"):
            failures.append(statement)
    if failures:
        raise RuntimeError(f"SurrealQL failed: {failures}")


def open_db(root: Path):
    (root.resolve() / ".map").mkdir(parents=True, exist_ok=True)
    connection = Surreal(db_url(root))
    connection.connect()
    connection.use(NAMESPACE, DATABASE)
    return connection


def apply_schema(db: Any) -> None:
    raw = db.query_raw(schema_text())
    check_raw_response(raw)


def init_map(root: Path) -> None:
    db = open_db(root)
    try:
        apply_schema(db)
        emit({"ok": True, "database": str(db_dir(root)), "namespace": NAMESPACE, "db": DATABASE})
    finally:
        db.close()


def default_authority(kind: str) -> str:
    # Parked ideas are explicitly non-authoritative. For direct CLI additions, other
    # kinds default to user provenance; agents must override provenance when inferred,
    # external, or derived.
    return "none" if kind == "idea" else "user"


def validate_node_semantics(kind: str, state: str) -> None:
    if kind not in NODE_KINDS:
        raise ValueError(f"Unknown node kind {kind!r}; allowed: {list(NODE_KINDS)}")
    if state not in VALID_STATES[kind]:
        raise ValueError(
            f"State {state!r} is invalid for {kind!r}; allowed: {sorted(VALID_STATES[kind])}"
        )


def semantic_state_errors(nodes: list[dict[str, Any]]) -> list[str]:
    errors: list[str] = []
    for node in nodes:
        kind = node.get("kind")
        state = node.get("state")
        node_id = node_key(node.get("id"))
        if kind not in NODE_KINDS:
            errors.append(f"{node_id} has unknown kind {kind!r}")
            continue
        if state not in VALID_STATES[kind]:
            errors.append(
                f"{node_id} has invalid {kind} state {state!r}; allowed: {sorted(VALID_STATES[kind])}"
            )
    return errors


def create_node(db: Any, node_id: str | None, data: dict[str, Any]) -> Any:
    kind = data["kind"]
    if kind not in NODE_KINDS:
        raise ValueError(f"Unknown node kind {kind!r}; allowed: {list(NODE_KINDS)}")
    state = data.get("state") or DEFAULT_STATE[kind]
    authority = data.get("authority") or default_authority(kind)
    validate_node_semantics(kind, state)
    if authority not in AUTHORITIES:
        raise ValueError(f"Unknown authority {authority!r}; allowed: {list(AUTHORITIES)}")

    node_id = normalize_node_id(node_id) if node_id is not None else generate_node_id()
    if get_node(db, node_id):
        raise ValueError(f"Node {node_id!r} already exists")

    payload = {
        "kind": kind,
        "state": state,
        "authority": authority,
        "subject": data["subject"],
        "detail": data.get("detail"),
        "value": data.get("value"),
        "source_note": data.get("source_note"),
        "tags": data.get("tags", []),
    }
    return db.create(rid(node_id), payload)


def relate(
    db: Any,
    source: str,
    relation: str,
    target: str,
    *,
    note: str | None = None,
    condition: dict[str, Any] | None = None,
) -> Any:
    if relation not in RELATIONS:
        raise ValueError(f"Unknown relation {relation!r}; allowed: {sorted(RELATIONS)}")
    data: dict[str, Any] = {"note": note}
    if relation == "depends_on":
        data["condition"] = condition
    query = f"RELATE $source->{relation}->$target CONTENT $data;"
    return db.query(query, {"source": rid(source), "target": rid(target), "data": data})


def all_nodes(db: Any) -> list[dict[str, Any]]:
    return list(db.select("node") or [])


def get_node(db: Any, node_id: Any) -> dict[str, Any] | None:
    value = db.select(rid(node_id))
    if isinstance(value, list):
        return value[0] if value else None
    return value


def node_key(value: Any) -> str:
    return str(value)


def parse_scalar(text: str) -> Any:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def condition_matches(prerequisite: dict[str, Any], condition: dict[str, Any] | None) -> bool:
    if not condition:
        return True
    field = condition.get("field", "value")
    op = condition.get("op", "eq")
    expected = condition.get("value")
    actual = prerequisite.get(field)
    if op == "eq":
        return actual == expected
    if op == "neq":
        return actual != expected
    if op == "in":
        return actual in (expected or [])
    raise ValueError(f"Unsupported dependency condition op: {op!r}")


def contained_scope(db: Any, focus_id: str) -> set[str]:
    focus = get_node(db, focus_id)
    if not focus:
        raise ValueError(f"No focus node {focus_id!r}")
    edges = list(db.select("contains") or [])
    children: dict[str, list[str]] = {}
    for edge in edges:
        children.setdefault(node_key(edge["in"]), []).append(node_key(edge["out"]))
    start = node_key(focus["id"])
    seen = {start}
    queue = [start]
    while queue:
        current = queue.pop(0)
        for child in children.get(current, []):
            if child not in seen:
                seen.add(child)
                queue.append(child)
    return seen


def supersession_map(db: Any) -> dict[str, str]:
    replacements: dict[str, str] = {}
    for edge in list(db.select("supersedes") or []):
        old_id = node_key(edge["out"])
        new_id = node_key(edge["in"])
        if old_id in replacements and replacements[old_id] != new_id:
            raise RuntimeError(f"{old_id} has multiple direct superseding nodes")
        replacements[old_id] = new_id
    return replacements


def resolve_current_id(node_id: str, replacements: dict[str, str]) -> str:
    current = node_id
    seen: set[str] = set()
    while current in replacements:
        if current in seen:
            raise RuntimeError(f"Supersession cycle detected at {current}")
        seen.add(current)
        current = replacements[current]
    return current


def compute_frontier(db: Any, focus_id: str | None = None) -> dict[str, Any]:
    nodes = all_nodes(db)
    by_id = {node_key(node["id"]): node for node in nodes}
    dependencies = list(db.select("depends_on") or [])
    replacements = supersession_map(db)
    scope_ids = contained_scope(db, focus_id) if focus_id is not None else None

    outgoing: dict[str, list[dict[str, Any]]] = {}
    for edge in dependencies:
        outgoing.setdefault(node_key(edge["in"]), []).append(edge)

    ready: list[dict[str, Any]] = []
    blocked: list[dict[str, Any]] = []
    inapplicable: list[dict[str, Any]] = []

    for node in nodes:
        if node.get("kind") != "decision" or node.get("state") not in DECISION_ACTIONABLE_STATES:
            continue
        if scope_ids is not None and node_key(node["id"]) not in scope_ids:
            continue

        reasons: list[str] = []
        applicable = True
        for edge in outgoing.get(node_key(node["id"]), []):
            original_id = node_key(edge["out"])
            current_id = resolve_current_id(original_id, replacements)
            prerequisite = by_id.get(current_id)
            if not prerequisite:
                reasons.append(f"missing prerequisite {current_id}")
                continue
            if prerequisite.get("state") not in DECISION_READY_STATES:
                reasons.append(f"waiting for {prerequisite['id']}")
                continue
            if not condition_matches(prerequisite, edge.get("condition")):
                applicable = False
                reasons.append(f"condition false for {prerequisite['id']}")

        summary = {
            "id": node["id"],
            "state": node.get("state"),
            "subject": node.get("subject"),
            "reasons": reasons,
        }
        if not applicable:
            inapplicable.append(summary)
        elif reasons:
            blocked.append(summary)
        else:
            ready.append(summary)

    result = {"frontier": ready, "blocked": blocked, "inapplicable": inapplicable}
    if focus_id is not None:
        focus = get_node(db, focus_id)
        result = {"focus": focus["id"], **result}
    return result


def decide_decision(db: Any, node_id: str, value: Any, *, authority: str = "user") -> Any:
    node = get_node(db, node_id)
    if not node:
        raise ValueError(f"No node {node_id!r}")
    if node.get("kind") != "decision":
        raise ValueError(f"{node_id!r} is {node.get('kind')!r}, not a decision")
    if node.get("state") not in DECISION_ACTIONABLE_STATES:
        if node.get("state") == "decided":
            raise ValueError(f"{node_id!r} is already decided; use revise to change an authoritative decision")
        raise ValueError(
            f"{node_id!r} is in state {node.get('state')!r}; expected one of "
            f"{sorted(DECISION_ACTIONABLE_STATES)}"
        )
    if authority not in AUTHORITIES:
        raise ValueError(f"Unknown authority {authority!r}; allowed: {list(AUTHORITIES)}")
    return db.query(
        "UPDATE $node MERGE { state: 'decided', value: $value, authority: $authority, updated_at: time::now() };",
        {"node": rid(node_id), "value": value, "authority": authority},
    )


def revise_decision(
    db: Any,
    old_id: str,
    value: Any,
    *,
    new_id: str | None = None,
    subject: str | None = None,
    authority: str = "user",
) -> dict[str, Any]:
    """Replace a decided decision without overwriting history."""
    old = get_node(db, old_id)
    if not old:
        raise ValueError(f"No node {old_id!r}")
    if old.get("kind") != "decision":
        raise ValueError(f"{old_id!r} is {old.get('kind')!r}, not a decision")
    if old.get("state") == "superseded":
        raise ValueError(f"{old_id!r} is already superseded; revise the current replacement")
    if old.get("state") not in {"decided", "needs_review"}:
        raise ValueError(f"{old_id!r} is {old.get('state')!r}; use decide for an unresolved decision")
    if authority not in AUTHORITIES:
        raise ValueError(f"Unknown authority {authority!r}; allowed: {list(AUTHORITIES)}")

    new_id = normalize_node_id(new_id) if new_id is not None else generate_node_id()
    if get_node(db, new_id):
        raise ValueError(f"Replacement node {new_id!r} already exists")

    replacements = supersession_map(db)
    old_key = node_key(old["id"])
    if old_key in replacements:
        raise ValueError(f"{old_id!r} already has a replacement")

    create_node(
        db,
        new_id,
        {
            "kind": "decision",
            "state": "decided",
            "authority": authority,
            "subject": subject or old.get("subject") or old_id,
            "detail": old.get("detail"),
            "value": value,
            "source_note": f"Revision of {old['id']}",
            "tags": old.get("tags", []),
        },
    )

    for edge in list(db.select("contains") or []):
        if node_key(edge["out"]) == old_key:
            relate(db, node_key(edge["in"]), "contains", new_id)

    relate(db, new_id, "supersedes", old_id, note="New authoritative decision revision.")
    db.query(
        "UPDATE $node MERGE { state: 'superseded', updated_at: time::now() };",
        {"node": rid(old_id)},
    )

    affected: list[dict[str, Any]] = []
    for edge in list(db.select("depends_on") or []):
        if node_key(edge["out"]) != old_key:
            continue
        dependent = get_node(db, node_key(edge["in"]))
        if not dependent or dependent.get("kind") != "decision":
            continue
        if dependent.get("state") in DECISION_REVIEWABLE_STATES:
            db.query(
                "UPDATE $node MERGE { state: 'needs_review', updated_at: time::now() };",
                {"node": dependent["id"]},
            )
            refreshed = get_node(db, node_key(dependent["id"]))
            if refreshed:
                affected.append(refreshed)

    new = get_node(db, new_id)
    old_after = get_node(db, old_id)
    if new is None or old_after is None:
        raise RuntimeError("Revision records were not persisted")
    return {"old": old_after, "new": new, "affected": affected}


def promote_idea(db: Any, node_id: str, parent_id: str | None = None) -> dict[str, Any]:
    node = get_node(db, node_id)
    if not node:
        raise ValueError(f"No node {node_id!r}")
    if node.get("kind") != "idea" or node.get("state") != "parked":
        raise ValueError(f"{node_id!r} must be a parked idea before it can be promoted")
    if parent_id is not None:
        parent = get_node(db, parent_id)
        if not parent:
            raise ValueError(f"No parent node {parent_id!r}")
        if parent.get("kind") != "intent":
            raise ValueError(f"Parent {parent_id!r} is {parent.get('kind')!r}, not an intent")
    db.query(
        "UPDATE $node MERGE { kind: 'intent', state: 'active', authority: 'user', updated_at: time::now() };",
        {"node": rid(node_id)},
    )
    if parent_id is not None:
        relate(db, parent_id, "contains", node_id)
    promoted = get_node(db, node_id)
    if promoted is None:
        raise RuntimeError(f"Promoted node {node_id!r} disappeared")
    return promoted


def wipe(db: Any) -> None:
    for table in sorted(RELATIONS):
        db.query(f"DELETE {table};")
    db.query("DELETE map_session;")
    db.query("DELETE node;")


def seed_chores(db: Any) -> None:
    """Development fixture: reset state and seed the recurring-chore example."""
    wipe(db)

    create_node(db, "chores", {
        "kind": "intent", "state": "active", "authority": "user",
        "subject": "Recurring household chore tracker",
        "detail": "Tiny browser-only app for adding recurring chores, seeing what needs doing, and marking chores complete.",
    })

    constraints = [
        ("browser-only", "Run entirely in the browser"),
        ("no-accounts", "No user accounts"),
        ("no-server", "No server"),
        ("no-cloud-sync", "No cloud synchronization"),
        ("keep-small", "Keep the product intentionally small"),
    ]
    for node_id, subject in constraints:
        create_node(db, node_id, {
            "kind": "constraint", "state": "active", "authority": "user", "subject": subject,
        })
        relate(db, node_id, "constrains", "chores")

    decisions = [
        ("recurrence", "Which recurrence patterns are supported?"),
        ("late-anchor", "Does late completion shift future due dates?"),
        ("missed-occurrences", "Do missed occurrences accumulate separately or collapse into one overdue chore?"),
        ("clear-backlog", "If missed occurrences accumulate, does completion clear one occurrence or all?"),
        ("first-due", "How is the first due date established?"),
        ("local-persistence", "Does chore and schedule state persist across browser restarts?"),
        ("monthly-missing-date", "What happens when a monthly anchor day does not exist in a month?"),
    ]
    for node_id, subject in decisions:
        create_node(db, node_id, {
            "kind": "decision", "state": "open", "authority": "inferred", "subject": subject,
        })
        relate(db, "chores", "contains", node_id)

    relate(
        db,
        "clear-backlog",
        "depends_on",
        "missed-occurrences",
        note="Only meaningful when missed occurrences accumulate separately.",
        condition={"field": "value", "op": "eq", "value": "separate"},
    )

    create_node(db, "shared-household", {
        "kind": "idea", "state": "parked", "authority": "none",
        "subject": "Shared household chores",
        "detail": "Multi-user/shared-household chore capability.",
    })
    relate(db, "shared-household", "related_to", "chores")


def command_with_db(root: Path, fn):
    db = open_db(root)
    try:
        apply_schema(db)
        return fn(db)
    finally:
        db.close()
