"""Read/query primitives for Map state."""

from __future__ import annotations

from typing import Any

import map_state


def rows(db: Any, relation: str) -> list[dict[str, Any]]:
    return list(db.select(relation) or [])


def summary(node: dict[str, Any]) -> dict[str, Any]:
    keys = (
        "id",
        "kind",
        "state",
        "authority",
        "subject",
        "detail",
        "value",
        "source_note",
    )
    return {key: node[key] for key in keys if key in node and node[key] is not None}


def sorted_nodes(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(nodes, key=lambda node: map_state.node_key(node["id"]))


def predecessors(db: Any) -> dict[str, str]:
    result: dict[str, str] = {}
    for edge in rows(db, "supersedes"):
        old_id = map_state.node_key(edge["out"])
        new_id = map_state.node_key(edge["in"])
        if new_id in result and result[new_id] != old_id:
            raise RuntimeError(f"{new_id} supersedes multiple direct historical nodes")
        result[new_id] = old_id
    return result


def history_for(db: Any, node_id: str) -> dict[str, Any]:
    queried = map_state.get_node(db, node_id)
    if not queried:
        raise ValueError(f"No node {node_id!r}")

    nodes = map_state.all_nodes(db)
    by_id = {map_state.node_key(node["id"]): node for node in nodes}
    replacements = map_state.supersession_map(db)
    prior = predecessors(db)

    queried_id = map_state.node_key(queried["id"])
    root_id = queried_id
    seen: set[str] = set()
    while root_id in prior:
        if root_id in seen:
            raise RuntimeError(f"Supersession cycle detected at {root_id}")
        seen.add(root_id)
        root_id = prior[root_id]

    chain_ids: list[str] = []
    current_id = root_id
    seen.clear()
    while True:
        if current_id in seen:
            raise RuntimeError(f"Supersession cycle detected at {current_id}")
        seen.add(current_id)
        chain_ids.append(current_id)
        if current_id not in replacements:
            break
        current_id = replacements[current_id]

    missing = [item for item in chain_ids if item not in by_id]
    if missing:
        raise RuntimeError(f"Supersession history references missing nodes: {missing}")

    return {
        "queried": queried["id"],
        "root": by_id[root_id]["id"],
        "current": by_id[current_id]["id"],
        "revisions": [summary(by_id[item]) for item in chain_ids],
    }


def related_for(db: Any, node_id: str) -> dict[str, Any]:
    node = map_state.get_node(db, node_id)
    if not node:
        raise ValueError(f"No node {node_id!r}")

    key = map_state.node_key(node["id"])
    relations: list[dict[str, Any]] = []

    for relation in sorted(map_state.RELATIONS):
        for edge in rows(db, relation):
            source_id = map_state.node_key(edge["in"])
            target_id = map_state.node_key(edge["out"])
            if source_id == key:
                direction = "outgoing"
                other_id = target_id
            elif target_id == key:
                direction = "incoming"
                other_id = source_id
            else:
                continue

            other = map_state.get_node(db, other_id)
            item: dict[str, Any] = {
                "relation": relation,
                "direction": direction,
                "node": summary(other) if other else {"id": other_id, "missing": True},
            }
            if edge.get("condition") is not None:
                item["condition"] = edge["condition"]
            if edge.get("note") is not None:
                item["note"] = edge["note"]
            relations.append(item)

    relations.sort(
        key=lambda item: (
            item["relation"],
            item["direction"],
            map_state.node_key(item["node"]["id"]),
        )
    )
    return {"node": summary(node), "relations": relations}


def ancestors(db: Any, focus_id: str) -> set[str]:
    focus = map_state.get_node(db, focus_id)
    if not focus:
        raise ValueError(f"No focus node {focus_id!r}")

    parents: dict[str, set[str]] = {}
    for edge in rows(db, "contains"):
        parents.setdefault(map_state.node_key(edge["out"]), set()).add(map_state.node_key(edge["in"]))

    start = map_state.node_key(focus["id"])
    seen: set[str] = set()
    queue = [start]
    while queue:
        current = queue.pop(0)
        for parent in sorted(parents.get(current, set())):
            if parent != start and parent not in seen:
                seen.add(parent)
                queue.append(parent)
    return seen


def current_scope_nodes(
    nodes: list[dict[str, Any]],
    scope_ids: set[str],
    replacements: dict[str, str],
) -> list[dict[str, Any]]:
    current: list[dict[str, Any]] = []
    for node in nodes:
        key = map_state.node_key(node["id"])
        if key not in scope_ids:
            continue
        if node.get("state") == "superseded":
            continue
        if map_state.resolve_current_id(key, replacements) != key:
            continue
        current.append(node)
    return sorted_nodes(current)


def context_for(db: Any, node_id: str) -> dict[str, Any]:
    requested = map_state.get_node(db, node_id)
    if not requested:
        raise ValueError(f"No node {node_id!r}")

    nodes = map_state.all_nodes(db)
    by_id = {map_state.node_key(node["id"]): node for node in nodes}
    replacements = map_state.supersession_map(db)

    requested_key = map_state.node_key(requested["id"])
    focus_key = map_state.resolve_current_id(requested_key, replacements)
    focus = by_id.get(focus_key)
    if not focus:
        raise RuntimeError(f"Current focus {focus_key} does not exist")

    scope_ids = map_state.contained_scope(db, focus_key)
    ancestor_ids = ancestors(db, focus_key)
    current_nodes = current_scope_nodes(nodes, scope_ids, replacements)

    buckets: dict[str, list[dict[str, Any]]] = {
        "intents": [],
        "decisions": [],
        "constraints": [],
        "criteria": [],
        "facts": [],
        "ideas": [],
    }
    kind_bucket = {
        "intent": "intents",
        "decision": "decisions",
        "constraint": "constraints",
        "criterion": "criteria",
        "fact": "facts",
        "idea": "ideas",
    }
    for node in current_nodes:
        if map_state.node_key(node["id"]) == focus_key:
            continue
        bucket = kind_bucket.get(node.get("kind"))
        if bucket:
            buckets[bucket].append(summary(node))

    ancestor_nodes = [
        summary(by_id[item])
        for item in sorted(ancestor_ids)
        if item in by_id and by_id[item].get("state") != "superseded"
    ]

    relevant_targets = scope_ids | ancestor_ids
    contained_ids = {map_state.node_key(node["id"]) for node in current_nodes}

    external_constraints: dict[str, dict[str, Any]] = {}
    for edge in rows(db, "constrains"):
        if map_state.node_key(edge["out"]) not in relevant_targets:
            continue
        source_id = map_state.resolve_current_id(map_state.node_key(edge["in"]), replacements)
        source = by_id.get(source_id)
        if source and source.get("kind") == "constraint" and source.get("state") != "superseded":
            external_constraints[source_id] = source

    external_facts: dict[str, dict[str, Any]] = {}
    for edge in rows(db, "supports"):
        if map_state.node_key(edge["out"]) not in relevant_targets:
            continue
        source_id = map_state.resolve_current_id(map_state.node_key(edge["in"]), replacements)
        source = by_id.get(source_id)
        if source and source.get("kind") == "fact" and source.get("state") != "superseded":
            external_facts[source_id] = source

    related_ideas: dict[str, dict[str, Any]] = {}
    for edge in rows(db, "related_to"):
        source_id = map_state.node_key(edge["in"])
        target_id = map_state.node_key(edge["out"])
        candidate_id: str | None = None
        if source_id in relevant_targets:
            candidate_id = target_id
        elif target_id in relevant_targets:
            candidate_id = source_id
        if candidate_id is None:
            continue
        current_id = map_state.resolve_current_id(candidate_id, replacements)
        candidate = by_id.get(current_id)
        if candidate and candidate.get("kind") == "idea" and candidate.get("state") == "parked":
            related_ideas[current_id] = candidate

    for key, node in external_constraints.items():
        if key not in contained_ids:
            buckets["constraints"].append(summary(node))
    for key, node in external_facts.items():
        if key not in contained_ids:
            buckets["facts"].append(summary(node))
    for key, node in related_ideas.items():
        if key not in contained_ids:
            buckets["ideas"].append(summary(node))

    for bucket in buckets.values():
        bucket.sort(key=lambda item: map_state.node_key(item["id"]))

    current_decision_ids = {
        map_state.node_key(node["id"])
        for node in current_nodes
        if node.get("kind") == "decision"
    }
    dependencies: list[dict[str, Any]] = []
    for edge in rows(db, "depends_on"):
        decision_id = map_state.node_key(edge["in"])
        if decision_id not in current_decision_ids:
            continue
        prerequisite_id = map_state.resolve_current_id(map_state.node_key(edge["out"]), replacements)
        prerequisite = by_id.get(prerequisite_id)
        item: dict[str, Any] = {
            "decision": by_id[decision_id]["id"] if decision_id in by_id else decision_id,
            "prerequisite": prerequisite["id"] if prerequisite else prerequisite_id,
        }
        if prerequisite:
            item["prerequisite_state"] = prerequisite.get("state")
            if "value" in prerequisite:
                item["prerequisite_value"] = prerequisite.get("value")
        if edge.get("condition") is not None:
            item["condition"] = edge["condition"]
        dependencies.append(item)
    dependencies.sort(
        key=lambda item: (
            map_state.node_key(item["decision"]),
            map_state.node_key(item["prerequisite"]),
        )
    )

    return {
        "requested": requested["id"],
        "focus": summary(focus),
        "ancestors": ancestor_nodes,
        **buckets,
        "dependencies": dependencies,
        "frontier": map_state.compute_frontier(db, focus_key),
    }


def contains_cycle(edges: list[dict[str, Any]]) -> bool:
    adjacency: dict[str, set[str]] = {}
    nodes: set[str] = set()
    for edge in edges:
        source = map_state.node_key(edge["in"])
        target = map_state.node_key(edge["out"])
        adjacency.setdefault(source, set()).add(target)
        nodes.add(source)
        nodes.add(target)

    indegree = {node: 0 for node in nodes}
    for targets in adjacency.values():
        for target in targets:
            indegree[target] += 1

    queue = sorted(node for node, degree in indegree.items() if degree == 0)
    processed = 0
    while queue:
        current = queue.pop(0)
        processed += 1
        for target in sorted(adjacency.get(current, set())):
            indegree[target] -= 1
            if indegree[target] == 0:
                queue.append(target)
                queue.sort()
    return processed != len(nodes)


def validate_graph(db: Any) -> dict[str, Any]:
    nodes = map_state.all_nodes(db)
    by_id = {map_state.node_key(node["id"]): node for node in nodes}
    errors: list[str] = list(map_state.semantic_state_errors(nodes))
    warnings: list[str] = []
    relation_counts: dict[str, int] = {}

    rows_by_relation: dict[str, list[dict[str, Any]]] = {}
    for relation in sorted(map_state.RELATIONS):
        relation_rows = rows(db, relation)
        rows_by_relation[relation] = relation_rows
        relation_counts[relation] = len(relation_rows)
        for edge in relation_rows:
            source = map_state.node_key(edge["in"])
            target = map_state.node_key(edge["out"])
            if source not in by_id:
                errors.append(f"{relation} edge references missing source {source}")
            if target not in by_id:
                errors.append(f"{relation} edge references missing target {target}")

    if contains_cycle(rows_by_relation["contains"]):
        errors.append("contains relation contains a directed cycle")

    direct_replacements: dict[str, set[str]] = {}
    direct_predecessors: dict[str, set[str]] = {}
    for edge in rows_by_relation["supersedes"]:
        old_id = map_state.node_key(edge["out"])
        new_id = map_state.node_key(edge["in"])
        direct_replacements.setdefault(old_id, set()).add(new_id)
        direct_predecessors.setdefault(new_id, set()).add(old_id)
        old = by_id.get(old_id)
        new = by_id.get(new_id)
        if old and new and old.get("kind") != new.get("kind"):
            errors.append(
                f"supersession kind mismatch: {new_id} ({new.get('kind')}) -> "
                f"{old_id} ({old.get('kind')})"
            )

    for old_id, new_ids in sorted(direct_replacements.items()):
        if len(new_ids) > 1:
            errors.append(f"{old_id} has multiple direct replacements: {sorted(new_ids)}")
        old = by_id.get(old_id)
        if old and old.get("state") != "superseded":
            errors.append(f"{old_id} has a replacement but state is {old.get('state')!r}, not 'superseded'")

    for new_id, old_ids in sorted(direct_predecessors.items()):
        if len(old_ids) > 1:
            errors.append(f"{new_id} supersedes multiple direct historical nodes: {sorted(old_ids)}")

    unique_replacements = {
        old_id: next(iter(new_ids))
        for old_id, new_ids in direct_replacements.items()
        if len(new_ids) == 1
    }
    for start in sorted(unique_replacements):
        current = start
        seen: set[str] = set()
        while current in unique_replacements:
            if current in seen:
                errors.append(f"supersession cycle detected at {current}")
                break
            seen.add(current)
            current = unique_replacements[current]

    for node_id, node in sorted(by_id.items()):
        if node.get("state") == "superseded" and node_id not in direct_replacements:
            errors.append(f"{node_id} is superseded but has no replacement lineage")
        if node.get("state") == "needs_review" and node.get("kind") != "decision":
            errors.append(f"{node_id} is needs_review but is not a decision")

    for edge in rows_by_relation["depends_on"]:
        source_id = map_state.node_key(edge["in"])
        target_id = map_state.node_key(edge["out"])
        if source_id == target_id:
            errors.append(f"decision {source_id} depends on itself")
        source = by_id.get(source_id)
        target = by_id.get(target_id)
        if source and source.get("kind") != "decision":
            errors.append(f"depends_on source {source_id} is {source.get('kind')!r}, not a decision")
        if target and target.get("kind") != "decision":
            errors.append(f"depends_on target {target_id} is {target.get('kind')!r}, not a decision")
        try:
            map_state.validate_dependency_condition(edge.get("condition"))
        except ValueError as exc:
            errors.append(f"depends_on condition on {source_id}: {exc}")

    for relation, expected_kind in (("constrains", "constraint"), ("supports", "fact")):
        for edge in rows_by_relation[relation]:
            source_id = map_state.node_key(edge["in"])
            source = by_id.get(source_id)
            if source and source.get("kind") != expected_kind:
                errors.append(
                    f"{relation} source {source_id} is {source.get('kind')!r}, not a {expected_kind}"
                )

    for relation, relation_rows in rows_by_relation.items():
        seen_edges: set[tuple[str, str]] = set()
        for edge in relation_rows:
            pair = (map_state.node_key(edge["in"]), map_state.node_key(edge["out"]))
            if pair in seen_edges:
                warnings.append(f"duplicate {relation} edge {pair[0]} -> {pair[1]}")
            seen_edges.add(pair)

    return {
        "ok": not errors,
        "nodes": len(nodes),
        "relations": relation_counts,
        "errors": sorted(set(errors)),
        "warnings": sorted(set(warnings)),
    }
