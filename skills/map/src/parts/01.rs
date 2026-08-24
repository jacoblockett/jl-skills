impl Graph {
    fn replacement_map(&self) -> Result<HashMap<String, String>> {
        let mut out = HashMap::new();
        for replacement in &self.replacements {
            if let Some(existing) = out.insert(replacement.old_id.clone(), replacement.new_id.clone()) {
                if existing != replacement.new_id {
                    bail!("replacement {} has multiple current successors", replacement.old_id);
                }
            }
        }
        Ok(out)
    }

    fn predecessor_map(&self) -> Result<HashMap<String, String>> {
        let mut out = HashMap::new();
        for replacement in &self.replacements {
            if let Some(existing) = out.insert(replacement.new_id.clone(), replacement.old_id.clone()) {
                if existing != replacement.old_id {
                    bail!("replacement {} has multiple predecessors", replacement.new_id);
                }
            }
        }
        Ok(out)
    }

    fn resolve_id(&self, input: &str) -> Result<String> {
        let map = self.replacement_map()?;
        let mut current = input.to_string();
        let mut seen = HashSet::new();
        while let Some(next) = map.get(&current) {
            if !seen.insert(current.clone()) {
                bail!("replacement cycle detected at {current}");
            }
            current = next.clone();
        }
        if self.nodes.contains_key(&current) {
            Ok(current)
        } else if map.contains_key(input) {
            bail!("replacement chain for {input} resolves to missing node {current}")
        } else {
            bail!("no node {input}")
        }
    }

    fn current_node(&self, input: &str) -> Result<&DbNode> {
        let id = self.resolve_id(input)?;
        self.nodes.get(&id).ok_or_else(|| anyhow!("no node {id}"))
    }

    fn historical_ids(&self) -> HashSet<String> {
        self.replacements.iter().map(|r| r.old_id.clone()).collect()
    }

    fn is_current_id(&self, id: &str) -> bool {
        self.nodes.contains_key(id) && !self.historical_ids().contains(id)
    }

    fn current_nonabandoned(&self, id: &str) -> bool {
        self.is_current_id(id)
            && self
                .nodes
                .get(id)
                .map(|node| !node.data.abandoned)
                .unwrap_or(false)
    }

    fn normalized_edges(&self, include_abandoned: bool) -> Vec<EdgeView> {
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for edge in &self.edges {
            let Ok(source) = self.resolve_id(&edge.source) else {
                continue;
            };
            let Ok(target) = self.resolve_id(&edge.target) else {
                continue;
            };
            if !include_abandoned
                && (!self.current_nonabandoned(&source) || !self.current_nonabandoned(&target))
            {
                continue;
            }
            let normalized = EdgeView {
                kind: edge.kind,
                source,
                target,
            };
            if seen.insert(normalized.clone()) {
                out.push(normalized);
            }
        }
        out.sort_by(|a, b| {
            (a.kind.table(), &a.source, &a.target).cmp(&(b.kind.table(), &b.source, &b.target))
        });
        out
    }

    fn answer_for_question(&self, question: &str) -> Option<String> {
        self.normalized_edges(false)
            .into_iter()
            .find(|edge| edge.kind == RelationKind::Answers && edge.source == question)
            .map(|edge| edge.target)
    }

    fn question_answered(&self, question: &str) -> bool {
        self.answer_for_question(question).is_some()
    }

    fn containing_intents(&self, node_id: &str) -> Vec<String> {
        let edges = self.normalized_edges(false);
        let mut direct = HashSet::new();
        for edge in &edges {
            if edge.kind == RelationKind::Contains && edge.target == node_id {
                if self.nodes.get(&edge.source).map(|n| n.data.kind) == Some(NodeKind::Intent) {
                    direct.insert(edge.source.clone());
                }
            }
        }
        if self.nodes.get(node_id).map(|n| n.data.kind) == Some(NodeKind::Decision) {
            for edge in &edges {
                if edge.kind == RelationKind::Answers && edge.target == node_id {
                    for parent in &edges {
                        if parent.kind == RelationKind::Contains && parent.target == edge.source {
                            if self.nodes.get(&parent.source).map(|n| n.data.kind)
                                == Some(NodeKind::Intent)
                            {
                                direct.insert(parent.source.clone());
                            }
                        }
                    }
                }
            }
        }
        let mut result: Vec<String> = direct.into_iter().collect();
        result.sort();
        result
    }

    fn intent_ancestors(&self, starts: &[String]) -> Vec<String> {
        let edges = self.normalized_edges(false);
        let mut seen: HashSet<String> = starts.iter().cloned().collect();
        let mut queue: VecDeque<String> = starts.iter().cloned().collect();
        while let Some(child) = queue.pop_front() {
            for edge in &edges {
                if edge.kind != RelationKind::Contains || edge.target != child {
                    continue;
                }
                if self.nodes.get(&edge.source).map(|n| n.data.kind) != Some(NodeKind::Intent) {
                    continue;
                }
                if seen.insert(edge.source.clone()) {
                    queue.push_back(edge.source.clone());
                }
            }
        }
        let mut result: Vec<String> = seen.into_iter().collect();
        result.sort();
        result
    }

    fn intent_scope(&self, root: &str) -> Vec<String> {
        let edges = self.normalized_edges(false);
        let mut seen = HashSet::new();
        let mut queue = VecDeque::new();
        seen.insert(root.to_string());
        queue.push_back(root.to_string());
        while let Some(parent) = queue.pop_front() {
            for edge in &edges {
                if edge.kind != RelationKind::Contains || edge.source != parent {
                    continue;
                }
                if self.nodes.get(&edge.target).map(|n| n.data.kind) != Some(NodeKind::Intent) {
                    continue;
                }
                if seen.insert(edge.target.clone()) {
                    queue.push_back(edge.target.clone());
                }
            }
        }
        let mut result: Vec<String> = seen.into_iter().collect();
        result.sort();
        result
    }

    fn questions_in_scope(&self, root: &str) -> Vec<String> {
        let intents: HashSet<String> = self.intent_scope(root).into_iter().collect();
        let mut questions = HashSet::new();
        for edge in self.normalized_edges(false) {
            if edge.kind != RelationKind::Contains || !intents.contains(&edge.source) {
                continue;
            }
            if self.nodes.get(&edge.target).map(|n| n.data.kind) == Some(NodeKind::Question) {
                questions.insert(edge.target);
            }
        }
        let mut result: Vec<String> = questions.into_iter().collect();
        result.sort();
        result
    }

    fn decisions_in_scope(&self, root: &str) -> Vec<String> {
        let intents: HashSet<String> = self.intent_scope(root).into_iter().collect();
        let questions: HashSet<String> = self.questions_in_scope(root).into_iter().collect();
        let mut decisions = HashSet::new();
        for edge in self.normalized_edges(false) {
            if edge.kind == RelationKind::Contains
                && intents.contains(&edge.source)
                && self.nodes.get(&edge.target).map(|n| n.data.kind) == Some(NodeKind::Decision)
            {
                decisions.insert(edge.target.clone());
            }
            if edge.kind == RelationKind::Answers && questions.contains(&edge.source) {
                decisions.insert(edge.target.clone());
            }
        }
        let mut result: Vec<String> = decisions.into_iter().collect();
        result.sort();
        result
    }

    fn effective_depth(&self, intent: &DbNode) -> Depth {
        intent.data.depth.unwrap_or(self.meta.depth)
    }

    fn effective_stance(&self, intent: &DbNode) -> Stance {
        intent.data.stance.unwrap_or(self.meta.stance)
    }

    fn intent_dependencies_satisfied(&self, intent_id: &str) -> bool {
        for edge in self.normalized_edges(true) {
            if edge.kind != RelationKind::DependsOn || edge.source != intent_id {
                continue;
            }
            let Some(source_node) = self.nodes.get(&edge.source) else {
                return false;
            };
            let Some(target_node) = self.nodes.get(&edge.target) else {
                return false;
            };
            if source_node.data.kind != NodeKind::Intent || target_node.data.kind != NodeKind::Intent {
                continue;
            }
            if target_node.data.abandoned || target_node.data.closed != Some(true) {
                return false;
            }
        }
        true
    }

    fn question_ready(&self, question_id: &str) -> bool {
        let Some(question) = self.nodes.get(question_id) else {
            return false;
        };
        if question.data.kind != NodeKind::Question
            || question.data.abandoned
            || !self.is_current_id(question_id)
            || self.question_answered(question_id)
        {
            return false;
        }
        let owners = self.containing_intents(question_id);
        if owners.is_empty() {
            return false;
        }
        for edge in self.normalized_edges(true) {
            if edge.kind != RelationKind::DependsOn || edge.source != question_id {
                continue;
            }
            let Some(target) = self.nodes.get(&edge.target) else {
                return false;
            };
            if target.data.kind != NodeKind::Question {
                continue;
            }
            if !target.data.abandoned && !self.question_answered(&edge.target) {
                return false;
            }
        }
        for intent in self.intent_ancestors(&owners) {
            if !self.intent_dependencies_satisfied(&intent) {
                return false;
            }
        }
        true
    }

    fn close_errors(&self, intent_id: &str) -> Vec<String> {
        let mut errors = Vec::new();
        let Some(intent) = self.nodes.get(intent_id) else {
            return vec![format!("missing intent {intent_id}")];
        };
        if intent.data.kind != NodeKind::Intent {
            return vec![format!("{intent_id} is not an intent")];
        }
        if intent.data.abandoned {
            errors.push("abandoned intent cannot be closed".to_string());
        }
        if intent.data.explored != Some(true) {
            errors.push("intent has not been explored".to_string());
        }
        let scope = self.intent_scope(intent_id);
        for child in scope.iter().filter(|id| id.as_str() != intent_id) {
            if let Some(node) = self.nodes.get(child) {
                if !node.data.abandoned && node.data.closed != Some(true) {
                    errors.push(format!("child intent {child} is not closed"));
                }
            }
        }
        for scoped_intent in &scope {
            if !self.intent_dependencies_satisfied(scoped_intent) {
                errors.push(format!("intent dependency for {scoped_intent} is not satisfied"));
            }
        }
        for question in self.questions_in_scope(intent_id) {
            if let Some(node) = self.nodes.get(&question) {
                if !node.data.abandoned && !self.question_answered(&question) {
                    errors.push(format!("question {question} is unanswered"));
                }
            }
        }
        for decision in self.decisions_in_scope(intent_id) {
            if let Some(node) = self.nodes.get(&decision) {
                if !node.data.abandoned && node.data.soft == Some(true) {
                    errors.push(format!("decision {decision} is soft"));
                }
            }
        }
        errors.sort();
        errors.dedup();
        errors
    }

    fn closed_intents_now_invalid(&self) -> Vec<String> {
        let mut result = Vec::new();
        for (id, node) in &self.nodes {
            if node.data.kind == NodeKind::Intent
                && !node.data.abandoned
                && self.is_current_id(id)
                && node.data.closed == Some(true)
                && !self.close_errors(id).is_empty()
            {
                result.push(id.clone());
            }
        }
        result.sort();
        result
    }
}
