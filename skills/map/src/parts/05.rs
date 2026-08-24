async fn replace_command(
    store: &Store,
    old_input: &str,
    new_input: &str,
    reason: &str,
    in_place: bool,
) -> Result<()> {
    if reason.trim().is_empty() {
        bail!("replacement reason must not be empty");
    }
    let graph = store.graph().await?;
    let old = graph.current_node(old_input)?;
    let new = graph.current_node(new_input)?;
    let old_id = old.key();
    let new_id = new.key();
    if old_id == new_id {
        bail!("a node cannot replace itself");
    }
    if old.data.kind != new.data.kind {
        bail!("replacement requires nodes of the same kind");
    }
    if old.data.abandoned || new.data.abandoned {
        bail!("replacement endpoints must be non-abandoned current nodes");
    }
    let predecessors = graph.predecessor_map()?;
    if predecessors.contains_key(&new_id) {
        bail!("new node {new_id} already has replacement history; merging histories is not allowed");
    }

    let mut projected = graph.clone();
    let old_edges: Vec<EdgeView> = projected
        .edges
        .iter()
        .filter(|edge| edge.source == old_id || edge.target == old_id)
        .cloned()
        .collect();
    projected
        .edges
        .retain(|edge| edge.source != old_id && edge.target != old_id);
    for edge in &old_edges {
        let transferred = EdgeView {
            kind: edge.kind,
            source: if edge.source == old_id {
                new_id.clone()
            } else {
                edge.source.clone()
            },
            target: if edge.target == old_id {
                new_id.clone()
            } else {
                edge.target.clone()
            },
        };
        if !projected.edges.contains(&transferred) {
            projected.edges.push(transferred);
        }
    }
    projected.replacements.push(ReplacementData {
        old_id: old_id.clone(),
        new_id: new_id.clone(),
        reason: reason.to_string(),
        mode: if in_place {
            ReplacementMode::InPlace
        } else {
            ReplacementMode::Normal
        },
        created_at_ms: now_ms(),
    });
    if in_place {
        projected.nodes.remove(&old_id);
    }
    let reopen = projected.closed_intents_now_invalid();
    for intent in &reopen {
        if let Some(node) = projected.nodes.get_mut(intent) {
            node.data.closed = Some(false);
        }
    }
    let validation = validate_graph_semantics(&projected);
    if !validation.is_empty() {
        bail!("replacement would violate graph invariants: {}", validation.join("; "));
    }

    let mut sql = String::from("BEGIN TRANSACTION;\n");
    for table in RELATION_TABLES {
        sql.push_str(&format!(
            "DELETE {table} WHERE in = node:{old_id} OR out = node:{old_id};\n"
        ));
    }
    let existing: HashSet<EdgeView> = graph
        .edges
        .iter()
        .filter(|edge| edge.source != old_id && edge.target != old_id)
        .cloned()
        .collect();
    let mut transferred = HashSet::new();
    for edge in old_edges {
        let source = if edge.source == old_id {
            new_id.clone()
        } else {
            edge.source
        };
        let target = if edge.target == old_id {
            new_id.clone()
        } else {
            edge.target
        };
        let mapped = EdgeView { kind: edge.kind, source: source.clone(), target: target.clone() };
        if !existing.contains(&mapped) && transferred.insert(mapped) {
            sql.push_str(&format!(
                "RELATE node:{source}->{}->node:{target};\n",
                edge.kind.table()
            ));
        }
    }
    sql.push_str("CREATE replacement CONTENT $replacement;\n");
    if in_place {
        sql.push_str(&format!("DELETE node:{old_id};\n"));
    }
    for intent in &reopen {
        sql.push_str(&format!("UPDATE node:{intent} SET closed = false;\n"));
    }
    sql.push_str("COMMIT TRANSACTION;");
    let replacement = projected.replacements.last().expect("pushed replacement").clone();
    store
        .db
        .query(sql)
        .bind(("replacement", serde_json::to_value(replacement)?))
        .await?
        .check()?;
    emit(json!({
        "ok": true,
        "old": old_id,
        "new": new_id,
        "mode": if in_place { "in_place" } else { "normal" },
        "reason": reason,
        "reopened": reopen,
    }))
}

async fn abandon_command(store: &Store, input: &str, by: Actor, reason: &str) -> Result<()> {
    if reason.trim().is_empty() {
        bail!("abandonment reason must not be empty");
    }
    let graph = store.graph().await?;
    let node = graph.current_node(input)?;
    if node.data.abandoned {
        bail!("node {} is already abandoned", node.key());
    }
    let id = node.key();
    let mut reopen = Vec::new();
    if node.data.kind == NodeKind::Decision {
        for edge in graph.normalized_edges(false) {
            if edge.kind == RelationKind::Answers && edge.target == id {
                let owners = graph.containing_intents(&edge.source);
                reopen.extend(graph.intent_ancestors(&owners));
            }
        }
    }
    if node.data.kind == NodeKind::Intent {
        for edge in graph.normalized_edges(true) {
            if edge.kind == RelationKind::DependsOn && edge.target == id {
                if graph.nodes.get(&edge.source).map(|n| n.data.kind) == Some(NodeKind::Intent) {
                    reopen.extend(graph.intent_ancestors(std::slice::from_ref(&edge.source)));
                }
            }
        }
    }
    reopen.sort();
    reopen.dedup();
    let mut sql = format!(
        "BEGIN TRANSACTION;\nUPDATE node:{id} SET abandoned = true, abandonedBy = '{}', abandonedReason = $reason;\n",
        by.as_str()
    );
    for intent in &reopen {
        sql.push_str(&format!("UPDATE node:{intent} SET closed = false;\n"));
    }
    sql.push_str("COMMIT TRANSACTION;");
    store
        .db
        .query(sql)
        .bind(("reason", reason.to_string()))
        .await?
        .check()?;
    emit(json!({ "ok": true, "id": id, "abandonedBy": by, "reason": reason, "reopened": reopen }))
}

async fn delete_command(store: &Store, inputs: &[String], force: bool) -> Result<()> {
    let graph = store.graph().await?;
    let mut ids = Vec::new();
    for input in inputs {
        let id = normalize_input_id(input);
        if !graph.nodes.contains_key(&id) {
            bail!("no node {id}");
        }
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    ids.sort();
    let selected: HashSet<String> = ids.iter().cloned().collect();
    let mut affected = Vec::new();
    for edge in &graph.edges {
        if selected.contains(&edge.source) || selected.contains(&edge.target) {
            affected.push(format!("{}:{}->{}", edge.kind.table(), edge.source, edge.target));
        }
    }
    for replacement in &graph.replacements {
        if selected.contains(&replacement.old_id) || selected.contains(&replacement.new_id) {
            affected.push(format!("replacement:{}->{}", replacement.old_id, replacement.new_id));
        }
    }
    affected.sort();
    affected.dedup();
    if !force && !affected.is_empty() {
        bail!(
            "deletion affects semantic relationships; retry with --force after confirmation. affected: {}",
            affected.join(", ")
        );
    }
    if force {
        let backward = graph.predecessor_map()?;
        for id in &ids {
            let mut current = id.clone();
            let mut seen = HashSet::new();
            while let Some(previous) = backward.get(&current) {
                if !seen.insert(current.clone()) {
                    bail!("replacement cycle detected while checking deletion");
                }
                if graph.nodes.contains_key(previous) && !selected.contains(previous) {
                    bail!(
                        "deleting replacement target {id} would revive historical node {previous}; include {previous} in the forced deletion"
                    );
                }
                current = previous.clone();
            }
        }
    }

    let mut projected = graph.clone();
    projected.nodes.retain(|id, _| !selected.contains(id));
    projected
        .edges
        .retain(|edge| !selected.contains(&edge.source) && !selected.contains(&edge.target));
    projected.replacements.retain(|replacement| {
        !selected.contains(&replacement.old_id) && !selected.contains(&replacement.new_id)
    });
    let reopen = projected.closed_intents_now_invalid();

    let mut sql = String::from("BEGIN TRANSACTION;\n");
    for id in &ids {
        for table in RELATION_TABLES {
            sql.push_str(&format!(
                "DELETE {table} WHERE in = node:{id} OR out = node:{id};\n"
            ));
        }
        sql.push_str(&format!(
            "DELETE replacement WHERE oldId = '{id}' OR newId = '{id}';\n"
        ));
        sql.push_str(&format!("DELETE node:{id};\n"));
    }
    for intent in &reopen {
        if !selected.contains(intent) {
            sql.push_str(&format!("UPDATE node:{intent} SET closed = false;\n"));
        }
    }
    sql.push_str("COMMIT TRANSACTION;");
    store.checked(sql).await?;
    emit(json!({ "ok": true, "deleted": ids, "forced": force, "affected": affected, "reopened": reopen }))
}

async fn get_command(store: &Store, command: GetCommand) -> Result<()> {
    let graph = store.graph().await?;
    let mut ids: Vec<String> = match command {
        GetCommand::Intents {
            id,
            explored,
            unexplored,
            closed,
            abandoned,
            limit,
        } => {
            let filter_ids = resolve_filter_ids(&graph, &id)?;
            let mut rows = current_nodes_of_kind(&graph, NodeKind::Intent)
                .into_iter()
                .filter(|node| filter_ids.as_ref().map(|set| set.contains(&node.key())).unwrap_or(true))
                .filter(|node| abandoned || !node.data.abandoned)
                .filter(|node| closed || node.data.closed != Some(true))
                .filter(|node| !explored || node.data.explored == Some(true))
                .filter(|node| !unexplored || node.data.explored != Some(true))
                .map(|node| node.key())
                .collect();
            apply_limit(&mut rows, limit);
            rows
        }
        GetCommand::Questions {
            id,
            intent,
            asked,
            unasked,
            answered,
            abandoned,
            include_blocked,
            limit,
        } => {
            let filter_ids = resolve_filter_ids(&graph, &id)?;
            let intent_filter = resolve_filter_ids(&graph, &intent)?;
            let allowed_by_intent: Option<HashSet<String>> = if let Some(intents) = intent_filter {
                let mut questions = HashSet::new();
                for edge in graph.normalized_edges(false) {
                    if edge.kind == RelationKind::Contains
                        && intents.contains(&edge.source)
                        && graph.nodes.get(&edge.target).map(|n| n.data.kind) == Some(NodeKind::Question)
                    {
                        questions.insert(edge.target);
                    }
                }
                Some(questions)
            } else {
                None
            };
            let mut rows = current_nodes_of_kind(&graph, NodeKind::Question)
                .into_iter()
                .filter(|node| filter_ids.as_ref().map(|set| set.contains(&node.key())).unwrap_or(true))
                .filter(|node| allowed_by_intent.as_ref().map(|set| set.contains(&node.key())).unwrap_or(true))
                .filter(|node| abandoned || !node.data.abandoned)
                .filter(|node| !asked || node.data.asked == Some(true))
                .filter(|node| !unasked || node.data.asked != Some(true))
                .filter(|node| node.data.abandoned || !graph.containing_intents(&node.key()).is_empty())
                .filter(|node| {
                    let is_answered = graph.question_answered(&node.key());
                    if is_answered {
                        answered
                    } else if node.data.abandoned {
                        abandoned
                    } else {
                        include_blocked || graph.question_ready(&node.key())
                    }
                })
                .map(|node| node.key())
                .collect();
            apply_limit(&mut rows, limit);
            rows
        }
        GetCommand::Decisions {
            id,
            question,
            intent,
            soft,
            decided_by,
            abandoned,
            limit,
        } => {
            let filter_ids = resolve_filter_ids(&graph, &id)?;
            let question_filter = resolve_filter_ids(&graph, &question)?;
            let intent_filter = resolve_filter_ids(&graph, &intent)?;
            let mut by_question = HashSet::new();
            if let Some(questions) = question_filter {
                for question in questions {
                    if let Some(answer) = graph.answer_for_question(&question) {
                        by_question.insert(answer);
                    }
                }
            }
            let mut by_intent = HashSet::new();
            if let Some(intents) = intent_filter {
                for intent in intents {
                    for decision in decisions_directly_for_intent(&graph, &intent) {
                        by_intent.insert(decision);
                    }
                }
            }
            let question_is_filter = !question.is_empty();
            let intent_is_filter = !intent.is_empty();
            let mut rows = current_nodes_of_kind(&graph, NodeKind::Decision)
                .into_iter()
                .filter(|node| filter_ids.as_ref().map(|set| set.contains(&node.key())).unwrap_or(true))
                .filter(|node| !question_is_filter || by_question.contains(&node.key()))
                .filter(|node| !intent_is_filter || by_intent.contains(&node.key()))
                .filter(|node| abandoned || !node.data.abandoned)
                .filter(|node| !soft || node.data.soft == Some(true))
                .filter(|node| decided_by.map(|actor| node.data.source == Some(actor)).unwrap_or(true))
                .map(|node| node.key())
                .collect();
            apply_limit(&mut rows, limit);
            rows
        }
        GetCommand::Ideas { id, abandoned, limit } => {
            let filter_ids = resolve_filter_ids(&graph, &id)?;
            let mut rows = current_nodes_of_kind(&graph, NodeKind::Idea)
                .into_iter()
                .filter(|node| filter_ids.as_ref().map(|set| set.contains(&node.key())).unwrap_or(true))
                .filter(|node| abandoned || !node.data.abandoned)
                .map(|node| node.key())
                .collect();
            apply_limit(&mut rows, limit);
            rows
        }
        GetCommand::Facts {
            id,
            made_by,
            abandoned,
            limit,
        } => {
            let filter_ids = resolve_filter_ids(&graph, &id)?;
            let mut rows = current_nodes_of_kind(&graph, NodeKind::Fact)
                .into_iter()
                .filter(|node| filter_ids.as_ref().map(|set| set.contains(&node.key())).unwrap_or(true))
                .filter(|node| abandoned || !node.data.abandoned)
                .filter(|node| made_by.map(|actor| node.data.made_by == Some(actor)).unwrap_or(true))
                .map(|node| node.key())
                .collect();
            apply_limit(&mut rows, limit);
            rows
        }
    };
    ids.sort();
    emit(json!(ids))
}
