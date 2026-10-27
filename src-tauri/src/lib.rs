mod editor;
mod endpoint;
mod ftps_transport;
mod ftps_trust;
mod model;
mod sftp_replace;
mod state;
mod storage;
#[cfg(test)]
mod tests;
mod tls_errors;
mod transfers;

use anyhow::{bail, ensure, Context, Result};
use model::*;
use serde_json::{json, Value};
use state::{confirm, Runtime, Session};
use std::sync::{atomic::Ordering, Arc};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use zeroize::Zeroizing;

fn trusted_url(url: &tauri::Url) -> bool {
    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (["http", "https"].contains(&url.scheme()) && url.host_str() == Some("tauri.localhost"))
        || (cfg!(debug_assertions)
            && url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1")
            && url.port() == Some(1420))
}

#[tauri::command]
async fn dispatch(
    app: AppHandle,
    window: tauri::WebviewWindow,
    runtime: tauri::State<'_, Arc<Runtime>>,
    operation: String,
    input: Value,
) -> std::result::Result<Value, String> {
    if window.label() != "main" {
        return Err("Untrusted application window".into());
    }
    if !window.url().is_ok_and(|url| trusted_url(&url)) {
        return Err("Untrusted application page".into());
    }
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = runtime.command(&app, &operation, input);
        if result.is_err() {
            runtime.log(
                &app,
                &format!("{operation} failed. See the operation message for details."),
                true,
            );
        }
        result.map_err(|e| e.to_string())
    })
    .await
    .map_err(|_| "Desktop operation could not finish".to_owned())?
}

impl Runtime {
    fn command(self: &Arc<Self>, app: &AppHandle, operation: &str, input: Value) -> Result<Value> {
        if ["enqueue", "cancel-job", "retry-job", "clear-jobs"].contains(&operation) {
            return self.queue_command(app, operation, input);
        }
        if [
            "open-editor",
            "save-draft",
            "upload-edit",
            "compare-edit",
            "review-edit",
            "export-edit",
            "rebind-edit",
            "close-edit",
        ]
        .contains(&operation)
        {
            return self.editor_command(app, operation, input);
        }
        match operation {
            "initialise" => Ok(self.initialise()),
            "choose-folder" => Ok(match app.dialog().file().blocking_pick_folder() {
                Some(p) => json!(p
                    .into_path()
                    .map_err(|_| anyhow::anyhow!("Choose a local folder"))?
                    .to_string_lossy()),
                None => Value::Null,
            }),
            "list" => {
                let location: Location = serde_json::from_value(input)?;
                location.validate()?;
                let (mut endpoint, session) = self.endpoint(app, &location.session_id)?;
                let path = endpoint.canonical(&location.path)?;
                let mut entries = endpoint.list(&path)?;
                entries.sort_by(|a, b| {
                    (b.kind == "directory")
                        .cmp(&(a.kind == "directory"))
                        .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
                });
                if let Some(saved) = self
                    .data
                    .lock()
                    .unwrap()
                    .sessions
                    .get_mut(&location.session_id)
                {
                    saved.info.path = path.clone();
                }
                Ok(
                    json!({"location": {"sessionId": location.session_id, "path": path}, "parent": parent(&path, endpoint.remote()), "entries": entries, "label": session.info.label, "remote": endpoint.remote()}),
                )
            }
            "save-profile" => self.save_profile(input),
            "delete-profile" => {
                let _serial = self.profile_lock.lock().unwrap();
                let id = input.as_str().context("Missing profile identity")?;
                ensure!(
                    !self.data.lock().unwrap().sessions.values().any(|s| s
                        .info
                        .profile_id
                        .as_deref()
                        == Some(id)),
                    "Disconnect this connection before removing it"
                );
                let had_password = self
                    .data
                    .lock()
                    .unwrap()
                    .settings
                    .profiles
                    .iter()
                    .any(|p| p.id == id && p.has_password);
                self.mutate_settings(|settings| {
                    settings.profiles.retain(|p| p.id != id);
                    Ok(())
                })?;
                if had_password {
                    match storage::credential(id)?.delete_credential() {
                        Ok(_) | Err(keyring::Error::NoEntry) => (),
                        Err(_) => {
                            bail!("Profile removed, but its OS credential could not be deleted")
                        }
                    }
                }
                Ok(Value::Null)
            }
            "connect" => {
                let id = input["profileId"]
                    .as_str()
                    .context("Missing profile identity")?;
                let profile = self
                    .data
                    .lock()
                    .unwrap()
                    .settings
                    .profiles
                    .iter()
                    .find(|p| p.id == id)
                    .cloned()
                    .context("Saved connection no longer exists")?;
                let password = Zeroizing::new(match input.get("password") {
                    Some(v) => v.as_str().context("Invalid password")?.to_owned(),
                    None if profile.has_password => storage::credential(id)?
                        .get_password()
                        .context("Saved password unavailable. Enter it again.")?,
                    None => String::new(),
                });
                ensure!(password.len() <= 8192, "Password exceeds safety limit");
                let mut session = Session {
                    info: SessionInfo {
                        id: new_id(),
                        label: profile.name.clone(),
                        path: profile.initial_path.clone(),
                        protocol: profile.protocol.clone(),
                        profile_id: Some(profile.id.clone()),
                    },
                    profile: Some(profile),
                    password,
                };
                let mut endpoint = self.make_endpoint(app, &session)?;
                session.info.path = endpoint.canonical(&session.info.path)?;
                endpoint.list(&session.info.path)?;
                let info = session.info.clone();
                self.data
                    .lock()
                    .unwrap()
                    .sessions
                    .insert(info.id.clone(), session);
                self.log(app, "Connected to server", false);
                Ok(json!(info))
            }
            "reconnect" => {
                let id = input.as_str().context("Missing session identity")?;
                let (mut endpoint, session) = self.endpoint(app, id)?;
                ensure!(
                    session.profile.is_some(),
                    "Local folders do not need reconnecting"
                );
                endpoint.list(&session.info.path)?;
                self.log(app, "Reconnected to server", false);
                Ok(json!(session.info))
            }
            "disconnect" => {
                let id = input.as_str().context("Missing session identity")?;
                ensure!(
                    !self
                        .jobs
                        .lock()
                        .unwrap()
                        .iter()
                        .any(|j| ["queued", "running"].contains(&j.state.as_str())
                            && [
                                j.request.source.session_id.as_str(),
                                j.request.destination.session_id.as_str()
                            ]
                            .contains(&id)),
                    "Finish or cancel transfers using this session before disconnecting"
                );
                if id != "local" {
                    self.data.lock().unwrap().sessions.remove(id);
                }
                Ok(Value::Null)
            }
            "trusted-hosts" => {
                let hosts = self.data.lock().unwrap().settings.hosts.clone();
                Ok(json!(hosts.iter().map(|(host, fingerprint)| json!({"host": host, "fingerprint": fingerprint, "connected": self.connected_host(host)})).collect::<Vec<_>>()))
            }
            "trusted-certificates" => {
                let hosts = self.data.lock().unwrap().settings.ftps_hosts.clone();
                Ok(json!(hosts.iter().map(|(host, fingerprint)| json!({"host": host, "fingerprint": fingerprint, "connected": self.connected_ftps_host(host)})).collect::<Vec<_>>()))
            }
            "forget-certificate" => {
                let host = input.as_str().context("Missing host")?;
                safe_text(host, 300)?;
                let _serial = self.trust_lock.lock().unwrap();
                ensure!(
                    !self.connected_ftps_host(host),
                    "Disconnect this server's open sessions before forgetting its FTPS certificate"
                );
                if !self
                    .data
                    .lock()
                    .unwrap()
                    .settings
                    .ftps_hosts
                    .contains_key(host)
                {
                    return Ok(json!(true));
                }
                if !confirm(app, "Forget FTPS certificate?", &format!("Forget the saved certificate for {host}?\n\nThe next connection uses normal certificate validation or asks you to verify the certificate again. Profiles and passwords are retained."), "Forget certificate") { return Ok(json!(false)) }
                ensure!(
                    !self.connected_ftps_host(host),
                    "A session connected while the dialog was open. Disconnect it first."
                );
                self.mutate_settings(|settings| {
                    settings.ftps_hosts.remove(host);
                    Ok(())
                })?;
                Ok(json!(true))
            }
            "forget-host" => {
                let host = input.as_str().context("Missing host")?;
                safe_text(host, 300)?;
                let _serial = self.trust_lock.lock().unwrap();
                ensure!(
                    !self.connected_host(host),
                    "Disconnect this server's open sessions before forgetting its SSH fingerprint"
                );
                if !self.data.lock().unwrap().settings.hosts.contains_key(host) {
                    return Ok(json!(true));
                }
                if !confirm(app, "Forget SSH fingerprint?", &format!("Forget the trusted SSH fingerprint for {host}?\n\nThe next connection will require fingerprint verification. Profiles and passwords are retained."), "Forget fingerprint") { return Ok(json!(false)) }
                ensure!(
                    !self.connected_host(host),
                    "A session connected while the dialog was open. Disconnect it first."
                );
                self.mutate_settings(|s| {
                    s.hosts.remove(host);
                    Ok(())
                })?;
                Ok(json!(true))
            }
            "mkdir" | "rename" | "remove" => {
                let location: Location = serde_json::from_value(input["location"].clone())?;
                location.validate()?;
                let (mut endpoint, _) = self.endpoint(app, &location.session_id)?;
                let directory = endpoint.canonical(&location.path)?;
                if operation == "remove" {
                    let names: Vec<String> = serde_json::from_value(input["names"].clone())?;
                    ensure!(
                        !names.is_empty() && names.len() <= 10000,
                        "Invalid selection"
                    );
                    for name in &names {
                        safe_name(name, endpoint.remote())?;
                    }
                    if !confirm(app, "Permanently delete selected items?", &format!("Delete {} items in {directory}?\n\nThis cannot be undone. Folders must be empty. Symbolic links are removed without following their targets.", names.len()), "Delete permanently") { return Ok(json!(false)) }
                    for name in names {
                        let path = join(&directory, &name, endpoint.remote())?;
                        let entry = endpoint.stat(&path)?;
                        endpoint.remove(&path, entry.kind == "directory")?;
                    }
                    Ok(json!(true))
                } else {
                    let path = join(
                        &directory,
                        input["name"].as_str().context("Missing name")?,
                        endpoint.remote(),
                    )?;
                    if operation == "mkdir" {
                        endpoint.mkdir(&path)?;
                    } else {
                        let to = join(
                            &directory,
                            input["newName"].as_str().context("Missing new name")?,
                            endpoint.remote(),
                        )?;
                        endpoint.rename(&path, &to, false)?;
                    }
                    Ok(Value::Null)
                }
            }
            _ => bail!("Unknown desktop operation"),
        }
    }
    fn save_profile(&self, mut input: Value) -> Result<Value> {
        let _serial = self.profile_lock.lock().unwrap();
        let remember = input["rememberPassword"]
            .as_bool()
            .context("Missing password preference")?;
        let password = input
            .get("password")
            .map(|v| {
                v.as_str()
                    .map(|s| Zeroizing::new(s.to_owned()))
                    .context("Invalid password")
            })
            .transpose()?;
        ensure!(
            password.as_ref().is_none_or(|p| p.len() <= 8192),
            "Password exceeds safety limit"
        );
        let fields = input.as_object_mut().context("Invalid profile")?;
        fields.remove("rememberPassword");
        fields.remove("password");
        let requested = fields.get("id").and_then(|v| v.as_str()).map(str::to_owned);
        if requested.is_none() {
            fields.insert("id".into(), json!(new_id()));
        }
        fields.insert("hasPassword".into(), json!(false));
        let mut profile: Profile = serde_json::from_value(input)?;
        profile.validate()?;
        let previous = self
            .data
            .lock()
            .unwrap()
            .settings
            .profiles
            .iter()
            .find(|p| p.id == profile.id)
            .cloned();
        ensure!(
            requested.is_none() || previous.is_some(),
            "Saved connection no longer exists"
        );
        let entry = storage::credential(&profile.id)?;
        let old_password = if previous.as_ref().is_some_and(|p| p.has_password) {
            Some(Zeroizing::new(entry.get_password().context(
                "Existing OS credential unavailable; profile preserved",
            )?))
        } else {
            None
        };
        let same_server = previous
            .as_ref()
            .is_some_and(|p| p.identity() == profile.identity());
        if remember {
            if let Some(password) = &password {
                entry.set_password(password).context(
                    "Secure password storage unavailable. Save without remembering the password.",
                )?;
                profile.has_password = true;
            } else {
                profile.has_password = same_server && old_password.is_some();
            }
        }
        let result = self.mutate_settings(|settings| {
            settings.profiles.retain(|p| p.id != profile.id);
            settings.profiles.push(profile.clone());
            Ok(())
        });
        if let Err(error) = result {
            if let Some(old) = old_password {
                let _ = entry.set_password(&old);
            } else {
                let _ = entry.delete_credential();
            }
            return Err(error);
        }
        if !profile.has_password && old_password.is_some() {
            match entry.delete_credential() {
                Ok(_) | Err(keyring::Error::NoEntry) => (),
                Err(_) => {
                    bail!("Profile saved, but its previous OS credential could not be deleted")
                }
            }
        }
        Ok(json!(profile))
    }
}

pub fn run() {
    let mut builder = tauri::Builder::default();
    if std::env::var_os("COSY_USER_DATA").is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let directory = std::env::var_os("COSY_USER_DATA").map(std::path::PathBuf::from).unwrap_or(app.path().app_data_dir()?);
            if std::env::var_os("COSY_USER_DATA").is_none() { state::import_electron(&directory)?; }
            let home = directories::BaseDirs::new().context("Could not find home directory")?.home_dir().to_string_lossy().into_owned();
            app.manage(Arc::new(Runtime::load(directory, home)?));
            tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                .on_navigation(trusted_url)
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![dispatch])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let runtime = window.state::<Arc<Runtime>>().inner().clone();
                if runtime.exiting.load(Ordering::SeqCst) { return }
                api.prevent_close();
                if runtime.closing.swap(true, Ordering::SeqCst) { return }
                let app = window.app_handle().clone();
                std::thread::spawn(move || {
                    let _editor = runtime.editor_lock.lock().unwrap();
                    let recovery_failed = !runtime.data.lock().unwrap().unpersisted.is_empty();
                    if (runtime.active() || recovery_failed) && !confirm(&app, "Quit Cosy FTP?", if recovery_failed { "Recovery copies could not be saved. Some latest editor changes may not be restored. Cancel and use Save copy as to rescue your text before quitting." } else { "Quit and stop active transfers? Completed files remain. Incomplete staging files may need cleanup." }, "Quit") {
                        runtime.closing.store(false, Ordering::SeqCst); return
                    }
                    for cancel in runtime.cancellations.lock().unwrap().values() { cancel.store(true, Ordering::SeqCst); }
                    runtime.exiting.store(true, Ordering::SeqCst); app.exit(0);
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("Cosy FTP could not start");
}
