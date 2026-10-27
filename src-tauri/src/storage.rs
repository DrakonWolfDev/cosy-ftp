use crate::model::*;
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, io::Write, path::Path};

pub fn atomic_json(path: &Path, value: &impl Serialize) -> Result<()> {
    atomic_bytes(path, &serde_json::to_vec_pretty(value)?, true)
}
pub fn atomic_bytes(path: &Path, bytes: &[u8], replace: bool) -> Result<()> {
    let directory = path.parent().context("Missing parent directory")?;
    fs::create_dir_all(directory)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
    }
    let mut stage = tempfile::Builder::new()
        .prefix(".cosy-")
        .suffix(".part")
        .tempfile_in(directory)?;
    stage.write_all(bytes)?;
    stage.as_file().sync_all()?;
    if replace {
        stage.persist(path).map_err(|e| e.error)?;
    } else {
        stage.persist_noclobber(path).map_err(|e| e.error)?;
    }
    Ok(())
}
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Settings {
    pub version: u8,
    pub profiles: Vec<Profile>,
    pub hosts: BTreeMap<String, String>,
    #[serde(default, rename = "ftpsHosts")]
    pub ftps_hosts: BTreeMap<String, String>,
}
impl Settings {
    pub fn load(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self {
                version: 1,
                ..Self::default()
            });
        }
        let data: Self = serde_json::from_slice(&fs::read(path)?)
            .context("Settings could not be read; original preserved")?;
        ensure!(
            data.version == 1,
            "Unsupported settings version; original preserved"
        );
        for p in &data.profiles {
            p.validate()?;
        }
        for (host, key) in &data.hosts {
            safe_text(host, 300)?;
            safe_text(key, 300)?;
        }
        for (host, fingerprint) in &data.ftps_hosts {
            safe_text(host, 300)?;
            ensure!(
                fingerprint.len() == 95
                    && fingerprint
                        .split(':')
                        .all(|byte| byte.len() == 2 && byte.bytes().all(|c| c.is_ascii_hexdigit())),
                "Invalid saved FTPS fingerprint; original preserved"
            );
        }
        Ok(data)
    }
}
pub fn credential(id: &str) -> Result<keyring::Entry> {
    Ok(keyring::Entry::new("dev.cosyftp.desktop", id)?)
}
pub fn can_store_passwords() -> bool {
    let Ok(entry) = credential(&format!("probe-{}", new_id())) else {
        return false;
    };
    entry.set_password("availability probe").is_ok() && entry.delete_credential().is_ok()
}
