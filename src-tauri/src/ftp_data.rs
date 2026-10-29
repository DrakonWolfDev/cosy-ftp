//! Retry only socket establishment, before any FTP file data is sent.
use std::{
    io,
    net::{SocketAddr, TcpStream},
    time::Duration,
};

fn connect_with_retry<T>(
    mut connect: impl FnMut() -> io::Result<T>,
    mut pause: impl FnMut(Duration),
) -> io::Result<T> {
    for attempt in 0..3 {
        match connect() {
            // A fresh socket can recover from a transient Windows port/security block.
            Err(error) if error.raw_os_error() == Some(10013) && attempt < 2 => {
                pause(Duration::from_millis(250 * (attempt + 1)));
            }
            result => return result,
        }
    }
    unreachable!()
}

pub fn connect(address: SocketAddr) -> io::Result<TcpStream> {
    connect_with_retry(
        || TcpStream::connect_timeout(&address, Duration::from_secs(20)),
        std::thread::sleep,
    ).map_err(|error| {
        let guidance = if error.raw_os_error() == Some(10013) {
            " Windows denied the FTP data socket after 3 attempts. Check whether firewall/security software permits Cosy FTP and the server's passive FTP port range."
        } else {
            ""
        };
        io::Error::new(error.kind(), format!("Could not open FTP data connection to {address}: {error}.{guidance}"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovers_from_temporary_windows_socket_denial() {
        let mut calls = 0;
        let mut delays = Vec::new();
        let result = connect_with_retry(
            || {
                calls += 1;
                if calls < 3 {
                    Err(io::Error::from_raw_os_error(10013))
                } else {
                    Ok(42)
                }
            },
            |delay| delays.push(delay),
        );
        assert_eq!(result.unwrap(), 42);
        assert_eq!(calls, 3);
        assert_eq!(
            delays,
            vec![Duration::from_millis(250), Duration::from_millis(500)]
        );
    }

    #[test]
    fn persistent_denial_is_bounded() {
        let mut calls = 0;
        let result: io::Result<()> = connect_with_retry(
            || {
                calls += 1;
                Err(io::Error::from_raw_os_error(10013))
            },
            |_| {},
        );
        assert_eq!(calls, 3);
        assert_eq!(result.unwrap_err().raw_os_error(), Some(10013));
    }

    #[test]
    fn other_errors_are_not_retried() {
        let mut calls = 0;
        let result: io::Result<()> = connect_with_retry(
            || {
                calls += 1;
                Err(io::Error::new(io::ErrorKind::ConnectionRefused, "refused"))
            },
            |_| panic!("unexpected retry"),
        );
        assert_eq!(calls, 1);
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::ConnectionRefused);
    }
}
