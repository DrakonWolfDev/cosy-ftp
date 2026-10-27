//! Native implementation of Wolf Update's notification-only experimental channel.
//! Mirrors WolfLauncher/wolf_update: 24-hour checks, dismissal and a fixed project URL.
use crate::{state::Runtime, storage};
use anyhow::{ensure, Context, Result};
use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::Read,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub const PROJECT_URL: &str = "https://wolf-forge.co.uk/cosy-ftp.html";
const RELEASES_URL: &str =
    "https://api.github.com/repos/DrakonWolfDev/cosy-ftp/releases?per_page=100";
const MAX_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Default, Serialize, Deserialize)]
struct UpdateState {
    last_successful_check: Option<u64>,
    dismissed_version: Option<String>,
}

fn select_release(payload: &Value, current: &Version) -> Result<Option<(Version, String)>> {
    let releases = payload
        .as_array()
        .context("GitHub returned invalid release data")?;
    // Experimental channel includes GitHub prereleases, as in Launcher and AMP.
    Ok(releases
        .iter()
        .filter(|r| r["draft"] == false)
        .filter_map(|r| {
            let tag = r["tag_name"].as_str()?.trim();
            let version = Version::parse(tag.strip_prefix('v').unwrap_or(tag)).ok()?;
            if version.cmp_precedence(current).is_le() {
                return None;
            }
            // Rendered as plain text in React. Never execute Markdown/HTML from release notes.
            let notes = r["body"]
                .as_str()
                .unwrap_or("")
                .chars()
                .take(6000)
                .collect();
            Some((version, notes))
        })
        .max_by(|a, b| a.0.cmp_precedence(&b.0)))
}

fn throttled(state: &UpdateState, now: u64) -> bool {
    state
        .last_successful_check
        .is_some_and(|last| now >= last && now - last < 86400)
}

impl Runtime {
    pub fn check_updates(&self, input: Value) -> Result<Value> {
        let _guard = self.update_lock.lock().unwrap();
        let manual = input["manual"].as_bool().unwrap_or(false);
        let path = self.directory.join("wolf-update.json");
        let mut state: UpdateState = if path.exists() {
            serde_json::from_slice(&fs::read(&path)?)
                .context("Wolf Update settings could not be read")?
        } else {
            UpdateState::default()
        };
        let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        if !manual && throttled(&state, now) {
            return Ok(json!({"status": "throttled"}));
        }
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("CosyFTP/", env!("CARGO_PKG_VERSION")))
            .build()?;
        let response = client
            .get(RELEASES_URL)
            .header("Accept", "application/vnd.github+json")
            .send()
            .context("Could not reach GitHub. Please try again later")?;
        // Private repositories deliberately return 404 to unauthenticated clients.
        // Never embed a repository token in a distributed desktop application.
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(json!({"status": "not_published"}));
        }
        let response = response
            .error_for_status()
            .context("GitHub could not complete the update check")?;
        ensure!(
            response
                .content_length()
                .is_none_or(|size| size <= MAX_BYTES),
            "GitHub response exceeded the size limit"
        );
        let mut bytes = Vec::new();
        response.take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() as u64 <= MAX_BYTES,
            "GitHub response exceeded the size limit"
        );
        let payload =
            serde_json::from_slice(&bytes).context("GitHub returned invalid release data")?;
        let release = select_release(&payload, &Version::parse(env!("CARGO_PKG_VERSION"))?)?;
        state.last_successful_check = Some(now);
        storage::atomic_json(&path, &state)?;
        match release {
            Some((version, notes)) => {
                let version = version.to_string();
                let status = if !manual && state.dismissed_version.as_deref() == Some(&version) {
                    "dismissed"
                } else {
                    "available"
                };
                Ok(json!({"status": status, "version": version, "notes": notes}))
            }
            None => Ok(json!({"status": "up_to_date"})),
        }
    }

    pub fn dismiss_update(&self, input: Value) -> Result<Value> {
        let version = input.as_str().context("Missing update version")?;
        Version::parse(version)?;
        let _guard = self.update_lock.lock().unwrap();
        let path = self.directory.join("wolf-update.json");
        let mut state: UpdateState = if path.exists() {
            serde_json::from_slice(&fs::read(&path)?)?
        } else {
            UpdateState::default()
        };
        state.dismissed_version = Some(version.into());
        storage::atomic_json(&path, &state)?;
        Ok(Value::Null)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selects_newest_applicable_release_and_ignores_drafts_and_bad_tags() {
        let releases = json!([
            {"tag_name":"v0.4.7", "draft":false, "body":"First"},
            {"tag_name":"v9.0.0", "draft":true},
            {"tag_name":"invalid", "draft":false},
            {"tag_name":"v0.5.0-beta.1", "draft":false, "prerelease":true, "body":"<b>Plain text</b>"}
        ]);
        let (version, notes) = select_release(&releases, &Version::parse("0.4.6").unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(version.to_string(), "0.5.0-beta.1");
        assert_eq!(notes, "<b>Plain text</b>");
        assert!(select_release(&releases, &Version::parse("1.0.0").unwrap())
            .unwrap()
            .is_none());
        assert!(select_release(&json!({}), &version).is_err());
        assert!(select_release(
            &json!([{ "tag_name":"v0.4.6+other", "draft":false }]),
            &Version::parse("0.4.6").unwrap()
        )
        .unwrap()
        .is_none());
    }
    #[test]
    fn automatic_checks_are_throttled_but_clock_rollback_recovers() {
        let state = UpdateState {
            last_successful_check: Some(100),
            dismissed_version: None,
        };
        assert!(throttled(&state, 101));
        assert!(!throttled(&state, 86500));
        assert!(!throttled(&state, 99));
    }

    #[test]
    fn dismissed_version_survives_restart_and_preserves_check_time() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("wolf-update.json");
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        storage::atomic_json(
            &path,
            &UpdateState {
                last_successful_check: Some(now),
                dismissed_version: None,
            },
        )
        .unwrap();
        let runtime = Runtime::load(
            directory.path().into(),
            directory.path().to_string_lossy().into(),
        )
        .unwrap();
        runtime.dismiss_update(json!("0.5.0")).unwrap();
        drop(runtime);
        let state: UpdateState = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(state.dismissed_version.as_deref(), Some("0.5.0"));
        assert_eq!(state.last_successful_check, Some(now));
        let restarted = Runtime::load(
            directory.path().into(),
            directory.path().to_string_lossy().into(),
        )
        .unwrap();
        assert_eq!(
            restarted.check_updates(json!({"manual":false})).unwrap()["status"],
            "throttled"
        );
        assert!(restarted.dismiss_update(json!("invalid")).is_err());
        let saved: UpdateState = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(saved.dismissed_version.as_deref(), Some("0.5.0"));
    }
}
