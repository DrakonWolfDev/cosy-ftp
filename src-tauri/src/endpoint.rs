use crate::ftps_transport::{CertificateConnector, NativeConnector, Stream};
use crate::ftps_trust::Verifier;
use crate::model::*;
use crate::sftp_replace::SftpEndpoint;
use anyhow::{anyhow, ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    net::{TcpStream, ToSocketAddrs},
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, UNIX_EPOCH},
};
use suppaftp::{native_tls::TlsConnector, ImplFtpStream};

pub enum Endpoint {
    Local,
    Sftp(SftpEndpoint),
    Ftp(FtpEndpoint),
}
pub struct FtpEndpoint {
    stream: ImplFtpStream<Stream>,
    phase: Arc<Mutex<String>>,
    stat_listing: bool,
}
impl std::ops::Deref for FtpEndpoint {
    type Target = ImplFtpStream<Stream>;
    fn deref(&self) -> &Self::Target {
        &self.stream
    }
}
impl std::ops::DerefMut for FtpEndpoint {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.stream
    }
}
const MAX_TREE_DEPTH: usize = 100;
const MAX_TREE_ITEMS: usize = 100_000;
pub trait FileStream: Read + Write + Send {
    fn finish(self: Box<Self>) -> Result<()>;
}
struct LocalFile {
    file: fs::File,
    writing: bool,
}
impl Read for LocalFile {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        self.file.read(buffer)
    }
}
impl Write for LocalFile {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.file.write(buffer)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.file.flush()
    }
}
impl FileStream for LocalFile {
    fn finish(self: Box<Self>) -> Result<()> {
        if self.writing {
            self.file.sync_all()?;
        }
        Ok(())
    }
}
impl FileStream for ssh2::File {
    fn finish(mut self: Box<Self>) -> Result<()> {
        self.close()?;
        Ok(())
    }
}
impl<T: suppaftp::TlsStream + Send + 'static> FileStream for suppaftp::TransferStream<T> {
    fn finish(self: Box<Self>) -> Result<()> {
        (*self).finish()?;
        Ok(())
    }
}
pub fn tcp(host: &str, port: u16) -> Result<TcpStream> {
    let addresses = (host, port)
        .to_socket_addrs()
        .context("Could not resolve server")?;
    let mut result = None;
    for address in addresses {
        if let Ok(stream) = TcpStream::connect_timeout(&address, Duration::from_secs(20)) {
            result = Some(stream);
            break;
        }
    }
    let stream = result.context("Could not connect to server within 20 seconds")?;
    stream.set_read_timeout(Some(Duration::from_secs(30)))?;
    stream.set_write_timeout(Some(Duration::from_secs(30)))?;
    Ok(stream)
}
impl Endpoint {
    pub fn connect(
        profile: &Profile,
        password: &str,
        verify: impl FnOnce(&str, &str) -> Result<bool>,
    ) -> Result<Self> {
        Self::connect_with_tls(profile, password, verify, TlsConnector::new()?)
    }
    pub(crate) fn connect_with_tls(
        profile: &Profile,
        password: &str,
        verify: impl FnOnce(&str, &str) -> Result<bool>,
        tls: TlsConnector,
    ) -> Result<Self> {
        Self::connect_internal(profile, password, verify, tls, None)
    }
    pub fn connect_with_ftps_trust(
        profile: &Profile,
        password: &str,
        verifier: Verifier,
    ) -> Result<Self> {
        ensure!(
            profile.protocol == "ftps",
            "Certificate trust applies only to FTPS"
        );
        Self::connect_internal(
            profile,
            password,
            |_, _| Ok(false),
            TlsConnector::new()?,
            Some(verifier),
        )
    }
    fn connect_internal(
        profile: &Profile,
        password: &str,
        verify: impl FnOnce(&str, &str) -> Result<bool>,
        tls: TlsConnector,
        ftps_verifier: Option<Verifier>,
    ) -> Result<Self> {
        profile.validate()?;
        let stream = tcp(&profile.host, profile.port)?;
        if profile.protocol == "sftp" {
            let mut session = ssh2::Session::new()?;
            session.set_tcp_stream(stream);
            session.set_timeout(30000);
            session.handshake().context("SSH handshake failed")?;
            let (key, _) = session
                .host_key()
                .context("Server did not provide an SSH host key")?;
            let fingerprint = format!("SHA256:{}", STANDARD_NO_PAD.encode(Sha256::digest(key)));
            ensure!(
                verify(&profile.host_key(), &fingerprint)?,
                "SSH host key was not trusted or has changed"
            );
            session
                .userauth_password(&profile.username, password)
                .map_err(|_| {
                    anyhow!("SSH authentication failed. Check the username and password.")
                })?;
            Ok(Self::Sftp(SftpEndpoint::new(session)?))
        } else {
            let mut ftp = ImplFtpStream::<Stream>::connect_with_stream(stream)
                .context("FTP greeting failed")?;
            if profile.protocol == "ftps" {
                let map_error = |error: suppaftp::FtpError| {
                    if let Some(reason) = crate::ftps_trust::decision_error(&error) {
                        return anyhow!(reason.to_owned());
                    }
                    anyhow!(crate::tls_errors::ftps_setup_error(&error, &profile.host))
                };
                ftp = if let Some(verifier) = ftps_verifier {
                    ftp.into_secure(CertificateConnector::new(profile, verifier)?, &profile.host)
                        .map_err(map_error)?
                } else {
                    ftp.into_secure(NativeConnector(tls), &profile.host)
                        .map_err(map_error)?
                };
            }
            ftp.login(profile.username.as_str(), password)
                .map_err(|_| {
                    anyhow!("FTP authentication failed. Check the username and password.")
                })?;
            ftp.transfer_type(suppaftp::types::FileType::Binary)?;
            let phase = Arc::new(Mutex::new(String::new()));
            let data_phase = phase.clone();
            ftp = ftp.passive_stream_builder(move |address| {
                *data_phase.lock().unwrap() = format!("opening data socket to {address}");
                let stream = crate::ftp_data::connect(address)
                    .map_err(suppaftp::FtpError::ConnectionError)?;
                *data_phase.lock().unwrap() = format!("setting read timeout on data socket to {address}");
                stream
                    .set_read_timeout(Some(Duration::from_secs(30)))
                    .map_err(suppaftp::FtpError::ConnectionError)?;
                *data_phase.lock().unwrap() = format!("setting write timeout on data socket to {address}");
                stream
                    .set_write_timeout(Some(Duration::from_secs(30)))
                    .map_err(suppaftp::FtpError::ConnectionError)?;
                *data_phase.lock().unwrap() = format!("data socket ready to {address}; sending transfer command / reading control reply");
                Ok(stream)
            });
            Ok(Self::Ftp(FtpEndpoint {
                stream: ftp,
                phase,
                stat_listing: true,
            }))
        }
    }
    pub fn remote(&self) -> bool {
        !matches!(self, Self::Local)
    }
    pub(crate) fn prepare_recovered_download(&mut self) {
        if let Self::Ftp(f) = self {
            // Recover with baseline LIST checks rather than re-probing STAT on
            // every replacement session. The reported recovery failed at this probe.
            f.stat_listing = false;
        }
    }
    pub fn canonical(&mut self, path: &str) -> Result<String> {
        safe_text(path, 32768)?;
        Ok(match self {
            Self::Local => dunce::canonicalize(path)?.to_string_lossy().into_owned(),
            Self::Sftp(s) => s.realpath(Path::new(path))?.to_string_lossy().into_owned(),
            Self::Ftp(f) => {
                f.cwd(path)?;
                f.pwd()?
            }
        })
    }
    pub fn list(&mut self, path: &str) -> Result<Vec<Entry>> {
        safe_text(path, 32768)?;
        match self {
            Self::Local => fs::read_dir(path)?
                .map(|item| {
                    let p = item?.path();
                    local_stat(&p)
                })
                .collect(),
            Self::Sftp(s) => s
                .readdir(Path::new(path))?
                .into_iter()
                .map(|(p, stat)| {
                    // ssh2 joins entries using the client's native PathBuf rules.
                    // Keep that native separator out of the remote POSIX path.
                    ensure!(
                        p.parent() == Some(Path::new(path)),
                        "Unsupported SFTP entry path"
                    );
                    let name = p
                        .file_name()
                        .and_then(|name| name.to_str())
                        .context("Filename is not valid UTF-8")?;
                    let text = join(path, name, true)?;
                    Ok(sftp_entry(text, stat))
                })
                .collect(),
            Self::Ftp(f) => {
                // LIST preserves link types, unlike servers that dereference MLSD links.
                f.list(Some(path))
                    .with_context(|| format!("FTP listing failed for {path}"))?
                    .into_iter()
                    .map(|line| {
                        let file: suppaftp::list::File =
                            line.parse().context("Unsupported FTP directory listing")?;
                        let name = file.name().to_owned();
                        if name == "." || name == ".." {
                            return Ok(None);
                        }
                        let entry = Entry {
                            path: join(path, &name, true)?,
                            name,
                            kind: if file.is_symlink() {
                                "link"
                            } else if file.is_directory() {
                                "directory"
                            } else if file.is_file() {
                                "file"
                            } else {
                                "other"
                            }
                            .into(),
                            size: file.size() as u64,
                            modified: file
                                .modified()
                                .duration_since(UNIX_EPOCH)
                                .ok()
                                .map(|t| t.as_millis() as u64),
                            mode: None,
                        };
                        Ok(Some(entry))
                    })
                    .filter_map(|r| r.transpose())
                    .collect()
            }
        }
    }
    pub fn stat(&mut self, path: &str) -> Result<Entry> {
        safe_text(path, 32768)?;
        // STAT returns LIST-style metadata over the existing control socket. Keep
        // fresh type/size/time checks without opening another data socket per check.
        // Use the parent so directory contents cannot be mistaken for the directory.
        if path != "/" {
            if let Self::Ftp(f) = self {
                if f.stat_listing {
                    let response = f.custom_command(
                        format!("STAT {}", parent(path, true)),
                        &[suppaftp::Status::Directory, suppaftp::Status::File],
                    );
                    let response = match response {
                        Ok(response) => Some(response),
                        // Do not include System in expected codes: the library treats
                        // 211- as a FEAT opener and otherwise leaves its body unread.
                        Err(suppaftp::FtpError::UnexpectedResponse(response))
                            if response.status == suppaftp::Status::System =>
                        {
                            Some(response)
                        }
                        Err(suppaftp::FtpError::UnexpectedResponse(response))
                            if response.status.code() != 421 =>
                        {
                            None
                        }
                        Err(error) => return Err(error.into()),
                    };
                    if let Some(response) = response {
                        if let Ok(body) = response.as_string() {
                            if let Some(entries) = stat_entries(&body, &parent(path, true)) {
                                return entries
                                    .into_iter()
                                    .find(|entry| entry.name == basename(path, true))
                                    .ok_or_else(|| {
                                        std::io::Error::from(std::io::ErrorKind::NotFound).into()
                                    });
                            }
                        }
                    }
                    // Older/unusual servers retain the existing LIST behaviour.
                    f.stat_listing = false;
                }
            }
        }
        match self {
            Self::Local => local_stat(Path::new(path)),
            Self::Sftp(s) => Ok(sftp_entry(path.to_owned(), s.lstat(Path::new(path))?)),
            Self::Ftp(_) if path == "/" => Ok(Entry {
                name: "/".into(),
                path: "/".into(),
                kind: "directory".into(),
                size: 0,
                modified: None,
                mode: None,
            }),
            Self::Ftp(_) => self
                .list(&parent(path, true))?
                .into_iter()
                .find(|e| e.name == basename(path, true))
                .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::NotFound).into()),
        }
    }
    pub fn exists(&mut self, path: &str) -> Result<bool> {
        match self.stat(path) {
            Ok(_) => Ok(true),
            Err(e)
                if e.downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound)
                    || e.downcast_ref::<ssh2::Error>()
                        .is_some_and(|e| e.code() == ssh2::ErrorCode::SFTP(2)) =>
            {
                Ok(false)
            }
            Err(e) => Err(e),
        }
    }
    pub fn mkdir(&mut self, path: &str) -> Result<()> {
        safe_text(path, 32768)?;
        match self {
            Self::Local => fs::create_dir(path)?,
            Self::Sftp(s) => s.mkdir(Path::new(path), 0o755)?,
            Self::Ftp(f) => {
                f.mkdir(path)?;
            }
        };
        Ok(())
    }
    pub fn remove(&mut self, path: &str, directory: bool) -> Result<()> {
        safe_text(path, 32768)?;
        match self {
            Self::Local => {
                if directory {
                    fs::remove_dir(path)?
                } else {
                    fs::remove_file(path)?
                }
            }
            Self::Sftp(s) => {
                if directory {
                    s.rmdir(Path::new(path))?
                } else {
                    s.unlink(Path::new(path))?
                }
            }
            Self::Ftp(f) => {
                if directory {
                    f.rmdir(path)?
                } else {
                    f.rm(path)?
                }
            }
        };
        Ok(())
    }
    pub fn plan_remove(
        &mut self,
        path: String,
        depth: usize,
        plan: &mut Vec<(String, bool)>,
    ) -> Result<()> {
        ensure!(
            depth <= MAX_TREE_DEPTH && plan.len() < MAX_TREE_ITEMS,
            "Directory tree exceeds the safety limit (100 levels / 100,000 items)"
        );
        let entry = self.stat(&path)?;
        if entry.kind == "directory" {
            for child in self.list(&path)? {
                self.plan_remove(join(&path, &child.name, self.remote())?, depth + 1, plan)?;
            }
            ensure!(
                plan.len() < MAX_TREE_ITEMS,
                "Directory tree exceeds the safety limit (100 levels / 100,000 items)"
            );
            plan.push((path, true));
        } else {
            // stat/list use lstat semantics, so links are removed rather than followed.
            plan.push((path, false));
        }
        Ok(())
    }
    pub fn remove_selected(&mut self, path: &str) -> Result<()> {
        let entry = self.stat(path)?;
        if matches!(self, Self::Local) && entry.kind == "directory" {
            // Rust's recursive removal does not traverse symbolic links or junctions.
            fs::remove_dir_all(path)?;
            Ok(())
        } else {
            #[cfg(windows)]
            if matches!(self, Self::Local) && entry.kind == "link" {
                use std::os::windows::fs::MetadataExt;
                if fs::symlink_metadata(path)?.file_attributes() & 0x10 != 0 {
                    fs::remove_dir(path)?;
                    return Ok(());
                }
            }
            self.remove(path, entry.kind == "directory")
        }
    }
    pub fn rename(&mut self, from: &str, to: &str, replace: bool) -> Result<()> {
        safe_text(from, 32768)?;
        safe_text(to, 32768)?;
        ensure!(replace || !self.exists(to)?, "Destination already exists");
        match self {
            Self::Local => {
                if !replace && self.stat(from)?.kind == "file" {
                    fs::hard_link(from, to)?;
                    fs::remove_file(from)?;
                } else if replace {
                    // NamedTempFile::persist uses MoveFileExW replacement on Windows.
                    let stage = tempfile::NamedTempFile::from_parts(
                        fs::File::open(from)?,
                        tempfile::TempPath::try_from_path(from)?,
                    );
                    stage.persist(to).map_err(|e| e.error)?;
                } else {
                    fs::rename(from, to)?;
                }
            }
            Self::Sftp(s) => s.rename(
                Path::new(from),
                Path::new(to),
                if replace {
                    Some(ssh2::RenameFlags::OVERWRITE | ssh2::RenameFlags::ATOMIC)
                } else {
                    Some(ssh2::RenameFlags::empty())
                },
            )?,
            Self::Ftp(f) => f.rename(from, to)?,
        };
        Ok(())
    }
    pub fn mode(&mut self, path: &str, mode: Option<u32>) -> Result<()> {
        if let Some(mode) = mode {
            match self {
                Self::Local => {
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        fs::set_permissions(path, fs::Permissions::from_mode(mode & 0o777))?;
                    }
                }
                Self::Sftp(s) => s.setstat(
                    Path::new(path),
                    ssh2::FileStat {
                        size: None,
                        uid: None,
                        gid: None,
                        perm: Some(mode & 0o777),
                        atime: None,
                        mtime: None,
                    },
                )?,
                Self::Ftp(_) => (),
            }
        };
        Ok(())
    }
    pub fn reader(&mut self, path: &str) -> Result<Box<dyn FileStream>> {
        safe_text(path, 32768)?;
        Ok(match self {
            Self::Local => Box::new(LocalFile {
                file: fs::File::open(path)?,
                writing: false,
            }),
            Self::Sftp(s) => Box::new(s.open(Path::new(path))?),
            Self::Ftp(f) => {
                *f.phase.lock().unwrap() =
                    "sending PASV / reading passive reply on control connection".into();
                let result = f.retr_as_stream(path);
                Box::new(result.with_context(|| {
                    format!(
                        "FTP download could not start for {path}; last step: {}",
                        f.phase.lock().unwrap()
                    )
                })?)
            }
        })
    }
    pub fn writer(&mut self, path: &str) -> Result<Box<dyn FileStream>> {
        safe_text(path, 32768)?;
        Ok(match self {
            Self::Local => {
                let mut options = OpenOptions::new();
                options.write(true).create_new(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                Box::new(LocalFile {
                    file: options.open(path)?,
                    writing: true,
                })
            }
            Self::Sftp(s) => Box::new(s.open_mode(
                Path::new(path),
                ssh2::OpenFlags::WRITE | ssh2::OpenFlags::CREATE | ssh2::OpenFlags::EXCLUSIVE,
                0o600,
                ssh2::OpenType::File,
            )?),
            Self::Ftp(f) => Box::new(f.put_with_stream(path)?),
        })
    }
    pub fn read_text(&mut self, path: &str) -> Result<(String, String, Option<u32>)> {
        let entry = self.stat(path)?;
        ensure!(
            entry.kind == "file",
            "Only regular UTF-8 text files can be edited"
        );
        ensure!(
            entry.size <= MAX_EDIT_BYTES as u64,
            "This file exceeds the editor's 10 MiB limit"
        );
        let mut bytes = Vec::new();
        let mut reader = self.reader(path)?;
        Read::by_ref(&mut reader)
            .take(MAX_EDIT_BYTES as u64 + 1)
            .read_to_end(&mut bytes)?;
        reader.finish()?;
        ensure!(
            bytes.len() <= MAX_EDIT_BYTES,
            "This file exceeds the editor's 10 MiB limit"
        );
        ensure!(
            !bytes.contains(&0),
            "This file contains NUL bytes and cannot be edited as plain text"
        );
        let revision = digest(&bytes);
        Ok((
            String::from_utf8(bytes).context("File is not valid UTF-8")?,
            revision,
            entry.mode,
        ))
    }
}
pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn stat_entries(body: &str, directory: &str) -> Option<Vec<Entry>> {
    let lines = body.lines().collect::<Vec<_>>();
    if lines.len() < 2 || lines[0].as_bytes().get(3) != Some(&b'-') {
        return None;
    }
    let mut entries = Vec::new();
    for line in &lines[1..lines.len() - 1] {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // The generic parser also accepts bare MLSX names, including status prose.
        // Accept only a full LIST record so prose never becomes file metadata.
        let file = suppaftp::list::ListParser::parse_posix(line)
            .or_else(|_| suppaftp::list::ListParser::parse_dos(line))
            .ok()?;
        let name = file.name();
        if name == "." || name == ".." {
            continue;
        }
        safe_name(name, true).ok()?;
        entries.push(Entry {
            path: join(directory, name, true).ok()?,
            name: name.to_owned(),
            kind: if file.is_symlink() {
                "link"
            } else if file.is_directory() {
                "directory"
            } else if file.is_file() {
                "file"
            } else {
                "other"
            }
            .into(),
            size: file.size() as u64,
            modified: file
                .modified()
                .duration_since(UNIX_EPOCH)
                .ok()
                .map(|t| t.as_millis() as u64),
            mode: None,
        });
    }
    Some(entries)
}

#[cfg(test)]
mod stat_tests {
    use super::*;
    #[test]
    fn control_listing_preserves_types_and_rejects_unparseable_metadata() {
        let body = "213-Status\r\n-rw-r--r-- 1 owner group 17 Oct 29 2026 a.json\r\nlrwxrwxrwx 1 owner group 6 Oct 29 2026 shortcut -> target\r\n213 End\r\n";
        let entries = stat_entries(body, "/data").unwrap();
        assert_eq!(entries[0].path, "/data/a.json");
        assert_eq!(entries[0].size, 17);
        assert_eq!(entries[1].kind, "link");
        assert!(stat_entries("213-Status\r\nunknown format\r\n213 End\r\n", "/data").is_none());
        assert!(stat_entries("213 Server status only\r\n", "/data").is_none());
    }
}

fn local_stat(path: &Path) -> Result<Entry> {
    let stat = fs::symlink_metadata(path)?;
    #[cfg(unix)]
    let mode = {
        use std::os::unix::fs::PermissionsExt;
        Some(stat.permissions().mode() & 0o777)
    };
    #[cfg(not(unix))]
    let mode = None;
    Ok(Entry {
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        path: path.to_string_lossy().into_owned(),
        kind: if stat.is_symlink() {
            "link"
        } else if stat.is_dir() {
            "directory"
        } else if stat.is_file() {
            "file"
        } else {
            "other"
        }
        .into(),
        size: stat.len(),
        modified: stat
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|t| t.as_millis() as u64),
        mode,
    })
}
fn sftp_entry(path: String, stat: ssh2::FileStat) -> Entry {
    Entry {
        name: basename(&path, true),
        path,
        kind: match stat.perm.unwrap_or(0) & 0o170000 {
            0o120000 => "link",
            0o040000 => "directory",
            0o100000 => "file",
            _ => "other",
        }
        .into(),
        size: stat.size.unwrap_or(0),
        modified: stat.mtime.map(|t| t * 1000),
        mode: stat.perm.map(|p| p & 0o777),
    }
}
