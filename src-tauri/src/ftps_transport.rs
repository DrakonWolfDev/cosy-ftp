//! A per-control-connection OpenSSL context resumes TLS sessions on protected data sockets.
//! Platform certificate verification and explicit exact-leaf trust remain separate from resumption.
use crate::{
    ftps_trust::{inspect, CertificateInfo, Verifier},
    model::Profile,
};
use anyhow::{ensure, Result};
use openssl::ssl::{
    Ssl, SslConnector, SslMethod, SslSession, SslSessionCacheMode, SslStream, SslVerifyMode,
    SslVersion,
};
use rustls::{
    client::danger::ServerCertVerifier,
    pki_types::{CertificateDer, ServerName, UnixTime},
    Error,
};
use std::{
    fmt,
    io::{self, Read, Write},
    net::TcpStream,
    sync::{Arc, Mutex},
};
use suppaftp::{FtpError, NativeTlsConnector, TlsConnector, TlsStream};
use zeroize::Zeroizing;
type NativeStream = <NativeTlsConnector as TlsConnector>::Stream;

#[derive(Debug)]
pub enum Stream {
    Native(NativeStream),
    OpenSsl(Box<OpenSslWire>),
}
#[derive(Debug)]
pub struct OpenSslWire(SslStream<TcpStream>);
impl Drop for OpenSslWire {
    fn drop(&mut self) {
        let _ = self.0.shutdown();
    }
}
impl Read for Stream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self {
            Self::Native(s) => s.mut_ref().read(buf),
            Self::OpenSsl(s) => s.0.read(buf),
        }
    }
}
impl Write for Stream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self {
            Self::Native(s) => s.mut_ref().write(buf),
            Self::OpenSsl(s) => s.0.write(buf),
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        match self {
            Self::Native(s) => s.mut_ref().flush(),
            Self::OpenSsl(s) => s.0.flush(),
        }
    }
}
impl TlsStream for Stream {
    type InnerStream = Self;
    fn tcp_stream(self) -> suppaftp::FtpResult<TcpStream> {
        match self {
            Self::Native(s) => s.tcp_stream(),
            Self::OpenSsl(s) => s.0.get_ref().try_clone().map_err(FtpError::ConnectionError),
        }
    }
    fn get_ref(&self) -> &TcpStream {
        match self {
            Self::Native(s) => s.get_ref(),
            Self::OpenSsl(s) => s.0.get_ref(),
        }
    }
    fn mut_ref(&mut self) -> &mut Self {
        self
    }
}
#[derive(Debug)]
pub struct NativeConnector(pub suppaftp::native_tls::TlsConnector);
impl TlsConnector for NativeConnector {
    type Stream = Stream;
    fn connect(&self, domain: &str, socket: TcpStream) -> suppaftp::FtpResult<Stream> {
        NativeTlsConnector::from(self.0.clone())
            .connect(domain, socket)
            .map(Stream::Native)
    }
}
struct CertificateVerifier {
    platform: rustls_platform_verifier::Verifier,
    profile: Profile,
}
impl fmt::Debug for CertificateVerifier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("FTPS certificate verifier")
    }
}
impl CertificateVerifier {
    fn inspect(
        &self,
        certs: &[CertificateDer<'_>],
        name: &ServerName<'_>,
    ) -> Result<CertificateInfo> {
        let leaf = certs
            .first()
            .ok_or_else(|| anyhow::anyhow!("FTPS server did not provide a certificate"))?;
        let problem = match self.platform.verify_server_cert(leaf, &certs[1..], name, &[], UnixTime::now()) {
            Ok(_) => None,
            Err(error) if permits_exception(&error) => Some("The certificate is not trusted by this computer or does not match the server address.".into()),
            Err(error) => return Err(anyhow::anyhow!("FTPS certificate validation failed: {error}")),
        };
        inspect(leaf.as_ref(), &self.profile, problem)
    }
}
fn permits_exception(error: &Error) -> bool {
    matches!(
        error,
        Error::InvalidCertificate(
            rustls::CertificateError::UnknownIssuer
                | rustls::CertificateError::NotValidForName
                | rustls::CertificateError::NotValidForNameContext { .. }
        )
    )
}
pub struct CertificateConnector {
    tls: SslConnector,
    session: Arc<Mutex<Option<Zeroizing<Vec<u8>>>>>,
    control_marker: openssl::ex_data::Index<Ssl, bool>,
    certificate_verifier: Arc<CertificateVerifier>,
    approve: Verifier,
    control: Mutex<Option<(String, bool)>>,
}
impl fmt::Debug for CertificateConnector {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Resumable FTPS connector")
    }
}
impl CertificateConnector {
    pub fn new(profile: &Profile, approve: Verifier) -> Result<Self> {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let certificate_verifier = Arc::new(CertificateVerifier {
            platform: rustls_platform_verifier::Verifier::new(provider.clone())?,
            profile: profile.clone(),
        });
        let session = Arc::new(Mutex::new(None));
        let saved_session = session.clone();
        let control_marker = Ssl::new_ex_index::<bool>()?;
        let mut tls = SslConnector::builder(SslMethod::tls_client())?;
        tls.set_min_proto_version(Some(SslVersion::TLS1_2))?;
        // The authenticated TLS handshake proves possession of the key. Platform validation
        // and explicit pin approval below must succeed before any FTP credentials/data.
        tls.set_verify(SslVerifyMode::NONE);
        tls.set_session_cache_mode(
            SslSessionCacheMode::CLIENT | SslSessionCacheMode::NO_INTERNAL_STORE,
        );
        tls.set_new_session_callback(move |ssl, value| {
            if ssl.ex_data(control_marker) != Some(&true) {
                return;
            }
            // Preserve a serialized ticket: OpenSSL marks a shared SSL_SESSION object
            // non-resumable after use/close. Each data socket needs its own instance.
            if let Ok(ticket) = value.to_der() {
                *saved_session.lock().unwrap() = Some(Zeroizing::new(ticket));
            }
        });
        Ok(Self {
            tls: tls.build(),
            session,
            control_marker,
            certificate_verifier,
            approve,
            control: Mutex::new(None),
        })
    }

    pub(crate) fn check_peer(&self, info: &CertificateInfo) -> Result<()> {
        let mut control = self.control.lock().unwrap();
        if let Some((fingerprint, exception)) = &*control {
            ensure!(
                (!exception && info.validation_problem.is_none())
                    || fingerprint == &info.fingerprint,
                "The FTPS data connection presented a different certificate. No data was sent."
            );
        } else {
            ensure!(
                (self.approve)(info)?,
                "FTPS certificate was not trusted. No login credentials were sent."
            );
            *control = Some((info.fingerprint.clone(), info.validation_problem.is_some()));
        }
        Ok(())
    }
}
impl TlsConnector for CertificateConnector {
    type Stream = Stream;
    fn connect(&self, domain: &str, socket: TcpStream) -> suppaftp::FtpResult<Stream> {
        let establish = || -> Result<Stream> {
            let name = ServerName::try_from(domain.to_owned())?;
            let mut configuration = self.tls.configure()?;
            configuration.set_verify_hostname(false);
            let mut ssl = configuration.into_ssl(domain)?;
            ssl.set_ex_data(self.control_marker, self.control.lock().unwrap().is_none());
            if let Some(session) = self.session.lock().unwrap().as_ref() {
                let session = SslSession::from_der(session.as_slice())?;
                // SAFETY: this session came from this connector's own SSL context. Both
                // context and cache belong exclusively to one host/port/control connection.
                unsafe {
                    ssl.set_session(&session)?;
                }
            }
            let mut stream = SslStream::new(ssl, socket)?;
            stream.connect()?;
            let leaf = stream
                .ssl()
                .peer_certificate()
                .ok_or_else(|| anyhow::anyhow!("FTPS server did not provide a certificate"))?;
            let mut certs = vec![CertificateDer::from(leaf.to_der()?)];
            if let Some(chain) = stream.ssl().peer_cert_chain() {
                for certificate in chain {
                    let der = certificate.to_der()?;
                    if der != certs[0].as_ref() {
                        certs.push(CertificateDer::from(der));
                    }
                }
            }
            let info = self.certificate_verifier.inspect(&certs, &name)?;
            self.check_peer(&info)?;
            Ok(Stream::OpenSsl(Box::new(OpenSslWire(stream))))
        };
        establish().map_err(|error| {
            FtpError::SecureError(format!("Cosy FTP certificate decision: {error}"))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_certificate_trust_and_name_errors_allow_explicit_approval() {
        use rustls::CertificateError;
        assert!(permits_exception(&Error::InvalidCertificate(
            CertificateError::UnknownIssuer
        )));
        assert!(permits_exception(&Error::InvalidCertificate(
            CertificateError::NotValidForName
        )));
        for error in [
            CertificateError::Expired,
            CertificateError::NotValidYet,
            CertificateError::Revoked,
            CertificateError::BadSignature,
            CertificateError::BadEncoding,
        ] {
            assert!(!permits_exception(&Error::InvalidCertificate(error)));
        }
        assert!(!permits_exception(&Error::General(
            "unknown failure".into()
        )));
    }
}
