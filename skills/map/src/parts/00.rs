use std::collections::{HashMap, HashSet, VecDeque};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Context, Result};
use clap::{Args, Parser, Subcommand, ValueEnum};
use rand::Rng;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use surrealdb::engine::local::{Db, SurrealKv};
use surrealdb::{RecordId, Surreal};

const NAMESPACE: &str = "map";
const DATABASE: &str = "state";
const SCHEMA_VERSION: &str = "2";
const SUMMARY_LIMIT: usize = 2200;
const DEFAULT_EXCHANGE_DEPTH: usize = 6;
const MIN_EXCHANGE_DEPTH: usize = 2;
const RELATION_TABLES: [&str; 5] = [
    "contains",
    "answers",
    "depends_on",
    "fact_context",
    "idea_context",
];

#[derive(Parser, Debug)]
#[command(name = "map", version, about = "Durable local intent graph")]
struct Cli {
    #[arg(long, global = true)]
    path: Option<PathBuf>,
    #[arg(long, global = true)]
    config: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    Init {
        #[arg(long)]
        schema: Option<PathBuf>,
    },
    Create {
        #[command(subcommand)]
        kind: CreateCommand,
    },
    Relate(RelationArgs),
    Unrelate(RelationArgs),
    Set(SetArgs),
    Replace {
        old_id: String,
        new_id: String,
        #[arg(long)]
        reason: String,
        #[arg(long)]
        in_place: bool,
    },
    Abandon {
        id: String,
        #[arg(long, value_enum)]
        by: Actor,
        #[arg(long)]
        reason: String,
    },
    Delete {
        #[arg(required = true, num_args = 1..)]
        ids: Vec<String>,
        #[arg(long)]
        force: bool,
    },
    Get {
        #[command(subcommand)]
        kind: GetCommand,
    },
    Show {
        #[arg(required = true, num_args = 1..)]
        ids: Vec<String>,
    },
    Context {
        id: String,
    },
    Status,
    Validate,
    Search {
        query: String,
        #[arg(long, default_value_t = 10)]
        limit: usize,
        #[arg(long)]
        include_history: bool,
    },
    History {
        id: String,
        #[arg(long)]
        limit: Option<usize>,
    },
    Session {
        #[command(subcommand)]
        command: SessionCommand,
    },
}

#[derive(Subcommand, Debug)]
enum CreateCommand {
    Intent {
        intent: String,
        #[arg(long)]
        context: Option<String>,
        #[arg(long, value_enum)]
        depth: Option<Depth>,
        #[arg(long, value_enum)]
        stance: Option<Stance>,
    },
    Question {
        question: String,
        #[arg(long)]
        intent: String,
        #[arg(long)]
        reason: Option<String>,
    },
    Decision {
        decision: String,
        #[arg(long)]
        question: Option<String>,
        #[arg(long, value_enum, default_value = "user")]
        source: Actor,
        #[arg(long)]
        assistant_reasoning: Option<String>,
        #[arg(long)]
        notes: Option<String>,
        #[arg(long)]
        soft: bool,
    },
    Idea {
        idea: String,
    },
    Fact {
        fact: String,
        #[arg(long, value_enum, default_value = "user")]
        made_by: Actor,
    },
}

#[derive(Args, Debug)]
struct RelationArgs {
    source_id: String,
    #[arg(required = true, num_args = 1..)]
    target_ids: Vec<String>,
    #[arg(long)]
    dependent: bool,
}

#[derive(Args, Debug)]
struct SetArgs {
    #[arg(required = true, num_args = 2..=3)]
    parts: Vec<String>,
}

#[derive(Subcommand, Debug)]
enum GetCommand {
    Intents {
        #[arg(long, num_args = 1..)]
        id: Vec<String>,
        #[arg(long, conflicts_with = "unexplored")]
        explored: bool,
        #[arg(long, conflicts_with = "explored")]
        unexplored: bool,
        #[arg(long)]
        closed: bool,
        #[arg(long)]
        abandoned: bool,
        #[arg(long)]
        limit: Option<usize>,
    },
    Questions {
        #[arg(long, num_args = 1..)]
        id: Vec<String>,
        #[arg(long, num_args = 1..)]
        intent: Vec<String>,
        #[arg(long, conflicts_with = "unasked")]
        asked: bool,
        #[arg(long, conflicts_with = "asked")]
        unasked: bool,
        #[arg(long)]
        answered: bool,
        #[arg(long)]
        abandoned: bool,
        #[arg(long)]
        include_blocked: bool,
        #[arg(long)]
        limit: Option<usize>,
    },
    Decisions {
        #[arg(long, num_args = 1..)]
        id: Vec<String>,
        #[arg(long, num_args = 1..)]
        question: Vec<String>,
        #[arg(long, num_args = 1..)]
        intent: Vec<String>,
        #[arg(long)]
        soft: bool,
        #[arg(long, value_enum)]
        decided_by: Option<Actor>,
        #[arg(long)]
        abandoned: bool,
        #[arg(long)]
        limit: Option<usize>,
    },
    Ideas {
        #[arg(long, num_args = 1..)]
        id: Vec<String>,
        #[arg(long)]
        abandoned: bool,
        #[arg(long)]
        limit: Option<usize>,
    },
    Facts {
        #[arg(long, num_args = 1..)]
        id: Vec<String>,
        #[arg(long, value_enum)]
        made_by: Option<Actor>,
        #[arg(long)]
        abandoned: bool,
        #[arg(long)]
        limit: Option<usize>,
    },
}

#[derive(Subcommand, Debug)]
enum SessionCommand {
    Init,
    Summary {
        new_summary: Option<String>,
    },
    Exchange {
        #[arg(short = 'u', long, conflicts_with = "assistant")]
        user: Option<String>,
        #[arg(short = 'a', long, conflicts_with = "user")]
        assistant: Option<String>,
        #[arg(long)]
        depth: Option<usize>,
    },
    Pending {
        new_pending: Option<String>,
        #[arg(long, conflicts_with = "new_pending")]
        clear: bool,
    },
    End {
        #[arg(long)]
        force: bool,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, ValueEnum)]
#[serde(rename_all = "lowercase")]
enum NodeKind {
    Intent,
    Question,
    Decision,
    Idea,
    Fact,
}

impl NodeKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Intent => "intent",
            Self::Question => "question",
            Self::Decision => "decision",
            Self::Idea => "idea",
            Self::Fact => "fact",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, ValueEnum)]
#[serde(rename_all = "lowercase")]
enum Actor {
    User,
    Assistant,
}

impl Actor {
    fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, ValueEnum)]
#[serde(rename_all = "lowercase")]
enum Depth {
    Mvp,
    Thorough,
}

impl Depth {
    fn as_str(self) -> &'static str {
        match self {
            Self::Mvp => "mvp",
            Self::Thorough => "thorough",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, ValueEnum)]
#[serde(rename_all = "lowercase")]
enum Stance {
    Normal,
    Adversarial,
}

impl Stance {
    fn as_str(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::Adversarial => "adversarial",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NodeData {
    kind: NodeKind,
    text: String,
    #[serde(default)]
    keywords: Vec<String>,
    #[serde(default)]
    abandoned: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    abandoned_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    abandoned_by: Option<Actor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    context: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    explored: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    closed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    depth: Option<Depth>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    stance: Option<Stance>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    asked: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source: Option<Actor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    assistant_reasoning: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    soft: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    made_by: Option<Actor>,
}

impl NodeData {
    fn base(kind: NodeKind, text: String) -> Self {
        Self {
            kind,
            text,
            keywords: Vec::new(),
            abandoned: false,
            abandoned_reason: None,
            abandoned_by: None,
            context: None,
            explored: None,
            closed: None,
            depth: None,
            stance: None,
            reason: None,
            asked: None,
            source: None,
            assistant_reasoning: None,
            notes: None,
            soft: None,
            made_by: None,
        }
    }
}

fn record_id_key(id: &RecordId) -> String {
    String::try_from(id.key().clone()).expect("Map record IDs must use string keys")
}

#[derive(Debug, Clone, Deserialize)]
struct DbNode {
    id: RecordId,
    #[serde(flatten)]
    data: NodeData,
}

impl DbNode {
    fn key(&self) -> String {
        record_id_key(&self.id)
    }
}

#[derive(Debug, Clone, Deserialize)]
struct DbEdge {
    id: RecordId,
    #[serde(rename = "in")]
    source: RecordId,
    #[serde(rename = "out")]
    target: RecordId,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ReplacementMode {
    Normal,
    InPlace,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReplacementData {
    old_id: String,
    new_id: String,
    reason: String,
    mode: ReplacementMode,
    created_at_ms: i64,
}

#[derive(Debug, Clone, Deserialize)]
struct DbReplacement {
    id: RecordId,
    #[serde(flatten)]
    data: ReplacementData,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MapMetaData {
    depth: Depth,
    stance: Stance,
    schema_version: String,
}

#[derive(Debug, Clone, Deserialize)]
struct DbMapMeta {
    id: RecordId,
    #[serde(flatten)]
    data: MapMetaData,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Exchange {
    role: String,
    message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SessionData {
    summary: String,
    exchanges: Vec<Exchange>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending: Option<String>,
    depth: usize,
}

#[derive(Debug, Clone, Deserialize)]
struct DbSession {
    id: RecordId,
    #[serde(flatten)]
    data: SessionData,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct MapRc {
    path: Option<PathBuf>,
    schema: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum RelationKind {
    Contains,
    Answers,
    DependsOn,
    FactContext,
    IdeaContext,
}

impl RelationKind {
    fn table(self) -> &'static str {
        match self {
            Self::Contains => "contains",
            Self::Answers => "answers",
            Self::DependsOn => "depends_on",
            Self::FactContext => "fact_context",
            Self::IdeaContext => "idea_context",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct EdgeView {
    kind: RelationKind,
    source: String,
    target: String,
}

#[derive(Debug, Clone)]
struct Graph {
    nodes: HashMap<String, DbNode>,
    edges: Vec<EdgeView>,
    replacements: Vec<ReplacementData>,
    meta: MapMetaData,
    session: Option<SessionData>,
}
