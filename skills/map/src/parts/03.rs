#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("map: {error:#}");
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let cli = Cli::parse();
    match &cli.command {
        Command::Init { schema } => init_map(&cli, schema.clone()).await,
        _ => {
            let map_dir = resolve_existing_map(cli.path.as_deref(), cli.config.as_deref())?;
            let store = Store::open(map_dir).await?;
            ensure_project_identity(&store.map_dir)?;
            dispatch(&store, cli.command).await
        }
    }
}

async fn dispatch(store: &Store, command: Command) -> Result<()> {
    match command {
        Command::Init { .. } => unreachable!(),
        Command::Create { kind } => create_command(store, kind).await,
        Command::Relate(args) => relate_command(store, args, false).await,
        Command::Unrelate(args) => relate_command(store, args, true).await,
        Command::Set(args) => set_command(store, args).await,
        Command::Replace {
            old_id,
            new_id,
            reason,
            in_place,
        } => replace_command(store, &old_id, &new_id, &reason, in_place).await,
        Command::Abandon { id, by, reason } => abandon_command(store, &id, by, &reason).await,
        Command::Delete { ids, force } => delete_command(store, &ids, force).await,
        Command::Get { kind } => get_command(store, kind).await,
        Command::Show { ids } => show_command(store, &ids).await,
        Command::Context { id } => context_command(store, &id).await,
        Command::Status => status_command(store).await,
        Command::Validate => validate_command(store).await,
        Command::Search {
            query,
            limit,
            include_history,
        } => search_command(store, &query, limit, include_history).await,
        Command::History { id, limit } => history_command(store, &id, limit).await,
        Command::Session { command } => session_command(store, command).await,
    }
}

async fn init_map(cli: &Cli, schema_arg: Option<PathBuf>) -> Result<()> {
    let selection = resolve_init_target(cli.path.as_deref(), cli.config.as_deref())?;
    if selection.exists() {
        bail!("{} already exists", selection.display());
    }
    let parent = selection
        .parent()
        .ok_or_else(|| anyhow!("cannot determine parent for {}", selection.display()))?;
    if !parent.is_dir() {
        bail!("Map parent {} does not exist", parent.display());
    }
    let schema_path = resolve_schema(schema_arg.as_deref(), cli.config.as_deref())?;
    let schema = fs::read_to_string(&schema_path)
        .with_context(|| format!("reading schema {}", schema_path.display()))?;

    fs::create_dir(&selection)
        .with_context(|| format!("creating {}", selection.display()))?;
    let db_dir = selection.join("db");
    if let Err(error) = fs::create_dir(&db_dir) {
        let _ = fs::remove_dir_all(&selection);
        return Err(error).with_context(|| format!("creating {}", db_dir.display()));
    }
    let store = match Store::open(selection.clone()).await {
        Ok(store) => store,
        Err(error) => {
            let _ = fs::remove_dir_all(&selection);
            return Err(error);
        }
    };
    if let Err(error) = async {
        store.db.query(schema).await?.check()?;
        let meta = MapMetaData {
            depth: Depth::Mvp,
            stance: Stance::Normal,
            schema_version: SCHEMA_VERSION.to_string(),
        };
        store
            .db
            .query("CREATE ONLY map_meta:main CONTENT $meta;")
            .bind(("meta", serde_json::to_value(meta)?))
            .await?
            .check()?;
        Result::<()>::Ok(())
    }
    .await
    {
        drop(store);
        let _ = fs::remove_dir_all(&selection);
        return Err(error);
    }

    let identity = match create_project_identity(&selection) {
        Ok(identity) => identity,
        Err(error) => {
            drop(store);
            let _ = fs::remove_dir_all(&selection);
            return Err(error).context("creating new Map project identity");
        }
    };

    emit(json!({
        "ok": true,
        "path": selection,
        "schema": schema_path,
        "schemaVersion": SCHEMA_VERSION,
        "runtimeVersion": env!("CARGO_PKG_VERSION"),
        "projectId": identity.project_id,
    }))
}

async fn create_command(store: &Store, command: CreateCommand) -> Result<()> {
    let graph = store.graph().await?;
    match command {
        CreateCommand::Intent {
            intent,
            context,
            depth,
            stance,
        } => {
            let mut data = NodeData::base(NodeKind::Intent, intent);
            data.context = context;
            data.explored = Some(false);
            data.closed = Some(false);
            data.depth = depth;
            data.stance = stance;
            let id = create_node(store, &graph, data, None, &[]).await?;
            emit(json!({ "id": id }))
        }
        CreateCommand::Question {
            question,
            intent,
            reason,
        } => {
            let parent = graph.current_node(&intent)?;
            if parent.data.kind != NodeKind::Intent || parent.data.abandoned {
                bail!("question parent must be a current non-abandoned intent");
            }
            let parent_id = parent.key();
            let mut data = NodeData::base(NodeKind::Question, question);
            data.reason = reason;
            data.asked = Some(false);
            let id = create_node(
                store,
                &graph,
                data,
                Some((RelationKind::Contains, parent_id.clone())),
                &graph.intent_ancestors(std::slice::from_ref(&parent_id)),
            )
            .await?;
            emit(json!({ "id": id }))
        }
        CreateCommand::Decision {
            decision,
            question,
            source,
            assistant_reasoning,
            notes,
            soft,
        } => {
            match source {
                Actor::Assistant if assistant_reasoning.is_none() => {
                    bail!("--assistant-reasoning is required when --source assistant")
                }
                Actor::User if assistant_reasoning.is_some() => {
                    bail!("--assistant-reasoning is invalid when --source user")
                }
                _ => {}
            }
            let mut relation = None;
            if let Some(question_id) = question {
                let question_node = graph.current_node(&question_id)?;
                if question_node.data.kind != NodeKind::Question || question_node.data.abandoned {
                    bail!("--question must reference a current non-abandoned question");
                }
                let current_question = question_node.key();
                if graph.question_answered(&current_question) {
                    bail!("question {current_question} already has a current answer");
                }
                relation = Some((RelationKind::Answers, current_question));
            }
            let mut data = NodeData::base(NodeKind::Decision, decision);
            data.source = Some(source);
            data.assistant_reasoning = assistant_reasoning;
            data.notes = notes;
            data.soft = Some(soft);
            let id = create_node(store, &graph, data, relation, &[]).await?;
            emit(json!({ "id": id }))
        }
        CreateCommand::Idea { idea } => {
            let id = create_node(store, &graph, NodeData::base(NodeKind::Idea, idea), None, &[]).await?;
            emit(json!({ "id": id }))
        }
        CreateCommand::Fact { fact, made_by } => {
            let mut data = NodeData::base(NodeKind::Fact, fact);
            data.made_by = Some(made_by);
            let id = create_node(store, &graph, data, None, &[]).await?;
            emit(json!({ "id": id }))
        }
    }
}