fn validate_graph_semantics(graph: &Graph) -> Vec<String> {
    let mut errors = Vec::new();
    if graph.meta.schema_version != SCHEMA_VERSION {
        errors.push(format!(
            "schema version {} does not match runtime {}",
            graph.meta.schema_version, SCHEMA_VERSION
        ));
    }
    for (id, node) in &graph.nodes {
        if let Err(error) = validate_node_fields(&node.data) {
            errors.push(format!("node {id}: {error}"));
        }
        if node.data.abandoned {
            if node.data.abandoned_by.is_none() || node.data.abandoned_reason.as_deref().unwrap_or("").is_empty() {
                errors.push(format!("node {id}: abandoned node lacks by/reason metadata"));
            }
        } else if node.data.abandoned_by.is_some() || node.data.abandoned_reason.is_some() {
            errors.push(format!("node {id}: non-abandoned node has abandonment metadata"));
        }
    }

    let historical = graph.historical_ids();
    let mut seen_edges = HashSet::new();
    for edge in &graph.edges {
        if !graph.nodes.contains_key(&edge.source) || !graph.nodes.contains_key(&edge.target) {
            errors.push(format!(
                "{} edge {} -> {} has missing endpoint",
                edge.kind.table(), edge.source, edge.target
            ));
            continue;
        }
        if !seen_edges.insert(edge.clone()) {
            errors.push(format!(
                "duplicate {} edge {} -> {}",
                edge.kind.table(), edge.source, edge.target
            ));
        }
        let source = &graph.nodes[&edge.source];
        let target = &graph.nodes[&edge.target];
        let legal = match edge.kind {
            RelationKind::Contains => {
                source.data.kind == NodeKind::Intent
                    && matches!(target.data.kind, NodeKind::Intent | NodeKind::Question | NodeKind::Decision)
            }
            RelationKind::Answers => {
                source.data.kind == NodeKind::Question && target.data.kind == NodeKind::Decision
            }
            RelationKind::DependsOn => {
                (source.data.kind == NodeKind::Intent && target.data.kind == NodeKind::Intent)
                    || (source.data.kind == NodeKind::Question && target.data.kind == NodeKind::Question)
            }
            RelationKind::FactContext => target.data.kind == NodeKind::Fact,
            RelationKind::IdeaContext => target.data.kind == NodeKind::Idea,
        };
        if !legal {
            errors.push(format!(
                "illegal {} edge {}({}) -> {}({})",
                edge.kind.table(),
                edge.source,
                source.data.kind.as_str(),
                edge.target,
                target.data.kind.as_str()
            ));
        }
        if historical.contains(&edge.source) || historical.contains(&edge.target) {
            errors.push(format!(
                "historical node participates in current {} edge {} -> {}",
                edge.kind.table(), edge.source, edge.target
            ));
        }
        if edge.kind == RelationKind::DependsOn && edge.source == edge.target {
            errors.push(format!("self dependency on {}", edge.source));
        }
    }

    let current_edges = graph.normalized_edges(false);
    if has_cycle(
        current_edges
            .iter()
            .filter(|edge| {
                edge.kind == RelationKind::Contains
                    && graph.nodes.get(&edge.source).map(|n| n.data.kind) == Some(NodeKind::Intent)
                    && graph.nodes.get(&edge.target).map(|n| n.data.kind) == Some(NodeKind::Intent)
            })
            .map(|edge| (edge.source.clone(), edge.target.clone()))
            .collect(),
    ) {
        errors.push("intent containment cycle".to_string());
    }
    for kind in [NodeKind::Intent, NodeKind::Question] {
        let edges = current_edges
            .iter()
            .filter(|edge| {
                edge.kind == RelationKind::DependsOn
                    && graph.nodes.get(&edge.source).map(|n| n.data.kind) == Some(kind)
                    && graph.nodes.get(&edge.target).map(|n| n.data.kind) == Some(kind)
            })
            .map(|edge| (edge.source.clone(), edge.target.clone()))
            .collect();
        if has_cycle(edges) {
            errors.push(format!("{} dependency cycle", kind.as_str()));
        }
    }

    let mut answers: HashMap<String, usize> = HashMap::new();
    for edge in &current_edges {
        if edge.kind == RelationKind::Answers {
            *answers.entry(edge.source.clone()).or_default() += 1;
        }
    }
    for (question, count) in answers {
        if count > 1 {
            errors.push(format!("question {question} has {count} current answers"));
        }
    }

    if let Err(error) = graph.replacement_map() {
        errors.push(error.to_string());
    }
    if let Err(error) = graph.predecessor_map() {
        errors.push(error.to_string());
    }
    for replacement in &graph.replacements {
        if replacement.old_id == replacement.new_id {
            errors.push(format!("replacement {} replaces itself", replacement.old_id));
        }
        match (&replacement.mode, graph.nodes.get(&replacement.old_id), graph.nodes.get(&replacement.new_id)) {
            (ReplacementMode::Normal, Some(old), Some(new)) if old.data.kind != new.data.kind => {
                errors.push(format!("replacement kind mismatch {} -> {}", replacement.old_id, replacement.new_id));
            }
            (ReplacementMode::Normal, None, _) => {
                errors.push(format!("normal replacement old node {} is missing", replacement.old_id));
            }
            (_, _, None) if !graph.replacements.iter().any(|r| r.old_id == replacement.new_id) => {
                errors.push(format!("replacement current target {} is missing", replacement.new_id));
            }
            (ReplacementMode::InPlace, Some(_), _) => {
                errors.push(format!("in-place replacement old node {} still exists", replacement.old_id));
            }
            _ => {}
        }
    }
    for old in graph.historical_ids() {
        if graph.resolve_id(&old).is_err() {
            errors.push(format!("replacement chain from {old} has no valid current node"));
        }
    }

    for (id, node) in &graph.nodes {
        if node.data.kind == NodeKind::Intent
            && graph.is_current_id(id)
            && !node.data.abandoned
            && node.data.closed == Some(true)
        {
            for error in graph.close_errors(id) {
                errors.push(format!("closed intent {id}: {error}"));
            }
        }
    }
    errors.sort();
    errors.dedup();
    errors
}

fn validate_node_fields(node: &NodeData) -> Result<()> {
    match node.kind {
        NodeKind::Intent => {
            if node.explored.is_none() || node.closed.is_none() {
                bail!("intent requires explored and closed fields");
            }
            ensure_absent(node, &["reason", "asked", "source", "assistantReasoning", "notes", "soft", "madeBy"])?;
        }
        NodeKind::Question => {
            if node.asked.is_none() {
                bail!("question requires asked field");
            }
            ensure_absent(node, &["context", "explored", "closed", "depth", "stance", "source", "assistantReasoning", "notes", "soft", "madeBy"])?;
        }
        NodeKind::Decision => {
            let source = node.source.ok_or_else(|| anyhow!("decision requires source"))?;
            if node.soft.is_none() {
                bail!("decision requires soft field");
            }
            match source {
                Actor::Assistant if node.assistant_reasoning.as_deref().unwrap_or("").is_empty() => {
                    bail!("assistant decision requires assistantReasoning")
                }
                Actor::User if node.assistant_reasoning.is_some() => {
                    bail!("user decision cannot contain assistantReasoning")
                }
                _ => {}
            }
            ensure_absent(node, &["context", "explored", "closed", "depth", "stance", "reason", "asked", "madeBy"])?;
        }
        NodeKind::Idea => {
            ensure_absent(node, &["context", "explored", "closed", "depth", "stance", "reason", "asked", "source", "assistantReasoning", "notes", "soft", "madeBy"])?;
        }
        NodeKind::Fact => {
            if node.made_by.is_none() {
                bail!("fact requires madeBy");
            }
            ensure_absent(node, &["context", "explored", "closed", "depth", "stance", "reason", "asked", "source", "assistantReasoning", "notes", "soft"])?;
        }
    }
    Ok(())
}

fn ensure_absent(node: &NodeData, fields: &[&str]) -> Result<()> {
    for field in fields {
        let present = match *field {
            "context" => node.context.is_some(),
            "explored" => node.explored.is_some(),
            "closed" => node.closed.is_some(),
            "depth" => node.depth.is_some(),
            "stance" => node.stance.is_some(),
            "reason" => node.reason.is_some(),
            "asked" => node.asked.is_some(),
            "source" => node.source.is_some(),
            "assistantReasoning" => node.assistant_reasoning.is_some(),
            "notes" => node.notes.is_some(),
            "soft" => node.soft.is_some(),
            "madeBy" => node.made_by.is_some(),
            _ => false,
        };
        if present {
            bail!("{} node cannot contain {field}", node.kind.as_str());
        }
    }
    Ok(())
}

fn has_cycle(edges: Vec<(String, String)>) -> bool {
    let mut nodes = HashSet::new();
    let mut indegree: HashMap<String, usize> = HashMap::new();
    let mut outgoing: HashMap<String, Vec<String>> = HashMap::new();
    for (source, target) in edges {
        nodes.insert(source.clone());
        nodes.insert(target.clone());
        outgoing.entry(source).or_default().push(target.clone());
        *indegree.entry(target).or_default() += 1;
    }
    let mut queue = VecDeque::new();
    for node in &nodes {
        if indegree.get(node).copied().unwrap_or(0) == 0 {
            queue.push_back(node.clone());
        }
    }
    let mut visited = 0usize;
    while let Some(node) = queue.pop_front() {
        visited += 1;
        for target in outgoing.get(&node).into_iter().flatten() {
            let entry = indegree.entry(target.clone()).or_default();
            *entry -= 1;
            if *entry == 0 {
                queue.push_back(target.clone());
            }
        }
    }
    visited != nodes.len()
}

fn dependency_satisfied(graph: &Graph, source: &str, target: &str) -> bool {
    let Some(source_node) = graph.nodes.get(source) else {
        return false;
    };
    let Some(target_node) = graph.nodes.get(target) else {
        return false;
    };
    match source_node.data.kind {
        NodeKind::Intent if target_node.data.kind == NodeKind::Intent => {
            !target_node.data.abandoned && target_node.data.closed == Some(true)
        }
        NodeKind::Question if target_node.data.kind == NodeKind::Question => {
            target_node.data.abandoned || graph.question_answered(target)
        }
        _ => false,
    }
}

fn node_output(graph: &Graph, node: &DbNode) -> Value {
    let mut value = serde_json::to_value(&node.data).expect("serializable node");
    let object = value.as_object_mut().expect("node serializes as object");
    object.insert("id".to_string(), json!(node.key()));
    if node.data.kind == NodeKind::Intent {
        object.insert("effectiveDepth".to_string(), json!(graph.effective_depth(node)));
        object.insert("effectiveStance".to_string(), json!(graph.effective_stance(node)));
    }
    if node.data.kind == NodeKind::Question {
        object.insert("answered".to_string(), json!(graph.question_answered(&node.key())));
        object.insert("ready".to_string(), json!(graph.question_ready(&node.key())));
    }
    value
}

fn current_nodes_of_kind(graph: &Graph, kind: NodeKind) -> Vec<&DbNode> {
    let mut nodes: Vec<&DbNode> = graph
        .nodes
        .iter()
        .filter(|(id, node)| graph.is_current_id(id) && node.data.kind == kind)
        .map(|(_, node)| node)
        .collect();
    nodes.sort_by_key(|node| node.key());
    nodes
}

fn resolve_filter_ids(graph: &Graph, ids: &[String]) -> Result<Option<HashSet<String>>> {
    if ids.is_empty() {
        return Ok(None);
    }
    let mut out = HashSet::new();
    for id in ids {
        out.insert(graph.resolve_id(id)?);
    }
    Ok(Some(out))
}

fn decisions_directly_for_intent(graph: &Graph, intent: &str) -> Vec<String> {
    let edges = graph.normalized_edges(false);
    let mut questions = HashSet::new();
    let mut decisions = HashSet::new();
    for edge in &edges {
        if edge.kind == RelationKind::Contains && edge.source == intent {
            match graph.nodes.get(&edge.target).map(|node| node.data.kind) {
                Some(NodeKind::Question) => {
                    questions.insert(edge.target.clone());
                }
                Some(NodeKind::Decision) => {
                    decisions.insert(edge.target.clone());
                }
                _ => {}
            }
        }
    }
    for edge in &edges {
        if edge.kind == RelationKind::Answers && questions.contains(&edge.source) {
            decisions.insert(edge.target.clone());
        }
    }
    let mut result: Vec<String> = decisions.into_iter().collect();
    result.sort();
    result
}

fn apply_limit(values: &mut Vec<String>, limit: Option<usize>) {
    values.sort();
    if let Some(limit) = limit {
        values.truncate(limit);
    }
}
