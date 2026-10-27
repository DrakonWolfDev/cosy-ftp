use crate::{
    endpoint::Endpoint,
    model::*,
    state::{confirm, Runtime},
};
use anyhow::{bail, ensure, Result};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Instant,
};
use tauri::AppHandle;

impl Runtime {
    pub fn queue_command(
        self: &Arc<Self>,
        app: &AppHandle,
        operation: &str,
        input: Value,
    ) -> Result<Value> {
        match operation {
            "enqueue" | "retry-job" => {
                let request: JobRequest = if operation == "retry-job" {
                    let id = input
                        .as_str()
                        .ok_or_else(|| anyhow::anyhow!("Missing job identity"))?;
                    let jobs = self.jobs.lock().unwrap();
                    let previous = jobs
                        .iter()
                        .find(|j| j.id == id)
                        .ok_or_else(|| anyhow::anyhow!("Transfer no longer exists"))?;
                    ensure!(
                        ["failed", "cancelled"].contains(&previous.state.as_str()),
                        "Only failed or cancelled transfers can be retried"
                    );
                    previous.request.clone()
                } else {
                    serde_json::from_value(input)?
                };
                request.validate()?;
                self.session(&request.source.session_id)?;
                self.session(&request.destination.session_id)?;
                if request.overwrite && !confirm(app, "Replace existing destination files?", "Existing regular files with matching names can be replaced. Folder copies merge. Completed files remain if a later file fails.", "Copy and replace") { bail!("Copy cancelled") }
                let job = Job {
                    id: new_id(),
                    label: if request.names.len() == 1 {
                        request.names[0].clone()
                    } else {
                        format!("{} items", request.names.len())
                    },
                    request,
                    state: "queued".into(),
                    mode: "Waiting".into(),
                    bytes: 0,
                    total: None,
                    files: 0,
                    error: None,
                    started_at: None,
                    finished_at: None,
                };
                self.cancellations
                    .lock()
                    .unwrap()
                    .insert(job.id.clone(), Arc::new(AtomicBool::new(false)));
                self.jobs.lock().unwrap().push(job.clone());
                self.emit_jobs(app);
                self.start_worker(app.clone());
                Ok(json!(job))
            }
            "cancel-job" => {
                let id = input
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Missing job identity"))?;
                if let Some(cancel) = self.cancellations.lock().unwrap().get(id) {
                    cancel.store(true, Ordering::SeqCst);
                }
                if let Some(job) = self
                    .jobs
                    .lock()
                    .unwrap()
                    .iter_mut()
                    .find(|j| j.id == id && j.state == "queued")
                {
                    job.state = "cancelled".into();
                    job.finished_at = Some(now());
                }
                self.emit_jobs(app);
                Ok(Value::Null)
            }
            "clear-jobs" => {
                self.jobs
                    .lock()
                    .unwrap()
                    .retain(|j| ["queued", "running"].contains(&j.state.as_str()));
                let ids = self
                    .jobs
                    .lock()
                    .unwrap()
                    .iter()
                    .map(|j| j.id.clone())
                    .collect::<Vec<_>>();
                self.cancellations
                    .lock()
                    .unwrap()
                    .retain(|id, _| ids.contains(id));
                self.emit_jobs(app);
                Ok(Value::Null)
            }
            _ => bail!("Unknown transfer operation"),
        }
    }
    fn start_worker(self: &Arc<Self>, app: AppHandle) {
        if self.worker.swap(true, Ordering::SeqCst) {
            return;
        }
        let runtime = self.clone();
        std::thread::spawn(move || loop {
            let next = {
                let mut jobs = runtime.jobs.lock().unwrap();
                if let Some(job) = jobs.iter_mut().find(|j| j.state == "queued") {
                    job.state = "running".into();
                    job.started_at = Some(now());
                    Some(job.clone())
                } else {
                    runtime.worker.store(false, Ordering::SeqCst);
                    None
                }
            };
            let Some(mut job) = next else { break };
            runtime.emit_jobs(&app);
            let cancel = runtime
                .cancellations
                .lock()
                .unwrap()
                .get(&job.id)
                .cloned()
                .unwrap();
            let result = runtime.execute(&app, &mut job, &cancel);
            job.state = if cancel.load(Ordering::SeqCst) {
                "cancelled"
            } else if result.is_ok() {
                "completed"
            } else {
                "failed"
            }
            .into();
            job.error = result.err().map(|e| {
                format!(
                    "{e}{}",
                    if job.files > 0 {
                        format!(
                            " ({} completed files remain at the destination.)",
                            job.files
                        )
                    } else {
                        String::new()
                    }
                )
            });
            job.finished_at = Some(now());
            runtime.update_job(&app, &job);
        });
    }
    fn update_job(&self, app: &AppHandle, job: &Job) {
        if let Some(saved) = self
            .jobs
            .lock()
            .unwrap()
            .iter_mut()
            .find(|j| j.id == job.id)
        {
            *saved = job.clone();
        }
        self.emit_jobs(app);
    }
    fn execute(
        self: &Arc<Self>,
        app: &AppHandle,
        job: &mut Job,
        cancel: &AtomicBool,
    ) -> Result<()> {
        let (mut source, source_session) = self.endpoint(app, &job.request.source.session_id)?;
        check_cancel(cancel)?;
        let (mut target, target_session) =
            self.endpoint(app, &job.request.destination.session_id)?;
        let source_directory = source.canonical(&job.request.source.path)?;
        let target_directory = target.canonical(&job.request.destination.path)?;
        let same = source_session.profile.as_ref().map(|p| p.identity())
            == target_session.profile.as_ref().map(|p| p.identity());
        ensure!(!job.request.r#move || same, "Moves are supported only within the same server or local filesystem. Use Copy between servers.");
        job.mode = if job.request.r#move {
            "Moving"
        } else if source.remote() && target.remote() {
            "Transferring through this computer"
        } else if source.remote() {
            "Downloading"
        } else if target.remote() {
            "Uploading"
        } else {
            "Copying on this computer"
        }
        .into();
        let mut roots = Vec::new();
        for name in &job.request.names {
            check_cancel(cancel)?;
            let from = join(&source_directory, name, source.remote())?;
            let to = join(&target_directory, name, target.remote())?;
            let entry = source.stat(&from)?;
            ensure!(
                !same
                    || !(from == to
                        || (!source.remote() && cfg!(windows) && from.eq_ignore_ascii_case(&to))),
                "Source and destination are the same"
            );
            if same && entry.kind == "directory" {
                ensure!(
                    !nested(
                        &source.canonical(&from)?,
                        &target_directory,
                        source.remote()
                    ),
                    "Cannot copy or move a folder into itself"
                );
            }
            ensure!(
                !target.exists(&to)? || (job.request.overwrite && !job.request.r#move),
                "Destination already exists: {name}"
            );
            roots.push((from, to, entry));
        }
        if job.request.r#move {
            for (from, to, _) in roots {
                check_cancel(cancel)?;
                source.rename(&from, &to, false)?;
                job.files += 1;
                self.update_job(app, job);
            }
            return Ok(());
        }
        let mut plan = Plan::default();
        for (from, to, entry) in roots {
            walk(
                &mut source,
                &mut target,
                from,
                to,
                entry,
                job.request.overwrite,
                cancel,
                0,
                false,
                &mut plan,
            )?;
        }
        job.total = Some(plan.files.iter().map(|(_, _, e)| e.size).sum());
        self.update_job(app, job);
        for directory in plan.directories {
            check_cancel(cancel)?;
            if !target.exists(&directory)? {
                target.mkdir(&directory)?;
            }
        }
        let mut last_update = Instant::now();
        for (from, to, _) in plan.files {
            check_cancel(cancel)?;
            let result = copy_file(
                &mut source,
                &mut target,
                &from,
                &to,
                job.request.overwrite,
                cancel,
                |bytes| {
                    job.bytes += bytes;
                    if last_update.elapsed().as_millis() >= 100 {
                        self.update_job(app, job);
                        last_update = Instant::now();
                    }
                },
            );
            if let Err((error, stage)) = result {
                if let Ok((mut cleanup, _)) =
                    self.endpoint(app, &job.request.destination.session_id)
                {
                    if cleanup.exists(&stage).unwrap_or(true)
                        && cleanup.remove(&stage, false).is_err()
                    {
                        bail!("{error}. A temporary file may remain at {stage}")
                    }
                } else {
                    bail!("{error}. A temporary file may remain at {stage}")
                }
                return Err(error);
            }
            job.files += 1;
            self.update_job(app, job);
        }
        Ok(())
    }
}
fn check_cancel(cancel: &AtomicBool) -> Result<()> {
    ensure!(!cancel.load(Ordering::SeqCst), "Transfer cancelled");
    Ok(())
}
#[derive(Default)]
struct Plan {
    files: Vec<(String, String, Entry)>,
    directories: Vec<String>,
}
#[allow(clippy::too_many_arguments)]
fn walk(
    source: &mut Endpoint,
    target: &mut Endpoint,
    from: String,
    to: String,
    entry: Entry,
    overwrite: bool,
    cancel: &AtomicBool,
    depth: usize,
    parent_missing: bool,
    plan: &mut Plan,
) -> Result<()> {
    check_cancel(cancel)?;
    ensure!(
        depth <= 100 && plan.files.len() + plan.directories.len() < 100000,
        "Directory tree exceeds the safety limit (100 levels / 100,000 items)"
    );
    if entry.kind == "directory" {
        let missing = parent_missing || !target.exists(&to)?;
        ensure!(
            missing || target.stat(&to)?.kind == "directory",
            "A non-directory blocks the destination"
        );
        plan.directories.push(to.clone());
        for child in source.list(&from)? {
            walk(
                source,
                target,
                join(&from, &child.name, source.remote())?,
                join(&to, &child.name, target.remote())?,
                child,
                overwrite,
                cancel,
                depth + 1,
                missing,
                plan,
            )?;
        }
    } else {
        ensure!(
            entry.kind == "file",
            "Symbolic links and special files are not copied: {from}"
        );
        ensure!(
            parent_missing
                || !target.exists(&to)?
                || (overwrite && target.stat(&to)?.kind == "file"),
            "Destination exists or is not a regular file: {to}"
        );
        plan.files.push((from, to, entry));
    }
    Ok(())
}
pub fn copy_file(
    source: &mut Endpoint,
    target: &mut Endpoint,
    from: &str,
    to: &str,
    overwrite: bool,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64),
) -> std::result::Result<(), (anyhow::Error, String)> {
    let stage = match join(
        &parent(to, target.remote()),
        &format!(".cosy-{}.part", new_id()),
        target.remote(),
    ) {
        Ok(p) => p,
        Err(e) => return Err((e, String::new())),
    };
    let result = (|| {
        check_cancel(cancel)?;
        let original = source.stat(from)?;
        ensure!(original.kind == "file", "Only regular files can be copied");
        let mode = if target.exists(to)? {
            ensure!(overwrite, "Destination already exists");
            let previous = target.stat(to)?;
            ensure!(
                previous.kind == "file",
                "Links, folders and special files cannot be replaced"
            );
            previous.mode.or(original.mode)
        } else {
            original.mode
        };
        let mut reader = source.reader(from)?;
        let mut writer = target.writer(&stage)?;
        let mut buffer = [0u8; 128 * 1024];
        loop {
            check_cancel(cancel)?;
            let count = reader.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            writer.write_all(&buffer[..count])?;
            progress(count as u64);
        }
        writer.flush()?;
        writer.finish()?;
        reader.finish()?;
        check_cancel(cancel)?;
        ensure!(
            target.stat(&stage)?.size == original.size,
            "The staged copy is incomplete; destination was not replaced"
        );
        let after = source.stat(from)?;
        ensure!(
            after.kind == "file"
                && after.size == original.size
                && after.modified == original.modified,
            "Source changed while transferring; destination was not replaced"
        );
        target.mode(&stage, mode)?;
        check_cancel(cancel)?;
        target.rename(&stage, to, overwrite)?;
        Ok(())
    })();
    match result {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = target.remove(&stage, false);
            Err((e, stage))
        }
    }
}
