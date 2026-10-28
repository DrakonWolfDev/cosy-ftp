use crate::{
    endpoint::{digest, Endpoint},
    model::*,
    state::{validate_content, Runtime},
    storage::{atomic_json, Settings},
    transfers::copy_file,
};
use std::{
    fs,
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
};

#[test]
fn validates_profiles_and_names() {
    for name in [
        "",
        ".",
        "..",
        "../outside",
        "a/b",
        "a\\b",
        "line\rname",
        "null\0name",
    ] {
        assert!(safe_name(name, true).is_err(), "{name:?}");
    }
    assert!(safe_name("notes — final.txt", true).is_ok());
    assert!(validate_content("valid UTF-8 🦀").is_ok());
    assert!(validate_content("binary\0data").is_err());
    assert!(validate_content(&"x".repeat(MAX_EDIT_BYTES + 1)).is_err());
    let mut profile = profile("ftp", 21);
    profile.allow_insecure = false;
    assert!(profile.validate().is_err());
    profile.protocol = "ftps".into();
    assert!(profile.validate().is_ok());
    profile.host = "bad\nhost".into();
    assert!(profile.validate().is_err());
}
#[test]
fn recursive_delete_plans_children_first_and_does_not_follow_links() {
    let temp = tempfile::tempdir().unwrap();
    let tree = temp.path().join("tree");
    let outside = temp.path().join("outside.txt");
    fs::create_dir_all(tree.join("nested")).unwrap();
    fs::write(tree.join("nested/file.txt"), "inside").unwrap();
    fs::write(&outside, "outside").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, tree.join("link")).unwrap();

    let mut endpoint = Endpoint::Local;
    let mut plan = Vec::new();
    endpoint
        .plan_remove(tree.to_string_lossy().into_owned(), 0, &mut plan)
        .unwrap();
    assert_eq!(
        plan.last(),
        Some(&(tree.to_string_lossy().into_owned(), true))
    );
    for (path, directory) in plan {
        endpoint.remove(&path, directory).unwrap();
    }
    assert!(!tree.exists());
    assert_eq!(fs::read_to_string(outside).unwrap(), "outside");
}
#[test]
fn atomic_settings_roundtrip_and_corruption_preservation() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("connections.json");
    let mut settings = Settings::load(&path).unwrap();
    settings.profiles.push(profile("sftp", 22));
    settings
        .hosts
        .insert("localhost:22".into(), "SHA256:test".into());
    atomic_json(&path, &settings).unwrap();
    assert_eq!(Settings::load(&path).unwrap().profiles.len(), 1);
    fs::write(&path, "{broken").unwrap();
    assert!(Settings::load(&path).is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "{broken");
}
#[test]
fn local_copy_is_staged_and_never_clobbers_without_permission() {
    let temp = tempfile::tempdir().unwrap();
    let from = temp.path().join("source");
    let to = temp.path().join("target");
    fs::write(&from, vec![42u8; 1024 * 1024]).unwrap();
    fs::write(&to, "original").unwrap();
    let mut source = Endpoint::Local;
    let mut target = Endpoint::Local;
    let cancel = AtomicBool::new(false);
    assert!(copy_file(
        &mut source,
        &mut target,
        from.to_str().unwrap(),
        to.to_str().unwrap(),
        false,
        &cancel,
        |_| {}
    )
    .is_err());
    assert_eq!(fs::read_to_string(&to).unwrap(), "original");
    copy_file(
        &mut source,
        &mut target,
        from.to_str().unwrap(),
        to.to_str().unwrap(),
        true,
        &cancel,
        |_| {},
    )
    .unwrap();
    assert_eq!(fs::read(&from).unwrap(), fs::read(&to).unwrap());
    assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 2);
}
#[test]
fn cancellation_keeps_original_and_cleans_stage() {
    let temp = tempfile::tempdir().unwrap();
    let from = temp.path().join("source");
    let to = temp.path().join("target");
    fs::write(&from, vec![13u8; 2 * 1024 * 1024]).unwrap();
    fs::write(&to, "original").unwrap();
    let cancel = AtomicBool::new(false);
    assert!(copy_file(
        &mut Endpoint::Local,
        &mut Endpoint::Local,
        from.to_str().unwrap(),
        to.to_str().unwrap(),
        true,
        &cancel,
        |_| {
            cancel.store(true, Ordering::SeqCst);
        }
    )
    .is_err());
    assert_eq!(fs::read_to_string(to).unwrap(), "original");
    assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 2);
}
#[test]
fn changed_source_is_not_committed() {
    let temp = tempfile::tempdir().unwrap();
    let from = temp.path().join("source");
    let to = temp.path().join("target");
    fs::write(&from, vec![1u8; 4096]).unwrap();
    fs::write(&to, "original").unwrap();
    assert!(copy_file(
        &mut Endpoint::Local,
        &mut Endpoint::Local,
        from.to_str().unwrap(),
        to.to_str().unwrap(),
        true,
        &AtomicBool::new(false),
        |_| {
            fs::write(&from, "changed").unwrap();
        }
    )
    .is_err());
    assert_eq!(fs::read_to_string(to).unwrap(), "original");
}
#[cfg(unix)]
#[test]
fn links_are_not_copied_or_replaced() {
    let temp = tempfile::tempdir().unwrap();
    let original = temp.path().join("original");
    let link = temp.path().join("link");
    let target = temp.path().join("target");
    fs::write(&original, "original").unwrap();
    fs::write(&target, "target").unwrap();
    std::os::unix::fs::symlink(&original, &link).unwrap();
    let cancel = AtomicBool::new(false);
    assert!(copy_file(
        &mut Endpoint::Local,
        &mut Endpoint::Local,
        link.to_str().unwrap(),
        target.to_str().unwrap(),
        true,
        &cancel,
        |_| {}
    )
    .is_err());
    assert!(copy_file(
        &mut Endpoint::Local,
        &mut Endpoint::Local,
        target.to_str().unwrap(),
        link.to_str().unwrap(),
        true,
        &cancel,
        |_| {}
    )
    .is_err());
    assert_eq!(fs::read_to_string(original).unwrap(), "original");
}
#[test]
fn recovery_survives_restart_and_invalid_recovery_is_preserved() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = Runtime::load(temp.path().into(), "/".into()).unwrap();
    let id = new_id();
    let stored = StoredDocument {
        version: 1,
        baseline: digest(b"original"),
        identity: "local".into(),
        document: Document {
            id: id.clone(),
            name: "notes".into(),
            location: Location {
                session_id: "local".into(),
                path: "/notes".into(),
            },
            content: "draft".into(),
            dirty: true,
            status: "Saved locally".into(),
            updated_at: now(),
            profile_id: None,
        },
    };
    runtime.persist_document(&stored).unwrap();
    let restored = Runtime::load(temp.path().into(), "/".into()).unwrap();
    assert_eq!(restored.document(&id).unwrap().document.content, "draft");
    let path = temp.path().join("recovery").join(format!("{id}.json"));
    fs::write(&path, "broken").unwrap();
    assert!(Runtime::load(temp.path().into(), "/".into()).is_err());
    assert_eq!(fs::read_to_string(path).unwrap(), "broken");
}
#[test]
fn failed_settings_write_keeps_memory() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = Runtime::load(temp.path().into(), "/".into()).unwrap();
    fs::create_dir(temp.path().join("connections.json")).unwrap();
    assert!(runtime
        .mutate_settings(|s| {
            s.hosts
                .insert("host:22".into(), "SHA256:uncommitted".into());
            Ok(())
        })
        .is_err());
    assert!(runtime.data.lock().unwrap().settings.hosts.is_empty());
}

fn profile(protocol: &str, port: u16) -> Profile {
    Profile {
        id: new_id(),
        name: "Loopback fixture".into(),
        protocol: protocol.into(),
        host: "127.0.0.1".into(),
        port,
        username: "tester".into(),
        initial_path: "/".into(),
        has_password: false,
        allow_insecure: true,
    }
}
struct Server {
    child: Child,
    port: u16,
    _temp: tempfile::TempDir,
    root: std::path::PathBuf,
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn server(script: &str, tls: bool) -> Server {
    server_mode(script, tls, None)
}
fn server_mode(script: &str, tls: bool, resumption: Option<&str>) -> Server {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("root");
    fs::create_dir(&root).unwrap();
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../tests/fixtures")
        .join(script);
    let mut command = Command::new(std::env::var("COSY_PYTHON").unwrap_or("python3".into()));
    command.arg(fixture).arg(&root);
    if tls {
        command.arg("tls");
    }
    if let Some(version) = resumption {
        command.arg(version);
    }
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let value: serde_json::Value =
        serde_json::from_str(&line).expect("Python fixture failed; install tests/requirements.txt");
    Server {
        child,
        port: value["port"].as_u64().unwrap() as u16,
        _temp: temp,
        root,
    }
}
#[test]
#[ignore = "requires Python loopback protocol fixtures"]
fn real_sftp_trust_auth_transfer_and_remote_relay() {
    let server = server("paramiko-server.py", false);
    let p = profile("sftp", server.port);
    assert!(Endpoint::connect(&p, "test-password", |_, _| Ok(false)).is_err());
    assert!(Endpoint::connect(&p, "wrong-password", |_, _| Ok(true)).is_err());
    let mut source = Endpoint::connect(&p, "test-password", |host, fingerprint| {
        assert_eq!(host, p.host_key());
        assert!(fingerprint.starts_with("SHA256:"));
        Ok(true)
    })
    .unwrap();
    let payload = vec![31u8; 2 * 1024 * 1024];
    fs::write(server.root.join("original.bin"), &payload).unwrap();
    let mut target = Endpoint::connect(&p, "test-password", |_, _| Ok(true)).unwrap();
    fs::create_dir_all(server.root.join("nested/deeper")).unwrap();
    fs::write(
        server.root.join("nested/deeper/settings.json"),
        "{\"enabled\":true}\n",
    )
    .unwrap();
    let nested = source.list("/nested/deeper").unwrap();
    assert_eq!(nested.len(), 1);
    assert_eq!(nested[0].name, "settings.json");
    assert_eq!(nested[0].path, "/nested/deeper/settings.json");
    assert_eq!(
        source.read_text(&nested[0].path).unwrap().0,
        "{\"enabled\":true}\n"
    );
    copy_file(
        &mut source,
        &mut target,
        "/original.bin",
        "/relay.bin",
        false,
        &AtomicBool::new(false),
        |_| {},
    )
    .unwrap();
    assert_eq!(fs::read(server.root.join("relay.bin")).unwrap(), payload);
    assert!(source
        .list("/")
        .unwrap()
        .iter()
        .any(|e| e.name == "relay.bin"));
    target.rename("/relay.bin", "/renamed.bin", false).unwrap();
    target.remove("/renamed.bin", false).unwrap();
    assert!(!target.exists("/renamed.bin").unwrap());
}
#[test]
#[ignore = "requires Python loopback protocol fixtures"]
fn real_ftp_binary_upload_download_and_cancel() {
    let server = server("ftp-server.py", false);
    let p = profile("ftp", server.port);
    let temp = tempfile::tempdir().unwrap();
    let original = temp.path().join("source.bin");
    let downloaded = temp.path().join("download.bin");
    let payload = (0..1024 * 1024)
        .map(|n| (n % 251) as u8)
        .collect::<Vec<_>>();
    fs::write(&original, &payload).unwrap();
    let mut ftp = Endpoint::connect(&p, "test-password", |_, _| unreachable!()).unwrap();
    copy_file(
        &mut Endpoint::Local,
        &mut ftp,
        original.to_str().unwrap(),
        "/upload.bin",
        false,
        &AtomicBool::new(false),
        |_| {},
    )
    .unwrap();
    copy_file(
        &mut ftp,
        &mut Endpoint::Local,
        "/upload.bin",
        downloaded.to_str().unwrap(),
        false,
        &AtomicBool::new(false),
        |_| {},
    )
    .unwrap();
    assert_eq!(fs::read(downloaded).unwrap(), payload);
    let cancel = AtomicBool::new(false);
    fs::write(server.root.join("keep.bin"), "original").unwrap();
    assert!(copy_file(
        &mut Endpoint::Local,
        &mut ftp,
        original.to_str().unwrap(),
        "/keep.bin",
        true,
        &cancel,
        |_| cancel.store(true, Ordering::SeqCst)
    )
    .is_err());
    assert_eq!(
        fs::read_to_string(server.root.join("keep.bin")).unwrap(),
        "original"
    );
}
#[test]
#[ignore = "requires Python loopback protocol fixtures"]
fn ftps_rejects_untrusted_certificate_before_authentication() {
    let server = server("ftp-server.py", true);
    let p = profile("ftps", server.port);
    let result = Endpoint::connect(&p, "test-password", |_, _| unreachable!());
    assert!(result
        .err()
        .unwrap()
        .to_string()
        .contains("TLS validation failed"));
}

#[test]
#[ignore = "requires Python loopback protocol fixtures"]
fn trusted_ftps_transfer_and_wrong_hostname_refusal() {
    use suppaftp::native_tls::{Certificate, TlsConnector};
    let server = server("ftp-server.py", true);
    let certificate = Certificate::from_pem(
        &fs::read(server.root.parent().unwrap().join("test-certificate.pem")).unwrap(),
    )
    .unwrap();
    let tls = TlsConnector::builder()
        .add_root_certificate(certificate)
        .build()
        .unwrap();
    let mut p = profile("ftps", server.port);
    let mismatch =
        Endpoint::connect_with_tls(&p, "test-password", |_, _| unreachable!(), tls.clone())
            .err()
            .unwrap()
            .to_string();
    assert!(mismatch.contains("does not match"), "{mismatch}");
    assert!(
        mismatch.contains("IP subject alternative name"),
        "{mismatch}"
    );
    p.host = "localhost".into();
    let mut endpoint =
        Endpoint::connect_with_tls(&p, "test-password", |_, _| unreachable!(), tls).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source.txt");
    fs::write(&source, "encrypted transfer\n").unwrap();
    copy_file(
        &mut Endpoint::Local,
        &mut endpoint,
        source.to_str().unwrap(),
        "/secure.txt",
        false,
        &AtomicBool::new(false),
        |_| {},
    )
    .unwrap();
    assert_eq!(
        endpoint.read_text("/secure.txt").unwrap().0,
        "encrypted transfer\n"
    );
}

#[test]
#[ignore = "requires Python loopback protocol fixtures"]
fn mixed_ftp_sftp_relay() {
    let ftp_server = server("ftp-server.py", false);
    let sftp_server = server("paramiko-server.py", false);
    let payload = vec![213u8; 2 * 1024 * 1024];
    fs::write(ftp_server.root.join("source.bin"), &payload).unwrap();
    let mut source = Endpoint::connect(
        &profile("ftp", ftp_server.port),
        "test-password",
        |_, _| unreachable!(),
    )
    .unwrap();
    let mut target = Endpoint::connect(
        &profile("sftp", sftp_server.port),
        "test-password",
        |_, _| Ok(true),
    )
    .unwrap();
    copy_file(
        &mut source,
        &mut target,
        "/source.bin",
        "/relay.bin",
        false,
        &AtomicBool::new(false),
        |_| {},
    )
    .unwrap();
    assert_eq!(
        fs::read(sftp_server.root.join("relay.bin")).unwrap(),
        payload
    );
}

#[test]
fn electron_import_preserves_originals_and_drops_legacy_secrets() {
    let temp = tempfile::tempdir().unwrap();
    let legacy = temp.path().join("legacy");
    let destination = temp.path().join("tauri");
    fs::create_dir_all(legacy.join("recovery")).unwrap();
    let mut saved = serde_json::to_value(profile("sftp", 22)).unwrap();
    saved["secret"] = serde_json::json!("electron-encrypted-value");
    saved["hasPassword"] = serde_json::json!(true);
    let original = serde_json::json!({"version": 1, "profiles": [saved], "hosts": {"127.0.0.1:22": "SHA256:keep"}});
    atomic_json(&legacy.join("connections.json"), &original).unwrap();
    crate::state::import_electron_from(&destination, &legacy).unwrap();
    let imported = Settings::load(&destination.join("connections.json")).unwrap();
    assert_eq!(imported.profiles.len(), 1);
    assert!(!imported.profiles[0].has_password);
    assert_eq!(imported.hosts["127.0.0.1:22"], "SHA256:keep");
    assert!(!fs::read_to_string(destination.join("connections.json"))
        .unwrap()
        .contains("electron-encrypted-value"));
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(
            &fs::read(legacy.join("connections.json")).unwrap()
        )
        .unwrap(),
        original
    );
    fs::write(legacy.join("connections.json"), "broken after import").unwrap();
    crate::state::import_electron_from(&destination, &legacy).unwrap();
    assert_eq!(
        Settings::load(&destination.join("connections.json"))
            .unwrap()
            .profiles
            .len(),
        1
    );
}

#[test]
#[ignore = "requires Python loopback protocol fixtures"]
fn explicit_ftps_certificate_trust_is_required_before_login_and_protects_data() {
    use std::sync::{atomic::AtomicUsize, Arc};
    let server = server("ftp-server.py", true);
    let p = profile("ftps", server.port);
    let denied = Endpoint::connect_with_ftps_trust(
        &p,
        "test-password",
        Arc::new(|info| {
            assert!(!info.name_matches);
            assert!(info.validation_problem.is_some());
            Ok(false)
        }),
    );
    assert!(denied
        .err()
        .unwrap()
        .to_string()
        .contains("No login credentials were sent"));
    assert!(!server
        .root
        .parent()
        .unwrap()
        .join("login-events.txt")
        .exists());
    let count = Arc::new(AtomicUsize::new(0));
    let decisions = count.clone();
    let mut ftp = Endpoint::connect_with_ftps_trust(
        &p,
        "test-password",
        Arc::new(move |info| {
            assert_eq!(info.host, format!("127.0.0.1:{}", p.port));
            assert!(!info.name_matches);
            assert!(info.names.iter().any(|name| name.contains("localhost")));
            decisions.fetch_add(1, Ordering::SeqCst);
            Ok(true)
        }),
    )
    .unwrap();
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source.bin");
    let copy = temp.path().join("copy.bin");
    let bytes = vec![53u8; 1024 * 1024];
    fs::write(&source, &bytes).unwrap();
    copy_file(
        &mut Endpoint::Local,
        &mut ftp,
        source.to_str().unwrap(),
        "/secure.bin",
        false,
        &AtomicBool::new(false),
        |_| {},
    )
    .unwrap();
    copy_file(
        &mut ftp,
        &mut Endpoint::Local,
        "/secure.bin",
        copy.to_str().unwrap(),
        false,
        &AtomicBool::new(false),
        |_| {},
    )
    .unwrap();
    assert_eq!(fs::read(copy).unwrap(), bytes);
    assert_eq!(
        count.load(Ordering::SeqCst),
        1,
        "Data sockets must use the accepted control fingerprint, without new trust decisions"
    );
}

#[test]
fn ftps_trust_is_scoped_persisted_and_replacements_require_review() {
    use crate::ftps_trust::CertificateInfo;
    let temp = tempfile::tempdir().unwrap();
    let runtime = Runtime::load(temp.path().into(), "/".into()).unwrap();
    let first = (0..32).map(|_| "AA").collect::<Vec<_>>().join(":");
    let next = (0..32).map(|_| "BB").collect::<Vec<_>>().join(":");
    let info = CertificateInfo {
        host: "127.0.0.1:21".into(),
        address: "127.0.0.1".into(),
        fingerprint: first.clone(),
        subject: "localhost".into(),
        issuer: "localhost".into(),
        names: vec!["DNS: localhost".into()],
        not_before: "now".into(),
        not_after: "later".into(),
        name_matches: false,
        validation_problem: Some("self-signed".into()),
    };
    assert!(!runtime
        .verify_ftps_with(&info, |previous| {
            assert!(previous.is_none());
            false
        })
        .unwrap());
    assert!(runtime.data.lock().unwrap().settings.ftps_hosts.is_empty());
    assert!(runtime.verify_ftps_with(&info, |_| true).unwrap());
    assert!(runtime
        .verify_ftps_with(&info, |_| panic!(
            "Known exact certificate should not prompt"
        ))
        .unwrap());
    assert_eq!(
        Settings::load(&temp.path().join("connections.json"))
            .unwrap()
            .ftps_hosts[&info.host],
        first
    );
    assert!(
        runtime.data.lock().unwrap().settings.hosts.is_empty(),
        "FTPS trust must not become SSH trust"
    );
    let mut changed = info.clone();
    changed.fingerprint = next.clone();
    changed.validation_problem = None;
    assert!(!runtime
        .verify_ftps_with(&changed, |previous| {
            assert_eq!(previous, Some(first.as_str()));
            false
        })
        .unwrap());
    assert_eq!(
        runtime.data.lock().unwrap().settings.ftps_hosts[&info.host],
        first
    );
    assert!(runtime.verify_ftps_with(&changed, |_| true).unwrap());
    assert_eq!(
        runtime.data.lock().unwrap().settings.ftps_hosts[&info.host],
        next
    );
    let mut other_port = info.clone();
    other_port.host = "127.0.0.1:2121".into();
    assert!(!runtime
        .verify_ftps_with(&other_port, |previous| {
            assert!(previous.is_none());
            false
        })
        .unwrap());
    fs::remove_file(temp.path().join("connections.json")).unwrap();
    fs::create_dir(temp.path().join("connections.json")).unwrap();
    assert!(runtime.verify_ftps_with(&info, |_| true).is_err());
    assert_eq!(
        runtime.data.lock().unwrap().settings.ftps_hosts[&info.host],
        next,
        "Failed trust writes must preserve the previous pin"
    );
}

#[test]
#[ignore = "requires Python loopback protocol fixtures"]
fn ftps_tls12_data_connections_resume_the_control_session() {
    ftps_requires_resumption("12");
}
#[test]
#[ignore = "requires Python loopback protocol fixtures"]
fn ftps_tls13_data_connections_resume_the_control_session() {
    ftps_requires_resumption("13");
}
fn ftps_requires_resumption(version: &str) {
    use std::sync::Arc;
    let server = server_mode("ftp-server.py", true, Some(version));
    let p = profile("ftps", server.port);
    // Demonstrate that the fixture rejects the previous non-resuming backend.
    let cert = fs::read(server.root.parent().unwrap().join("test-certificate.pem")).unwrap();
    let mut tls = suppaftp::native_tls::TlsConnector::builder();
    tls.add_root_certificate(suppaftp::native_tls::Certificate::from_pem(&cert).unwrap());
    let mut named = p.clone();
    named.host = "localhost".into();
    let mut legacy = Endpoint::connect_with_tls(
        &named,
        "test-password",
        |_, _| Ok(true),
        tls.build().unwrap(),
    )
    .unwrap();
    assert!(
        legacy.list("/").is_err(),
        "Fixture must reject a fresh data TLS session"
    );
    let mut ftp =
        Endpoint::connect_with_ftps_trust(&p, "test-password", Arc::new(|_| Ok(true))).unwrap();
    let local = tempfile::tempdir().unwrap();
    let payload = vec![27u8; 1024 * 1024];
    fs::write(local.path().join("upload.bin"), &payload).unwrap();
    for i in 0..3 {
        assert!(ftp.list("/").is_ok());
        let remote = format!("/upload{i}.bin");
        copy_file(
            &mut Endpoint::Local,
            &mut ftp,
            local.path().join("upload.bin").to_str().unwrap(),
            &remote,
            false,
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
        let downloaded = local.path().join(format!("download{i}.bin"));
        copy_file(
            &mut ftp,
            &mut Endpoint::Local,
            &remote,
            downloaded.to_str().unwrap(),
            false,
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
        assert_eq!(fs::read(downloaded).unwrap(), payload);
    }
    let events =
        fs::read_to_string(server.root.parent().unwrap().join("resumption-events.txt")).unwrap();
    assert!(events.lines().any(|line| line == "fresh"));
    assert!(
        events.lines().filter(|line| *line == "resumed").count() >= 9,
        "{events}"
    );
}

#[test]
fn editor_accepts_large_json_and_rejects_files_beyond_its_limit() {
    let temp = tempfile::tempdir().unwrap();
    let file = temp.path().join("config.json");
    let text = serde_json::to_string(
        &serde_json::json!({"payload": "x".repeat(3 * 1024 * 1024), "enabled": true}),
    )
    .unwrap();
    fs::write(&file, &text).unwrap();
    let (loaded, _, _) = Endpoint::Local.read_text(file.to_str().unwrap()).unwrap();
    assert_eq!(loaded, text);
    assert!(validate_content(&loaded).is_ok());
    let at_limit = "x".repeat(MAX_EDIT_BYTES);
    fs::write(&file, &at_limit).unwrap();
    assert!(Endpoint::Local.read_text(file.to_str().unwrap()).is_ok());
    assert!(validate_content(&at_limit).is_ok());
    fs::write(&file, "x".repeat(MAX_EDIT_BYTES + 1)).unwrap();
    assert!(Endpoint::Local
        .read_text(file.to_str().unwrap())
        .unwrap_err()
        .to_string()
        .contains("10 MiB"));
}
