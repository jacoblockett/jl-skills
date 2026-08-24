struct Store {
    db: Surreal<Db>,
    map_dir: PathBuf,
}

impl Store {
    async fn open(map_dir: PathBuf) -> Result<Self> {
        let db_path = map_dir.join("db");
        let db_endpoint = db_path.to_string_lossy().replace('\\', "/");
        let db = Surreal::new::<SurrealKv>(db_endpoint.as_str())
            .await
            .context("opening embedded SurrealKV")?;
        db.use_ns(NAMESPACE).use_db(DATABASE).await?;
        Ok(Self { db, map_dir })
    }

    async fn query_vec<T: DeserializeOwned>(&self, sql: &str) -> Result<Vec<T>> {
        let mut response = self.db.query(sql).await?;
        Ok(response.take(0)?)
    }

    async fn query_one<T: DeserializeOwned>(&self, sql: &str) -> Result<Option<T>> {
        let mut response = self.db.query(sql).await?;
        Ok(response.take(0)?)
    }

    async fn graph(&self) -> Result<Graph> {
        let nodes: Vec<DbNode> = self.query_vec("SELECT * FROM node;").await?;
        let mut edges = Vec::new();
        for (table, kind) in [
            ("contains", RelationKind::Contains),
            ("answers", RelationKind::Answers),
            ("depends_on", RelationKind::DependsOn),
            ("fact_context", RelationKind::FactContext),
            ("idea_context", RelationKind::IdeaContext),
        ] {
            let rows: Vec<DbEdge> = self.query_vec(&format!("SELECT * FROM {table};")).await?;
            for row in rows {
                let _ = row.id;
                edges.push(EdgeView {
                    kind,
                    source: record_id_key(&row.source),
                    target: record_id_key(&row.target),
                });
            }
        }
        let replacements: Vec<DbReplacement> = self.query_vec("SELECT * FROM replacement;").await?;
        let meta: DbMapMeta = self
            .query_one("SELECT * FROM map_meta:main;")
            .await?
            .ok_or_else(|| anyhow!("Map metadata is missing; run map validate or reinitialize the Map"))?;
        let _ = meta.id;
        let session: Option<DbSession> = self.query_one("SELECT * FROM map_session:main;").await?;
        Ok(Graph {
            nodes: nodes.into_iter().map(|node| (node.key(), node)).collect(),
            edges,
            replacements: replacements
                .into_iter()
                .map(|replacement| {
                    let _ = replacement.id;
                    replacement.data
                })
                .collect(),
            meta: meta.data,
            session: session.map(|session| {
                let _ = session.id;
                session.data
            }),
        })
    }

    async fn checked(&self, sql: String) -> Result<()> {
        self.db.query(sql).await?.check()?;
        Ok(())
    }
}
