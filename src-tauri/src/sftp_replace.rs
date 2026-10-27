//! The ssh2 crate exposes SFTP v3 rename, but not libssh2's POSIX rename API.
//! Use a separate authenticated SFTP channel for this single extension rather
//! than deleting originals, executing remote shell commands, or accessing FFI
//! through private crate layouts. All other SFTP operations remain in ssh2.
use anyhow::{ensure, Context, Result};
use std::{
    io::{Cursor, Read, Write},
    ops::Deref,
    path::Path,
};

pub struct SftpEndpoint {
    sftp: ssh2::Sftp,
    session: ssh2::Session,
}
impl Deref for SftpEndpoint {
    type Target = ssh2::Sftp;
    fn deref(&self) -> &Self::Target {
        &self.sftp
    }
}
impl SftpEndpoint {
    pub fn new(session: ssh2::Session) -> Result<Self> {
        Ok(Self {
            sftp: session.sftp()?,
            session,
        })
    }
    pub fn rename(&self, from: &Path, to: &Path, flags: Option<ssh2::RenameFlags>) -> Result<()> {
        let flags = flags.unwrap_or_else(ssh2::RenameFlags::empty);
        if flags.contains(ssh2::RenameFlags::OVERWRITE) && self.posix_rename(from, to)? {
            return Ok(());
        }
        self.sftp.rename(from, to, Some(flags))?;
        Ok(())
    }
    fn posix_rename(&self, from: &Path, to: &Path) -> Result<bool> {
        let mut channel = self.session.channel_session()?;
        channel.subsystem("sftp")?;
        write_packet(&mut channel, &[1, 0, 0, 0, 3])?; // SSH_FXP_INIT, version 3
        let version = read_packet(&mut channel)?;
        let mut reply = Cursor::new(version.as_slice());
        ensure!(
            read_byte(&mut reply)? == 2 && read_u32(&mut reply)? == 3,
            "Unsupported SFTP extension handshake"
        );
        let mut supported = false;
        while (reply.position() as usize) < version.len() {
            let name = read_string(&mut reply)?;
            let value = read_string(&mut reply)?;
            if name == b"posix-rename@openssh.com" && value == b"1" {
                supported = true;
            }
        }
        if !supported {
            return Ok(false);
        }
        let mut request = vec![200, 0, 0, 0, 1]; // SSH_FXP_EXTENDED, request ID 1
        write_string(&mut request, b"posix-rename@openssh.com")?;
        write_string(
            &mut request,
            from.to_str()
                .context("Remote path is not UTF-8")?
                .as_bytes(),
        )?;
        write_string(
            &mut request,
            to.to_str().context("Remote path is not UTF-8")?.as_bytes(),
        )?;
        write_packet(&mut channel, &request)?;
        let status = read_packet(&mut channel)?;
        let mut reply = Cursor::new(status.as_slice());
        ensure!(
            read_byte(&mut reply)? == 101 && read_u32(&mut reply)? == 1,
            "Invalid SFTP replacement response"
        );
        let code = read_u32(&mut reply)?;
        if code == 8 {
            return Ok(false);
        } // SSH_FX_OP_UNSUPPORTED: try ordinary rename.
        ensure!(
            code == 0,
            "Server refused atomic SFTP replacement (status {code}); original retained"
        );
        Ok(true)
    }
}
fn write_packet(stream: &mut impl Write, bytes: &[u8]) -> Result<()> {
    ensure!(
        bytes.len() <= 1024 * 1024,
        "SFTP packet exceeds safety limit"
    );
    stream.write_all(&(bytes.len() as u32).to_be_bytes())?;
    stream.write_all(bytes)?;
    stream.flush()?;
    Ok(())
}
fn read_packet(stream: &mut impl Read) -> Result<Vec<u8>> {
    let length = read_u32(stream)? as usize;
    ensure!(
        (1..=1024 * 1024).contains(&length),
        "Invalid SFTP packet size"
    );
    let mut bytes = vec![0; length];
    stream.read_exact(&mut bytes)?;
    Ok(bytes)
}
fn read_byte(stream: &mut impl Read) -> Result<u8> {
    let mut byte = [0];
    stream.read_exact(&mut byte)?;
    Ok(byte[0])
}
fn read_u32(stream: &mut impl Read) -> Result<u32> {
    let mut bytes = [0; 4];
    stream.read_exact(&mut bytes)?;
    Ok(u32::from_be_bytes(bytes))
}
fn read_string(stream: &mut Cursor<&[u8]>) -> Result<Vec<u8>> {
    let length = read_u32(stream)? as usize;
    ensure!(
        length
            <= stream
                .get_ref()
                .len()
                .saturating_sub(stream.position() as usize),
        "Truncated SFTP extension field"
    );
    let mut bytes = vec![0; length];
    stream.read_exact(&mut bytes)?;
    Ok(bytes)
}
fn write_string(stream: &mut impl Write, bytes: &[u8]) -> Result<()> {
    ensure!(
        bytes.len() <= 32768,
        "SFTP extension field exceeds safety limit"
    );
    stream.write_all(&(bytes.len() as u32).to_be_bytes())?;
    stream.write_all(bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unbounded_and_truncated_server_packets() {
        assert!(read_packet(&mut Cursor::new(u32::MAX.to_be_bytes())).is_err());
        assert!(read_packet(&mut Cursor::new([0, 0, 0, 8, 2])).is_err());
        assert!(read_string(&mut Cursor::new([0, 0, 0, 8, 2].as_slice())).is_err());
        let mut bytes = Vec::new();
        write_packet(&mut bytes, &[101, 0, 0, 0, 1, 0, 0, 0, 0]).unwrap();
        assert_eq!(
            read_packet(&mut Cursor::new(bytes)).unwrap(),
            [101, 0, 0, 0, 1, 0, 0, 0, 0]
        );
    }
}
