async fn show_command(store: &Store, inputs: &[String]) -> Result<()> {
    let graph = store.graph().await?;
    let mut output = Vec::new();
    for input in inputs {
        let node = graph.current_node(input)?;
        output.push(node_output(&graph, node));
    }
    if output.len() == 1 {
        emit(output.remove(0))
    } else {
        emit(Value::Array(output))
    }
}

async fn context_command(store: &Store, input: &str) -> Result<()> {
    let graph = store.graph().await?;
    let node = graph.current_node(input)?;
    if node.data.abandoned {
        bail!("context is current-state oriented; node {} is abandoned", node.key());
    }
    let id = node.key();
    let edges = graph.normalized_edges(false);
    let mut parents = Vec::new();
    let mut children = Vec::new();
    let mut facts = Vec::new();
    let mut ideas = Vec::new();
    let mut dependencies = Vec::new();
    let mut dependents = Vec::new();
    let mut answer = None;

    for edge in &edges {
        match edge.kind {
            RelationKind::Contains => {
                if edge.target == id {
                    parents.push(edge.source.clone());
                }
                if edge.source == id {
                    children.push(edge.target.clone());
                }
            }
            RelationKind::Answers => {
                if edge.source == id {
                    answer = Some(edge.target.clone());
                }
                if edge.target == id {
                    parents.push(edge.source.clone());
                }
            }
            RelationKind::DependsOn => {
                if edge.source == id {
                    dependencies.push(json!({
                        "id": edge.target,
                        "satisfied": dependency_satisfied(&graph, &edge.source, &edge.target),
                    }));
                }
                if edge.target == id {
                    dependents.push(edge.source.clone());
                }
            }
            RelationKind::FactContext => {
                if edge.source == id {
                    facts.push(edge.target.clone());
                }
            }
            RelationKind::IdeaContext => {
                if edge.source == id {
                    ideas.push(edge.target.clone());
                }
            }
        }
    }
    parents.sort();
    parents.dedup();
    children.sort();
    children.dedup();
    facts.sort();
    facts.dedup();
    ideas.sort();
    ideas.dedup();
    dependents.sort();
    dependents.dedup();

    let mut payload = json!({
        "node": node_output(&graph, node),
        "parents": parents,
        "children": children,
        "dependencies": dependencies,
        "dependents": dependents,
        "facts": facts,
        "ideas": ideas,
    });
    if let Some(answer) = answer {
        payload["answer"] = json!(answer);
    }
    if node.data.kind == NodeKind::Intent {
        payload["scopeQuestions"] = json!(graph.questions_in_scope(&id));
        payload["scopeDecisions"] = json!(graph.decisions_in_scope(&id));
    }
    emit(payload)
}

async fn status_command(store: &Store) -> Result<()> {
    let graph = store.graph().await?;
    let mut counts = serde_json::Map::new();
    for kind in [
        NodeKind::Intent,
        NodeKind::Question,
        NodeKind::Decision,
        NodeKind::Idea,
        NodeKind::Fact,
    ] {
        let mut current = 0usize;
        let mut abandoned = 0usize;
        for (id, node) in &graph.nodes {
            if node.data.kind != kind || !graph.is_current_id(id) {
                continue;
            }
            if node.data.abandoned {
                abandoned += 1;
            } else {
                current += 1;
            }
        }
        counts.insert(
            kind.as_str().to_string(),
            json!({ "current": current, "abandoned": abandoned }),
        );
    }
    emit(json!({
        "path": store.map_dir,
        "runtimeVersion": env!("CARGO_PKG_VERSION"),
        "schemaVersion": graph.meta.schema_version,
        "depth": graph.meta.depth,
        "stance": graph.meta.stance,
        "nodes": counts,
        "historicalReplacements": graph.replacements.len(),
        "session": graph.session.is_some(),
    }))
}

async fn validate_command(store: &Store) -> Result<()> {
    let graph = store.graph().await?;
    let errors = validate_graph_semantics(&graph);
    emit(json!({ "ok": errors.is_empty(), "errors": errors }))
}

async fn search_command(store: &Store, query: &str, limit: usize, include_history: bool) -> Result<()> {
    let graph = store.graph().await?;
    let historical = graph.historical_ids();
    let normalized_query = normalize_text(query);
    let query_tokens: HashSet<&str> = normalized_query.split_whitespace().collect();
    let mut scored = Vec::new();
    for (id, node) in &graph.nodes {
        if node.data.abandoned || (!include_history && historical.contains(id)) {
            continue;
        }
        let mut fields = vec![node.data.text.as_str()];
        if let Some(value) = node.data.context.as_deref() {
            fields.push(value);
        }
        if let Some(value) = node.data.reason.as_deref() {
            fields.push(value);
        }
        if let Some(value) = node.data.assistant_reasoning.as_deref() {
            fields.push(value);
        }
        if let Some(value) = node.data.notes.as_deref() {
            fields.push(value);
        }
        let normalized_text = normalize_text(&node.data.text);
        let mut score = if normalized_text == normalized_query { 10_000 } else { 0 };
        for keyword in &node.data.keywords {
            if normalize_text(keyword) == normalized_query {
                score = score.max(5_000);
            }
        }
        let haystack = normalize_text(
            &fields
                .into_iter()
                .chain(node.data.keywords.iter().map(String::as_str))
                .collect::<Vec<_>>()
                .join(" "),
        );
        let hay_tokens: HashSet<&str> = haystack.split_whitespace().collect();
        score += query_tokens.intersection(&hay_tokens).count() as i32;
        if !normalized_query.is_empty() && haystack.contains(&normalized_query) {
            score += 100;
        }
        if score > 0 {
            scored.push((score, id.clone()));
        }
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    let results: Vec<String> = scored.into_iter().take(limit).map(|(_, id)| id).collect();
    emit(json!(results))
}

async fn history_command(store: &Store, input: &str, limit: Option<usize>) -> Result<()> {
    let graph = store.graph().await?;
    if !graph.nodes.contains_key(input)
        && !graph.replacements.iter().any(|r| r.old_id == input || r.new_id == input)
    {
        bail!("no node or replacement history for {input}");
    }
    let forward = graph.replacement_map()?;
    let backward = graph.predecessor_map()?;
    let mut root = input.to_string();
    let mut seen = HashSet::new();
    while let Some(previous) = backward.get(&root) {
        if !seen.insert(root.clone()) {
            bail!("replacement cycle detected");
        }
        root = previous.clone();
    }
    let mut nodes = Vec::new();
    let mut events = Vec::new();
    let mut current = root.clone();
    let mut count = 0usize;
    loop {
        let node = graph.nodes.get(&current).map(|node| node_output(&graph, node));
        nodes.push(json!({ "id": current, "node": node }));
        let Some(next) = forward.get(&current) else {
            break;
        };
        if let Some(event) = graph.replacements.iter().find(|r| r.old_id == current && r.new_id == *next) {
            events.push(json!(event));
        }
        current = next.clone();
        count += 1;
        if limit.map(|limit| count >= limit).unwrap_or(false) {
            break;
        }
    }
    emit(json!({ "root": root, "current": graph.resolve_id(input).ok(), "nodes": nodes, "events": events }))
}

async fn session_command(store: &Store, command: SessionCommand) -> Result<()> {
    let graph = store.graph().await?;
    match command {
        SessionCommand::Init => {
            if graph.session.is_some() {
                bail!("a Map recovery session already exists");
            }
            let session = SessionData {
                summary: String::new(),
                exchanges: Vec::new(),
                pending: None,
                depth: DEFAULT_EXCHANGE_DEPTH,
            };
            store
                .db
                .query("CREATE ONLY map_session:main CONTENT $capsule;")
                .bind(("capsule", serde_json::to_value(session)?))
                .await?
                .check()?;
            emit(json!({ "ok": true, "session": true }))
        }
        SessionCommand::Summary { new_summary } => {
            let session = graph.session.ok_or_else(|| anyhow!("no Map recovery session"))?;
            if let Some(summary) = new_summary {
                let normalized = normalize_summary(&summary);
                if normalized.chars().count() > SUMMARY_LIMIT {
                    bail!("summary exceeds {SUMMARY_LIMIT} Unicode characters");
                }
                store
                    .db
                    .query("UPDATE map_session:main SET summary = $summary;")
                    .bind(("summary", normalized.clone()))
                    .await?
                    .check()?;
                emit(json!({ "summary": normalized }))
            } else {
                emit(json!({ "summary": session.summary }))
            }
        }
        SessionCommand::Exchange {
            user,
            assistant,
            depth,
        } => {
            let mut session = graph.session.ok_or_else(|| anyhow!("no Map recovery session"))?;
            if user.is_none() && assistant.is_none() && depth.is_none() {
                return emit(json!({ "depth": session.depth, "exchanges": session.exchanges }));
            }
            if let Some(new_depth) = depth {
                if new_depth < MIN_EXCHANGE_DEPTH {
                    bail!("exchange depth must be at least {MIN_EXCHANGE_DEPTH}");
                }
                session.depth = new_depth;
            }
            if let Some(message) = user {
                session.exchanges.push(Exchange {
                    role: "user".to_string(),
                    message,
                });
            }
            if let Some(message) = assistant {
                session.exchanges.push(Exchange {
                    role: "assistant".to_string(),
                    message,
                });
            }
            if session.exchanges.len() > session.depth {
                let remove = session.exchanges.len() - session.depth;
                session.exchanges.drain(0..remove);
            }
            store
                .db
                .query("UPDATE map_session:main SET exchanges = $exchanges, depth = $depth;")
                .bind(("exchanges", serde_json::to_value(session.exchanges.clone())?))
                .bind(("depth", session.depth))
                .await?
                .check()?;
            emit(json!({ "depth": session.depth, "exchanges": session.exchanges }))
        }
        SessionCommand::Pending { new_pending, clear } => {
            let session = graph.session.ok_or_else(|| anyhow!("no Map recovery session"))?;
            if clear {
                store
                    .checked("UPDATE map_session:main SET pending = NONE;".to_string())
                    .await?;
                emit(json!({ "pending": Value::Null }))
            } else if let Some(pending) = new_pending {
                store
                    .db
                    .query("UPDATE map_session:main SET pending = $pending;")
                    .bind(("pending", pending.clone()))
                    .await?
                    .check()?;
                emit(json!({ "pending": pending }))
            } else {
                emit(json!({ "pending": session.pending }))
            }
        }
        SessionCommand::End { force } => {
            let session = graph.session.ok_or_else(|| anyhow!("no Map recovery session"))?;
            if session.pending.is_some() && !force {
                bail!("session has pending work; use --force only after explicit abandonment confirmation");
            }
            store.checked("DELETE map_session:main;".to_string()).await?;
            emit(json!({ "ok": true, "ended": true, "forced": force }))
        }
    }
}
