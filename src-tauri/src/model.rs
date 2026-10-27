pub const MAX_EDIT_BYTES: usize = 10 * 1024 * 1024;
use anyhow::{bail, ensure, Result};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
pub fn safe_text(value: &str, limit: usize) -> Result<()> {
    ensure!(
        !value.is_empty() && value.len() <= limit && !value.contains(['\0', '\r', '\n']),
        "Invalid path or text"
    );
    Ok(())
}
pub fn safe_name(value: &str, remote: bool) -> Result<()> {
    safe_text(value, 255)?;
    ensure!(
        value != "." && value != ".." && !value.contains(['/', '\\']),
        "Enter a single file or folder name"
    );
    if cfg!(windows) && !remote {
        let stem = value
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        ensure!(
            !value.contains(['<', '>', ':', '"', '|', '?', '*'])
                && !value.ends_with(['.', ' '])
                && !["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
                && !(stem.len() == 4
                    && (stem.starts_with("COM") || stem.starts_with("LPT"))
                    && stem.as_bytes()[3].is_ascii_digit()),
            "Filename cannot be represented safely on Windows"
        );
    }
    Ok(())
}
pub fn join(directory: &str, name: &str, remote: bool) -> Result<String> {
    safe_name(name, remote)?;
    Ok(if remote {
        format!("{}/{}", directory.trim_end_matches('/'), name)
    } else {
        Path::new(directory)
            .join(name)
            .to_string_lossy()
            .into_owned()
    })
}
pub fn parent(path: &str, remote: bool) -> String {
    if remote {
        path.rsplit_once('/')
            .map(|(p, _)| if p.is_empty() { "/" } else { p })
            .unwrap_or("/")
            .to_owned()
    } else {
        Path::new(path)
            .parent()
            .unwrap_or(Path::new(path))
            .to_string_lossy()
            .into_owned()
    }
}
pub fn basename(path: &str, remote: bool) -> String {
    if remote {
        path.rsplit('/').next().unwrap_or(path).to_owned()
    } else {
        Path::new(path)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned()
    }
}
pub fn nested(parent: &str, child: &str, remote: bool) -> bool {
    if remote {
        child == parent || child.starts_with(&format!("{}/", parent.trim_end_matches('/')))
    } else if cfg!(windows) {
        PathBuf::from(child.to_lowercase()).starts_with(parent.to_lowercase())
    } else {
        Path::new(child).starts_with(parent)
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Location {
    pub session_id: String,
    pub path: String,
}
impl Location {
    pub fn validate(&self) -> Result<()> {
        safe_text(&self.session_id, 128)?;
        safe_text(&self.path, 32768)
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub protocol: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub initial_path: String,
    #[serde(default)]
    pub has_password: bool,
    pub allow_insecure: bool,
}
impl Profile {
    pub fn validate(&self) -> Result<()> {
        safe_text(&self.id, 128)?;
        safe_text(&self.name, 100)?;
        safe_text(&self.host, 253)?;
        safe_text(&self.username, 256)?;
        safe_text(&self.initial_path, 32768)?;
        ensure!(
            self.port > 0
                && !self
                    .host
                    .chars()
                    .any(|c| c.is_whitespace() || "/\\@".contains(c)),
            "Invalid server address"
        );
        ensure!(
            ["sftp", "ftps", "ftp"].contains(&self.protocol.as_str()),
            "Unsupported protocol"
        );
        if self.protocol == "ftp" && !self.allow_insecure {
            bail!("Plain FTP requires explicit permission for an unencrypted connection")
        }
        Ok(())
    }
    pub fn identity(&self) -> String {
        serde_json::json!([
            self.protocol,
            self.host.to_lowercase(),
            self.port,
            self.username
        ])
        .to_string()
    }
    pub fn host_key(&self) -> String {
        format!("{}:{}", self.host.to_lowercase(), self.port)
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub label: String,
    pub path: String,
    pub protocol: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub size: u64,
    pub modified: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<u32>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JobRequest {
    pub source: Location,
    pub destination: Location,
    pub names: Vec<String>,
    pub overwrite: bool,
    pub r#move: bool,
}
impl JobRequest {
    pub fn validate(&self) -> Result<()> {
        self.source.validate()?;
        self.destination.validate()?;
        ensure!(
            !self.names.is_empty() && self.names.len() <= 10000,
            "Select between 1 and 10,000 items"
        );
        for name in &self.names {
            safe_name(name, true)?;
        }
        Ok(())
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub request: JobRequest,
    pub label: String,
    pub state: String,
    pub mode: String,
    pub bytes: u64,
    pub total: Option<u64>,
    pub files: u64,
    pub error: Option<String>,
    pub started_at: Option<u64>,
    pub finished_at: Option<u64>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub id: String,
    pub name: String,
    pub location: Location,
    pub content: String,
    pub dirty: bool,
    pub status: String,
    pub updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct StoredDocument {
    #[serde(flatten)]
    pub document: Document,
    pub version: u8,
    pub baseline: String,
    pub identity: String,
}
