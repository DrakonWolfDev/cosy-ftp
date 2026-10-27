//! A certificate exception is scoped to a host/port and exact leaf fingerprint.
//! No FTP credentials or data are sent until the control certificate is accepted.
use crate::model::Profile;
use anyhow::{ensure, Context, Result};
use openssl::stack::Stack;
use openssl::x509::{
    store::X509StoreBuilder,
    verify::{X509VerifyFlags, X509VerifyParam},
    X509PurposeId, X509StoreContext, X509,
};
use sha2::{Digest, Sha256};
use std::{net::IpAddr, sync::Arc};
use suppaftp::FtpError;

pub type Verifier = Arc<dyn Fn(&CertificateInfo) -> Result<bool> + Send + Sync>;

#[derive(Clone)]
pub struct CertificateInfo {
    pub host: String,
    pub address: String,
    pub fingerprint: String,
    pub subject: String,
    pub issuer: String,
    pub names: Vec<String>,
    pub not_before: String,
    pub not_after: String,
    pub name_matches: bool,
    pub validation_problem: Option<String>,
}
fn verify_leaf(cert: &X509, host: Option<&str>) -> Result<bool> {
    let mut store = X509StoreBuilder::new()?;
    store.add_cert(cert.clone())?;
    store.set_flags(X509VerifyFlags::PARTIAL_CHAIN | X509VerifyFlags::CHECK_SS_SIGNATURE)?;
    store.set_purpose(X509PurposeId::SSL_SERVER)?;
    if let Some(host) = host {
        let mut param = X509VerifyParam::new()?;
        match host.parse::<IpAddr>() {
            Ok(ip) => param.set_ip(ip)?,
            Err(_) => param.set_host(host)?,
        }
        store.set_param(&param)?;
    }
    let store = store.build();
    let chain = Stack::new()?;
    Ok(X509StoreContext::new()?.init(&store, cert, &chain, |ctx| ctx.verify_cert())?)
}
fn display_name(name: &openssl::x509::X509NameRef) -> String {
    name.entries()
        .map(|entry| {
            let value = String::from_utf8_lossy(entry.data().as_slice())
                .chars()
                .map(|c| if c.is_control() { ' ' } else { c })
                .take(200)
                .collect::<String>();
            format!(
                "{}={value}",
                entry.object().nid().short_name().unwrap_or("?")
            )
        })
        .take(10)
        .collect::<Vec<_>>()
        .join(", ")
        .chars()
        .take(300)
        .collect()
}
pub fn inspect(der: &[u8], profile: &Profile, problem: Option<String>) -> Result<CertificateInfo> {
    let cert = X509::from_der(der).context("The server supplied an unreadable TLS certificate")?;
    ensure!(verify_leaf(&cert, None)?, "The FTPS certificate is expired, not yet valid, or invalid for server authentication. It cannot be trusted as an exception.");
    let fingerprint = Sha256::digest(der)
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(":");
    let names = cert
        .subject_alt_names()
        .map(|names| {
            names
                .iter()
                .filter_map(|name| {
                    if let Some(dns) = name.dnsname() {
                        return Some(format!(
                            "DNS: {}",
                            dns.chars()
                                .filter(|c| !c.is_control())
                                .take(253)
                                .collect::<String>()
                        ));
                    }
                    name.ipaddress()
                        .and_then(|bytes| match bytes.len() {
                            4 => Some(IpAddr::from(<[u8; 4]>::try_from(bytes).ok()?)),
                            16 => Some(IpAddr::from(<[u8; 16]>::try_from(bytes).ok()?)),
                            _ => None,
                        })
                        .map(|ip| format!("IP: {ip}"))
                })
                .take(20)
                .collect()
        })
        .unwrap_or_default();
    Ok(CertificateInfo {
        host: profile.host_key(),
        address: profile.host.clone(),
        fingerprint,
        subject: display_name(cert.subject_name()),
        issuer: display_name(cert.issuer_name()),
        names,
        not_before: cert.not_before().to_string(),
        not_after: cert.not_after().to_string(),
        name_matches: verify_leaf(&cert, Some(&profile.host))?,
        validation_problem: problem,
    })
}

pub fn decision_error(error: &FtpError) -> Option<&str> {
    let FtpError::SecureError(details) = error else {
        return None;
    };
    details
        .trim_start_matches("Secure error: ")
        .strip_prefix("Cosy FTP certificate decision: ")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn profile() -> Profile {
        Profile {
            id: "fixture".into(),
            name: "Fixture".into(),
            protocol: "ftps".into(),
            host: "127.0.0.1".into(),
            port: 21,
            username: "tester".into(),
            initial_path: "/".into(),
            has_password: false,
            allow_insecure: false,
        }
    }
    fn certificate(expired: bool) -> Vec<u8> {
        use openssl::{
            asn1::Asn1Time,
            hash::MessageDigest,
            pkey::PKey,
            rsa::Rsa,
            x509::{
                extension::{BasicConstraints, ExtendedKeyUsage, KeyUsage, SubjectAlternativeName},
                X509NameBuilder,
            },
        };
        let key = PKey::from_rsa(Rsa::generate(2048).unwrap()).unwrap();
        let mut name = X509NameBuilder::new().unwrap();
        name.append_entry_by_text("CN", "localhost").unwrap();
        let name = name.build();
        let mut builder = X509::builder().unwrap();
        builder.set_version(2).unwrap();
        builder.set_subject_name(&name).unwrap();
        builder.set_issuer_name(&name).unwrap();
        builder.set_pubkey(&key).unwrap();
        let before = Asn1Time::from_unix(if expired {
            0
        } else {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs() as i64
                - 60
        })
        .unwrap();
        let after = if expired {
            Asn1Time::from_unix(1).unwrap()
        } else {
            Asn1Time::days_from_now(1).unwrap()
        };
        builder.set_not_before(&before).unwrap();
        builder.set_not_after(&after).unwrap();
        builder
            .append_extension(BasicConstraints::new().critical().build().unwrap())
            .unwrap();
        builder
            .append_extension(
                KeyUsage::new()
                    .digital_signature()
                    .key_encipherment()
                    .build()
                    .unwrap(),
            )
            .unwrap();
        builder
            .append_extension(ExtendedKeyUsage::new().server_auth().build().unwrap())
            .unwrap();
        let san = SubjectAlternativeName::new()
            .dns("localhost")
            .build(&builder.x509v3_context(None, None))
            .unwrap();
        builder.append_extension(san).unwrap();
        builder.sign(&key, MessageDigest::sha256()).unwrap();
        builder.build().to_der().unwrap()
    }
    #[test]
    fn pinning_checks_dates_names_and_every_exception_data_channel() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let profile = profile();
        let first = certificate(false);
        let changed = certificate(false);
        let info = inspect(&first, &profile, Some("untrusted".into())).unwrap();
        assert!(!info.name_matches);
        assert_eq!(info.host, "127.0.0.1:21");
        assert_eq!(info.fingerprint.len(), 95);
        assert!(inspect(&certificate(true), &profile, Some("untrusted".into())).is_err());
        let count = Arc::new(AtomicUsize::new(0));
        let calls = count.clone();
        let verifier: Verifier = Arc::new(move |_| {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(true)
        });
        let connector =
            crate::ftps_transport::CertificateConnector::new(&profile, verifier).unwrap();
        connector.check_peer(&info).unwrap();
        connector.check_peer(&info).unwrap();
        let changed = inspect(&changed, &profile, Some("untrusted".into())).unwrap();
        assert!(connector.check_peer(&changed).is_err());
        assert_eq!(count.load(Ordering::SeqCst), 1);
        // A normally valid control certificate must not authorize an unrelated
        // untrusted data certificate either.
        let normal =
            crate::ftps_transport::CertificateConnector::new(&profile, Arc::new(|_| Ok(true)))
                .unwrap();
        let mut trusted = info.clone();
        trusted.validation_problem = None;
        normal.check_peer(&trusted).unwrap();
        assert!(normal.check_peer(&changed).is_err());
    }
    #[test]
    fn cancellation_never_authorises_the_control_certificate() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let connector = crate::ftps_transport::CertificateConnector::new(
            &profile(),
            Arc::new(move |_| {
                count.fetch_add(1, Ordering::SeqCst);
                Ok(false)
            }),
        )
        .unwrap();
        let info = inspect(&certificate(false), &profile(), Some("untrusted".into())).unwrap();
        assert!(connector.check_peer(&info).is_err());
        assert!(connector.check_peer(&info).is_err());
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "Cancellation must leave the control certificate unapproved"
        );
    }
}
