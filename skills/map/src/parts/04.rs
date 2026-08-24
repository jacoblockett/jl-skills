async fn create_node(
    store: &Store,
    graph: &Graph,
    data: NodeData,
    relation: Option<(RelationKind, String)>,
    reopen: &[String],
) -> Result<String> {
    validate_node_fields(&data)?;
    let id = generate_id(graph);
    let node_ref = format!("node:{id}");
    let mut sql = String::from("BEGIN TRANSACTION;\n");
    sql.push_str(&format!("CREATE ONLY {node_ref} CONTENT $node;\n"));
    if let Some((kind, other)) = &relation {
        match kind {
            RelationKind::Contains => {
                sql.push_str(&format!("RELATE node:{other}->contains->{node_ref};\n"));
            }
            RelationKind::Answers => {
                sql.push_str(&format!("RELATE node:{other}->answers->{node_ref};\n"));
            }
            _ => bail!("unsupported creation relation"),
        }
    }
    for intent in reopen {
        sql.push_str(&format!("UPDATE node:{intent} SET closed = false;\n"));
    }
    sql.push_str("COMMIT TRANSACTION;");
    store
        .db
        .query(sql)
        .bind(("node", serde_json::to_value(data)?))
        .await?
        .check()?;
    Ok(id)
}

async fn relate_command(store: &Store, args: RelationArgs, remove: bool) -> Result<()> {
    let graph = store.graph().await?;
    let source = graph.current_node(&args.source_id)?;
    if source.data.abandoned {
        bail!("source node is abandoned");
    }
    let source_id = source.key();
    let mut operations = Vec::new();
    for target_input in &args.target_ids {
        let target = graph.current_node(target_input)?;
        if target.data.abandoned {
            bail!("target node {} is abandoned", target.key());
        }
        let target_id = target.key();
        let kind = infer_relation(source.data.kind, target.data.kind, args.dependent)?;
        operations.push((kind, source_id.clone(), target_id));
    }

    let current_edges: HashSet<EdgeView> = graph.normalized_edges(true).into_iter().collect();
    for (kind, source, target) in &operations {
        let edge = EdgeView {
            kind: *kind,
            source: source.clone(),
            target: target.clone(),
        };
        if remove && !current_edges.contains(&edge) {
            bail!("relationship {} {} -> {} does not exist", kind.table(), source, target);
        }
        if !remove && current_edges.contains(&edge) {
            bail!("relationship {} {} -> {} already exists", kind.table(), source, target);
        }
    }

    let mut projected = graph.clone();
    if remove {
        let removing: HashSet<EdgeView> = operations
            .iter()
            .map(|(kind, source, target)| EdgeView {
                kind: *kind,
                source: source.clone(),
                target: target.clone(),
            })
            .collect();
        projected.edges.retain(|edge| !removing.contains(edge));
    } else {
        for (kind, source, target) in &operations {
            projected.edges.push(EdgeView {
                kind: *kind,
                source: source.clone(),
                target: target.clone(),
            });
        }
    }
    let mut sql = String::from("BEGIN TRANSACTION;\n");
    for (kind, source, target) in &operations {
        if remove {
            sql.push_str(&format!(
                "DELETE {} WHERE in = node:{} AND out = node:{};\n",
                kind.table(), source, target
            ));
        } else {
            sql.push_str(&format!(
                "RELATE node:{}->{}->node:{};\n",
                source,
                kind.table(),
                target
            ));
        }
    }

    let mut reopen = Vec::new();
    if remove {
        for (kind, source, _) in &operations {
            if *kind == RelationKind::Answers {
                for owner in graph.containing_intents(source) {
                    reopen.extend(graph.intent_ancestors(&[owner]));
                }
            }
        }
    } else {
        for (kind, source, target) in &operations {
            match kind {
                RelationKind::Contains => {
                    let target_node = graph.nodes.get(target).expect("validated target");
                    let stale = match target_node.data.kind {
                        NodeKind::Question => !graph.question_answered(target),
                        NodeKind::Intent => target_node.data.closed != Some(true),
                        NodeKind::Decision => target_node.data.soft == Some(true),
                        _ => false,
                    };
                    if stale {
                        reopen.extend(graph.intent_ancestors(std::slice::from_ref(source)));
                    }
                }
                RelationKind::DependsOn => {
                    if graph.nodes.get(source).map(|node| node.data.kind) == Some(NodeKind::Intent) {
                        // Adding a dependency after closure makes the prior closure claim stale,
                        // even when the prerequisite is already closed.
                        reopen.extend(graph.intent_ancestors(std::slice::from_ref(source)));
                    }
                }
                _ => {}
            }
        }
    }
    reopen.sort();
    reopen.dedup();
    for id in &reopen {
        if let Some(node) = projected.nodes.get_mut(id) {
            if node.data.kind == NodeKind::Intent {
                node.data.closed = Some(false);
            }
        }
    }
    let validation = validate_graph_semantics(&projected);
    if !validation.is_empty() {
        bail!("relationship would violate graph invariants: {}", validation.join("; "));
    }
    for id in &reopen {
        sql.push_str(&format!("UPDATE node:{id} SET closed = false;\n"));
    }
    sql.push_str("COMMIT TRANSACTION;");
    store.checked(sql).await?;
    emit(json!({
        "ok": true,
        "operation": if remove { "unrelate" } else { "relate" },
        "relationships": operations.iter().map(|(kind, source, target)| json!({
            "kind": kind.table(), "source": source, "target": target
        })).collect::<Vec<_>>()
    }))
}

fn infer_relation(source: NodeKind, target: NodeKind, dependent: bool) -> Result<RelationKind> {
    if dependent {
        return match (source, target) {
            (NodeKind::Intent, NodeKind::Intent) | (NodeKind::Question, NodeKind::Question) => {
                Ok(RelationKind::DependsOn)
            }
            _ => bail!("--dependent is only legal for intent->intent or question->question"),
        };
    }
    match (source, target) {
        (NodeKind::Intent, NodeKind::Question)
        | (NodeKind::Intent, NodeKind::Decision)
        | (NodeKind::Intent, NodeKind::Intent) => Ok(RelationKind::Contains),
        (NodeKind::Question, NodeKind::Decision) => Ok(RelationKind::Answers),
        (_, NodeKind::Fact) => Ok(RelationKind::FactContext),
        (_, NodeKind::Idea) => Ok(RelationKind::IdeaContext),
        (NodeKind::Question, NodeKind::Question) => {
            bail!("question->question requires --dependent")
        }
        _ => bail!("no legal v2 relationship exists for {source:?}->{target:?}"),
    }
}

async fn set_command(store: &Store, args: SetArgs) -> Result<()> {
    if args.parts.len() == 2 {
        let property = args.parts[0].as_str();
        let value = args.parts[1].as_str();
        return set_map_property(store, property, value).await;
    }
    let id = &args.parts[0];
    let property = &args.parts[1];
    let value = &args.parts[2];
    set_node_property(store, id, property, value).await
}

async fn set_map_property(store: &Store, property: &str, value: &str) -> Result<()> {
    let graph = store.graph().await?;
    let mut reopen = Vec::new();
    let assignment = match property {
        "depth" => {
            let new = parse_depth(value)?;
            if graph.meta.depth == Depth::Mvp && new == Depth::Thorough {
                for (id, node) in &graph.nodes {
                    if graph.is_current_id(id)
                        && !node.data.abandoned
                        && node.data.kind == NodeKind::Intent
                        && node.data.closed == Some(true)
                        && node.data.depth.is_none()
                    {
                        reopen.push(id.clone());
                    }
                }
            }
            format!("depth = '{}'", new.as_str())
        }
        "stance" => {
            let new = parse_stance(value)?;
            if graph.meta.stance == Stance::Normal && new == Stance::Adversarial {
                for (id, node) in &graph.nodes {
                    if graph.is_current_id(id)
                        && !node.data.abandoned
                        && node.data.kind == NodeKind::Intent
                        && node.data.closed == Some(true)
                        && node.data.stance.is_none()
                    {
                        reopen.push(id.clone());
                    }
                }
            }
            format!("stance = '{}'", new.as_str())
        }
        _ => bail!("Map property must be depth or stance"),
    };
    if !reopen.is_empty() {
        reopen = graph.intent_ancestors(&reopen);
    }
    let mut sql = format!("BEGIN TRANSACTION;\nUPDATE map_meta:main SET {assignment};\n");
    reopen.sort();
    reopen.dedup();
    for id in &reopen {
        sql.push_str(&format!("UPDATE node:{id} SET closed = false;\n"));
    }
    sql.push_str("COMMIT TRANSACTION;");
    store.checked(sql).await?;
    emit(json!({ "ok": true, "property": property, "value": value, "reopened": reopen }))
}

async fn set_node_property(store: &Store, input: &str, property: &str, value: &str) -> Result<()> {
    let graph = store.graph().await?;
    let node = graph.current_node(input)?;
    if node.data.abandoned {
        bail!("cannot mutate abandoned node {}", node.key());
    }
    let id = node.key();
    let mut sql = String::from("BEGIN TRANSACTION;\n");
    let mut reopen = Vec::new();

    match (node.data.kind, property) {
        (NodeKind::Intent, "explored") => {
            let parsed = parse_bool(value)?;
            sql.push_str(&format!("UPDATE node:{id} SET explored = {parsed};\n"));
            if !parsed && node.data.closed == Some(true) {
                reopen.extend(graph.intent_ancestors(std::slice::from_ref(&id)));
            }
        }
        (NodeKind::Intent, "close") => {
            let parsed = parse_bool(value)?;
            if parsed {
                let errors = graph.close_errors(&id);
                if !errors.is_empty() {
                    bail!("cannot close intent {id}: {}", errors.join("; "));
                }
                sql.push_str(&format!("UPDATE node:{id} SET closed = true;\n"));
            } else {
                reopen.extend(graph.intent_ancestors(std::slice::from_ref(&id)));
            }
        }
        (NodeKind::Intent, "depth") => {
            let old_effective = graph.effective_depth(node);
            let new_override = parse_optional_depth(value)?;
            let new_effective = new_override.unwrap_or(graph.meta.depth);
            match new_override {
                Some(depth) => sql.push_str(&format!(
                    "UPDATE node:{id} SET depth = '{}';\n",
                    depth.as_str()
                )),
                None => sql.push_str(&format!("UPDATE node:{id} SET depth = NONE;\n")),
            }
            if old_effective == Depth::Mvp && new_effective == Depth::Thorough {
                reopen.extend(graph.intent_ancestors(std::slice::from_ref(&id)));
            }
        }
        (NodeKind::Intent, "stance") => {
            let old_effective = graph.effective_stance(node);
            let new_override = parse_optional_stance(value)?;
            let new_effective = new_override.unwrap_or(graph.meta.stance);
            match new_override {
                Some(stance) => sql.push_str(&format!(
                    "UPDATE node:{id} SET stance = '{}';\n",
                    stance.as_str()
                )),
                None => sql.push_str(&format!("UPDATE node:{id} SET stance = NONE;\n")),
            }
            if old_effective == Stance::Normal && new_effective == Stance::Adversarial {
                reopen.extend(graph.intent_ancestors(std::slice::from_ref(&id)));
            }
        }
        (NodeKind::Question, "asked") => {
            let parsed = parse_bool(value)?;
            sql.push_str(&format!("UPDATE node:{id} SET asked = {parsed};\n"));
        }
        (NodeKind::Decision, "soft") => {
            let parsed = parse_bool(value)?;
            sql.push_str(&format!("UPDATE node:{id} SET soft = {parsed};\n"));
            if parsed {
                let owners = graph.containing_intents(&id);
                reopen.extend(graph.intent_ancestors(&owners));
            }
        }
        (_, "keywords") => {
            let keywords = parse_keywords(value)?;
            sql.push_str(&format!("UPDATE node:{id} SET keywords = $keywords;\n"));
            sql.push_str("COMMIT TRANSACTION;");
            store
                .db
                .query(sql)
                .bind(("keywords", keywords.clone()))
                .await?
                .check()?;
            return emit(json!({ "ok": true, "id": id, "property": property, "value": keywords }));
        }
        _ => bail!("property {property:?} does not exist on {} nodes", node.data.kind.as_str()),
    }

    reopen.sort();
    reopen.dedup();
    for intent in &reopen {
        sql.push_str(&format!("UPDATE node:{intent} SET closed = false;\n"));
    }
    sql.push_str("COMMIT TRANSACTION;");
    store.checked(sql).await?;
    emit(json!({ "ok": true, "id": id, "property": property, "value": value, "reopened": reopen }))
}
