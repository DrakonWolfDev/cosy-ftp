use crate::{
    endpoint::Endpoint,
    model::*,
    storage::{self, Settings},
};
use anyhow::{ensure, Context, Result};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Arc, Mutex},
};
use tauri::{AppHandle, Emitter};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use zeroize::Zeroizing;

#[derive(Clone)]
pub struct Session {
    pub info: SessionInfo,
    pub profile: Option<Profile>,
    pub password: Zeroizing<String>,
}
pub struct Data {
    pub settings: Settings,
    pub sessions: BTreeMap<String, Session>,
    pub documents: BTreeMap<String, StoredDocument>,
    pub unpersisted: BTreeSet<String>,
}
pub struct Runtime {
    pub directory: PathBuf,
    pub home: String,
    pub data: Mutex<Data>,
    pub settings_lock: Mutex<()>,
    pub profile_lock: Mutex<()>,
    pub editor_lock: Mutex<()>,
    pub trust_lock: Mutex<()>,
    pub jobs: Mutex<Vec<Job>>,
    pub cancellations: Mutex<BTreeMap<String, Arc<AtomicBool>>>,
    pub worker: AtomicBool,
    pub exiting: AtomicBool,
    pub closing: AtomicBool,
}
impl Runtime {
    pub fn load(directory: PathBuf, home: String) -> Result<Self> {
        fs::create_dir_all(directory.join("recovery"))?;
        let settings = Settings::load(&directory.join("connections.json"))?;
        let local = Session {
            info: SessionInfo {
                id: "local".into(),
                label: "This computer".into(),
                path: home.clone(),
                protocol: "local".into(),
                profile_id: None,
            },
            profile: None,
            password: Zeroizing::new(String::new()),
        };
        let mut documents = BTreeMap::new();
        for item in fs::read_dir(directory.join("recovery"))? {
            let path = item?.path();
            if path.extension().is_none_or(|e| e != "json") {
                continue;
            }
            let mut stored: StoredDocument = serde_json::from_slice(&fs::read(&path)?)
                .context("Recovery file is invalid; original preserved")?;
            ensure!(
                stored.version == 1
                    && path.file_stem().unwrap_or_default() == stored.document.id.as_str()
                    && uuid::Uuid::parse_str(&stored.document.id).is_ok(),
                "Recovery file has invalid identity; original preserved"
            );
            validate_content(&stored.document.content)?;
            stored.document.location.validate()?;
            stored.document.status = "Recovered working copy — reconnect before saving".into();
            documents.insert(stored.document.id.clone(), stored);
        }
        Ok(Self {
            directory,
            home,
            data: Mutex::new(Data {
                settings,
                sessions: BTreeMap::from([("local".into(), local)]),
                documents,
                unpersisted: BTreeSet::new(),
            }),
            settings_lock: Mutex::new(()),
            profile_lock: Mutex::new(()),
            editor_lock: Mutex::new(()),
            trust_lock: Mutex::new(()),
            jobs: Mutex::new(Vec::new()),
            cancellations: Mutex::new(BTreeMap::new()),
            worker: AtomicBool::new(false),
            exiting: AtomicBool::new(false),
            closing: AtomicBool::new(false),
        })
    }
    pub fn session(&self, id: &str) -> Result<Session> {
        self.data
            .lock()
            .unwrap()
            .sessions
            .get(id)
            .cloned()
            .context("This session is disconnected. Connect again to continue.")
    }
    pub fn endpoint(self: &Arc<Self>, app: &AppHandle, id: &str) -> Result<(Endpoint, Session)> {
        let session = self.session(id)?;
        let endpoint = self.make_endpoint(app, &session)?;
        Ok((endpoint, session))
    }
    pub fn make_endpoint(self: &Arc<Self>, app: &AppHandle, session: &Session) -> Result<Endpoint> {
        match &session.profile {
            None => Ok(Endpoint::Local),
            Some(profile) if profile.protocol == "ftps" => {
                let runtime = self.clone();
                let app = app.clone();
                Endpoint::connect_with_ftps_trust(
                    profile,
                    &session.password,
                    Arc::new(move |certificate| runtime.verify_ftps(&app, certificate)),
                )
            }
            Some(profile) => Endpoint::connect(profile, &session.password, |host, fingerprint| {
                self.verify(app, host, fingerprint)
            }),
        }
    }
    fn verify_ftps(
        &self,
        app: &AppHandle,
        certificate: &crate::ftps_trust::CertificateInfo,
    ) -> Result<bool> {
        self.verify_ftps_with(certificate, |previous| {
        let changed = previous.is_some();
        let heading = if changed {
            "The saved certificate has changed. Verify the replacement before trusting it."
        } else {
            "This server's certificate needs your explicit approval."
        };
        let names = if certificate.names.is_empty() {
            "No subject alternative names".into()
        } else {
            certificate
                .names
                .join(", ")
                .chars()
                .take(400)
                .collect::<String>()
        };
        let mismatch = if certificate.name_matches {
            String::new()
        } else {
            format!("\nNAME MISMATCH: This certificate does not cover {}. Trusting it creates an exception for this exact certificate on this server.\n", certificate.address)
        };
        let old = previous
            .map(|fingerprint| format!("\nPreviously trusted SHA-256: {fingerprint}\n"))
            .unwrap_or_default();
        let problem = certificate
            .validation_problem
            .as_deref()
            .unwrap_or("The replacement certificate passes normal certificate validation.");
        let problem = problem
            .split(" You are connecting by IP")
            .next()
            .unwrap_or(problem);
        let message = format!("{heading}\n\nServer: {}\nSHA-256 fingerprint:\n{}\n{old}{mismatch}\nSubject: {}\nIssuer: {}\nNames: {names}\nValid from: {}\nValid until: {}\n\n{problem}\n\nCompare this fingerprint with the FTPS certificate in your server's administration settings. Trust is saved only in Cosy FTP for this host and port; it does not change Windows certificate trust.", certificate.host, certificate.fingerprint, certificate.subject, certificate.issuer, certificate.not_before, certificate.not_after);
        confirm(
            app,
            if changed {
                "FTPS certificate changed"
            } else {
                "Verify FTPS certificate"
            },
            &message,
            if changed {
                "Trust replacement"
            } else {
                "Trust certificate"
            },
        )
        })
    }
    pub(crate) fn verify_ftps_with(
        &self,
        certificate: &crate::ftps_trust::CertificateInfo,
        approve: impl FnOnce(Option<&str>) -> bool,
    ) -> Result<bool> {
        let _serial = self.trust_lock.lock().unwrap();
        let previous = self
            .data
            .lock()
            .unwrap()
            .settings
            .ftps_hosts
            .get(&certificate.host)
            .cloned();
        if previous.as_deref() == Some(&certificate.fingerprint) {
            return Ok(true);
        }
        if previous.is_none() && certificate.validation_problem.is_none() {
            return Ok(true);
        }
        if !approve(previous.as_deref()) {
            return Ok(false);
        }
        self.mutate_settings(|settings| {
            settings
                .ftps_hosts
                .insert(certificate.host.clone(), certificate.fingerprint.clone());
            Ok(())
        })?;
        Ok(true)
    }
    fn verify(&self, app: &AppHandle, host: &str, fingerprint: &str) -> Result<bool> {
        let _serial = self.trust_lock.lock().unwrap();
        if let Some(saved) = self.data.lock().unwrap().settings.hosts.get(host) {
            return Ok(saved == fingerprint);
        }
        if !confirm(app, "Verify this server", &format!("Trust the SSH host key for {host}?\n\nFingerprint: {fingerprint}\n\nCompare it with a fingerprint provided by your server administrator through a trusted channel."), "Trust and connect") { return Ok(false) }
        self.mutate_settings(|settings| {
            settings.hosts.insert(host.into(), fingerprint.into());
            Ok(())
        })?;
        Ok(true)
    }
    pub fn mutate_settings<T>(&self, f: impl FnOnce(&mut Settings) -> Result<T>) -> Result<T> {
        let _serial = self.settings_lock.lock().unwrap();
        let mut next = self.data.lock().unwrap().settings.clone();
        let result = f(&mut next)?;
        storage::atomic_json(&self.directory.join("connections.json"), &next)?;
        self.data.lock().unwrap().settings = next;
        Ok(result)
    }
    pub fn document(&self, id: &str) -> Result<StoredDocument> {
        self.data
            .lock()
            .unwrap()
            .documents
            .get(id)
            .cloned()
            .context("This working copy is no longer open")
    }
    pub fn persist_document(&self, stored: &StoredDocument) -> Result<()> {
        ensure!(
            uuid::Uuid::parse_str(&stored.document.id).is_ok(),
            "Invalid document identity"
        );
        storage::atomic_json(
            &self
                .directory
                .join("recovery")
                .join(format!("{}.json", stored.document.id)),
            stored,
        )?;
        self.data
            .lock()
            .unwrap()
            .unpersisted
            .remove(&stored.document.id);
        Ok(())
    }
    pub fn set_document(&self, stored: StoredDocument) {
        self.data
            .lock()
            .unwrap()
            .documents
            .insert(stored.document.id.clone(), stored);
    }
    pub fn active(&self) -> bool {
        self.jobs
            .lock()
            .unwrap()
            .iter()
            .any(|j| ["queued", "running"].contains(&j.state.as_str()))
    }
    pub fn connected_host(&self, host: &str) -> bool {
        self.data.lock().unwrap().sessions.values().any(|s| {
            s.profile
                .as_ref()
                .is_some_and(|p| p.protocol == "sftp" && p.host_key() == host)
        })
    }
    pub fn connected_ftps_host(&self, host: &str) -> bool {
        self.data.lock().unwrap().sessions.values().any(|s| {
            s.profile
                .as_ref()
                .is_some_and(|p| p.protocol == "ftps" && p.host_key() == host)
        })
    }
    pub fn emit_jobs(&self, app: &AppHandle) {
        let _ = app.emit("cosy:jobs", self.jobs.lock().unwrap().clone());
    }
    pub fn log(&self, app: &AppHandle, message: &str, error: bool) {
        let _ = app.emit("cosy:log", json!({"time": now(), "level": if error { "error" } else { "info" }, "message": message}));
    }
    pub fn initialise(&self) -> Value {
        let data = self.data.lock().unwrap();
        json!({"buildId": env!("COSY_BUILD_ID"), "home": self.home, "profiles": data.settings.profiles,
            "sessions": data.sessions.values().map(|s| s.info.clone()).collect::<Vec<_>>(),
            "jobs": *self.jobs.lock().unwrap(), "documents": data.documents.values().map(|d| d.document.clone()).collect::<Vec<_>>(),
            "logs": [], "version": env!("CARGO_PKG_VERSION"), "canStorePasswords": storage::can_store_passwords()})
    }
}
pub fn confirm(app: &AppHandle, title: &str, message: &str, action: &str) -> bool {
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            action.into(),
            "Cancel".into(),
        ))
        .blocking_show()
}
pub fn validate_content(content: &str) -> Result<()> {
    ensure!(
        content.len() <= 2 * 1024 * 1024 && !content.contains('\0'),
        "Draft must be UTF-8 text up to 2 MiB"
    );
    Ok(())
}

// Import public profiles, pinned keys and recovery copies once. Electron's encrypted
// passwords cannot be decrypted by Tauri; require re-entry and leave originals intact.
pub fn import_electron(directory: &Path) -> Result<()> {
    if directory.join("connections.json").exists() {
        return Ok(());
    }
    let base = directories::BaseDirs::new().context("Could not locate user directories")?;
    let legacy = if cfg!(windows) {
        base.config_dir().join("cosy-ftp")
    } else {
        base.home_dir().join(".config/cosy-ftp")
    };
    import_electron_from(directory, &legacy)
}
pub(crate) fn import_electron_from(directory: &Path, legacy: &Path) -> Result<()> {
    if directory.join("connections.json").exists() {
        return Ok(());
    }
    if !legacy.join("connections.json").exists() {
        return Ok(());
    }
    let raw: Value = serde_json::from_slice(&fs::read(legacy.join("connections.json"))?)?;
    ensure!(
        raw["version"] == 1 && raw["profiles"].is_array() && raw["hosts"].is_object(),
        "Unsupported Electron settings; originals preserved"
    );
    let mut profiles = Vec::new();
    for mut value in raw["profiles"].as_array().unwrap().clone() {
        value
            .as_object_mut()
            .context("Invalid saved profile")?
            .remove("secret");
        value["hasPassword"] = json!(false);
        let profile: Profile = serde_json::from_value(value)?;
        profile.validate()?;
        profiles.push(profile);
    }
    let settings = Settings {
        version: 1,
        profiles,
        hosts: serde_json::from_value(raw["hosts"].clone())?,
        ftps_hosts: BTreeMap::new(),
    };
    fs::create_dir_all(directory.join("recovery"))?;
    if legacy.join("recovery").exists() {
        for item in fs::read_dir(legacy.join("recovery"))? {
            let path = item?.path();
            if path.extension().is_some_and(|e| e == "json") {
                let stored: StoredDocument = serde_json::from_slice(&fs::read(&path)?)?;
                ensure!(
                    uuid::Uuid::parse_str(&stored.document.id).is_ok(),
                    "Invalid recovery identity"
                );
                validate_content(&stored.document.content)?;
                storage::atomic_json(
                    &directory
                        .join("recovery")
                        .join(format!("{}.json", stored.document.id)),
                    &stored,
                )?;
            }
        }
    }
    storage::atomic_json(&directory.join("connections.json"), &settings)
}
