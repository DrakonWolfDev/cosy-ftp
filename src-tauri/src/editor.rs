use crate::{
    endpoint::{digest, Endpoint},
    model::*,
    state::{confirm, validate_content, Runtime},
};
use anyhow::{bail, ensure, Result};
use serde_json::{json, Value};
use std::{fs, io::Write, path::Path};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

impl Runtime {
    pub fn editor_command(
        self: &std::sync::Arc<Self>,
        app: &AppHandle,
        operation: &str,
        input: Value,
    ) -> Result<Value> {
        let _serial = self.editor_lock.lock().unwrap();
        if operation == "open-editor" {
            let location: Location = serde_json::from_value(input)?;
            location.validate()?;
            if let Some(stored) = self.data.lock().unwrap().documents.values().find(|d| {
                d.document.location.session_id == location.session_id
                    && d.document.location.path == location.path
            }) {
                return Ok(json!(stored.document));
            }
            let (mut endpoint, session) = self.endpoint(app, &location.session_id)?;
            let (content, baseline, _) = endpoint.read_text(&location.path)?;
            let stored = StoredDocument {
                version: 1,
                baseline,
                identity: session
                    .profile
                    .as_ref()
                    .map(|p| p.identity())
                    .unwrap_or("local".into()),
                document: Document {
                    id: new_id(),
                    name: basename(&location.path, endpoint.remote()),
                    location,
                    content,
                    dirty: false,
                    status: "Working copy loaded".into(),
                    updated_at: now(),
                    profile_id: session.info.profile_id,
                },
            };
            self.persist_document(&stored)?;
            self.set_document(stored.clone());
            return Ok(json!(stored.document));
        }
        let id = if input.is_string() {
            input.as_str().unwrap()
        } else {
            input["id"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("Missing document identity"))?
        };
        let mut stored = self.document(id)?;
        match operation {
            "save-draft" => {
                let content = input["content"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing draft text"))?;
                validate_content(content)?;
                stored.document.content = content.into();
                stored.document.dirty = digest(content.as_bytes()) != stored.baseline;
                stored.document.updated_at = now();
                stored.document.status = "Working copy saved locally".into();
                self.set_document(stored.clone());
                if self.persist_document(&stored).is_err() {
                    self.data.lock().unwrap().unpersisted.insert(id.into());
                    bail!("Recovery copy could not be saved. Your latest text remains in the open editor. Use Save copy as to rescue it.");
                }
            }
            "export-edit" => {
                let name = stored
                    .document
                    .name
                    .chars()
                    .map(|c| if "<>:\"/\\|?*\0".contains(c) { '_' } else { c })
                    .take(100)
                    .collect::<String>();
                let Some(file) = app
                    .dialog()
                    .file()
                    .set_title("Save a copy of this draft")
                    .set_file_name(format!("cosy-draft-{name}"))
                    .blocking_save_file()
                else {
                    return Ok(Value::Null);
                };
                let path = file
                    .into_path()
                    .map_err(|_| anyhow::anyhow!("Choose a local file"))?;
                let path = path
                    .parent()
                    .ok_or_else(|| anyhow::anyhow!("Choose a file destination"))?
                    .canonicalize()?
                    .join(path.file_name().unwrap());
                if stored.document.profile_id.is_none() {
                    let original_path = Path::new(&stored.document.location.path);
                    let original = original_path
                        .canonicalize()
                        .unwrap_or(std::path::absolute(original_path)?);
                    ensure!(!same_file(&original, &path)?, "Save copy as must use a separate file. Save to disk checks conflicts before updating the original.");
                }
                let mut local = Endpoint::Local;
                let exists = local.exists(&path.to_string_lossy())?;
                if exists {
                    ensure!(
                        local.stat(&path.to_string_lossy())?.kind == "file",
                        "A draft copy cannot replace a link, folder or special file"
                    );
                }
                if exists
                    && !confirm(
                        app,
                        "Replace draft copy",
                        "Replace the existing destination file?",
                        "Replace",
                    )
                {
                    return Ok(Value::Null);
                }
                let mode = if exists {
                    local.stat(&path.to_string_lossy())?.mode
                } else {
                    None
                };
                let stage = path
                    .parent()
                    .unwrap()
                    .join(format!(".cosy-draft-{}.part", new_id()));
                let result = (|| {
                    let mut writer = local.writer(&stage.to_string_lossy())?;
                    writer.write_all(stored.document.content.as_bytes())?;
                    writer.flush()?;
                    writer.finish()?;
                    local.mode(&stage.to_string_lossy(), mode)?;
                    local.rename(&stage.to_string_lossy(), &path.to_string_lossy(), exists)?;
                    Ok::<_, anyhow::Error>(())
                })();
                let _ = fs::remove_file(stage);
                result?;
                return Ok(json!(path.to_string_lossy()));
            }
            "close-edit" => {
                if stored.document.dirty
                    && !confirm(
                        app,
                        "Discard this local draft?",
                        "This removes its recovery copy. The original file will not be changed.",
                        "Discard",
                    )
                {
                    return Ok(json!(false));
                }
                fs::remove_file(self.directory.join("recovery").join(format!("{id}.json")))?;
                let mut data = self.data.lock().unwrap();
                data.documents.remove(id);
                data.unpersisted.remove(id);
                return Ok(json!(true));
            }
            "rebind-edit" => {
                let session_id = input["sessionId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing session"))?;
                let session = self.session(session_id)?;
                ensure!(
                    stored.document.profile_id == session.info.profile_id
                        && (stored.document.profile_id.is_some() || session_id == "local"),
                    "Reconnect using the same saved connection as this draft"
                );
                ensure!(
                    stored.identity
                        == session
                            .profile
                            .as_ref()
                            .map(|p| p.identity())
                            .unwrap_or("local".into()),
                    "Connection details changed; cannot bind this draft to a different server"
                );
                self.make_endpoint(app, &session)?;
                stored.document.location.session_id = session_id.into();
                stored.document.status =
                    "Reconnected — original will be checked before saving".into();
                self.persist_document(&stored)?;
                self.set_document(stored.clone());
            }
            "compare-edit" | "review-edit" | "upload-edit" => {
                let (mut endpoint, session) =
                    self.endpoint(app, &stored.document.location.session_id)?;
                ensure!(
                    stored.identity
                        == session
                            .profile
                            .as_ref()
                            .map(|p| p.identity())
                            .unwrap_or("local".into()),
                    "The connected server does not match this working copy"
                );
                let (content, revision, mode) =
                    endpoint.read_text(&stored.document.location.path)?;
                if operation == "compare-edit" {
                    return Ok(
                        json!({"documentId": id, "content": content, "revision": revision, "changed": revision != stored.baseline}),
                    );
                }
                if operation == "review-edit" {
                    ensure!(Some(revision.as_str()) == input["revision"].as_str(), "The original changed again. Refresh the comparison and review the latest version. Your draft has been kept.");
                    stored.baseline = revision;
                    stored.document.dirty =
                        digest(stored.document.content.as_bytes()) != stored.baseline;
                    stored.document.status = "Original reviewed — draft remains local".into();
                    self.persist_document(&stored)?;
                    self.set_document(stored.clone());
                } else {
                    ensure!(revision == stored.baseline, "The original file changed. Your draft is preserved locally. Compare it before replacing the original.");
                    let path = &stored.document.location.path;
                    let stage = join(
                        &parent(path, endpoint.remote()),
                        &format!(".cosy-edit-{}.part", new_id()),
                        endpoint.remote(),
                    )?;
                    let result = (|| {
                        let mut writer = endpoint.writer(&stage)?;
                        writer.write_all(stored.document.content.as_bytes())?;
                        writer.flush()?;
                        writer.finish()?;
                        ensure!(
                            endpoint.stat(&stage)?.size == stored.document.content.len() as u64,
                            "The staged save is incomplete"
                        );
                        ensure!(
                            endpoint.read_text(path)?.1 == stored.baseline,
                            "The original changed during upload. Your draft is preserved locally."
                        );
                        endpoint.mode(&stage, mode)?;
                        endpoint.rename(&stage, path, true)?;
                        Ok::<_, anyhow::Error>(())
                    })();
                    if let Err(error) = result {
                        if let Ok((mut cleanup, _)) =
                            self.endpoint(app, &stored.document.location.session_id)
                        {
                            if cleanup.exists(&stage).unwrap_or(true)
                                && cleanup.remove(&stage, false).is_err()
                            {
                                bail!("{error}. A temporary file may remain at {stage}")
                            }
                        }
                        return Err(error);
                    }
                    stored.baseline = digest(stored.document.content.as_bytes());
                    stored.document.dirty = false;
                    stored.document.status = if endpoint.remote() {
                        "Saved to server"
                    } else {
                        "Saved to disk"
                    }
                    .into();
                    stored.document.updated_at = now();
                    self.set_document(stored.clone());
                    if self.persist_document(&stored).is_err() {
                        self.data.lock().unwrap().unpersisted.insert(id.into());
                        bail!("Original saved, but recovery metadata could not be updated. Keep a copy of your text and check disk space.")
                    }
                }
            }
            _ => bail!("Unknown editor operation"),
        }
        Ok(json!(stored.document))
    }
}
fn same_file(original: &Path, destination: &Path) -> Result<bool> {
    if original == destination
        || (cfg!(windows)
            && original
                .to_string_lossy()
                .eq_ignore_ascii_case(&destination.to_string_lossy()))
    {
        return Ok(true);
    }
    if !original.exists() || !destination.exists() {
        return Ok(false);
    }
    // Compare filesystem identity to protect hard-linked originals as well.
    Ok(same_file::is_same_file(original, destination)?)
}
