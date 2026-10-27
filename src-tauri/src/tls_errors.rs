//! Translate local TLS diagnostics without displaying arbitrary server replies.
use std::net::IpAddr;
use suppaftp::FtpError;

pub fn ftps_setup_error(error: &FtpError, host: &str) -> String {
    let FtpError::SecureError(details) = error else {
        return match error {
            FtpError::ConnectionError(_) => format!("FTPS setup failed for {host}: the connection closed or timed out while enabling TLS. Check the server and try again."),
            _ => format!("FTPS setup failed for {host}: the server refused secure FTP setup. Check that explicit FTP over TLS and encrypted data connections are enabled on this port."),
        };
    };
    let details = details.to_ascii_lowercase();
    let contains = |patterns: &[&str]| patterns.iter().any(|pattern| details.contains(pattern));
    let reason = if contains(&[
        "hostname mismatch",
        "ip address mismatch",
        "does not match",
        "wrong principal",
        "principal name is incorrect",
        "0x80090322",
        "-2146893022",
        "0x800b010f",
        "-2146762481",
    ]) {
        "The certificate does not match the connection's hostname or IP address. Use a name listed in the certificate, or regenerate the server certificate with the correct subject alternative name."
    } else if contains(&["not yet valid"]) {
        "A certificate in the server's chain is not valid yet. Check the certificate dates and your computer's clock."
    } else if contains(&["has expired", "certificate expired"]) {
        "A certificate in the server's chain has expired. Renew it and apply the renewed certificate to the FTP-over-TLS listener."
    } else if contains(&[
        "0x80090328",
        "-2146893016",
        "0x800b0101",
        "-2146762495",
        "validity period",
    ]) {
        "A certificate in the server's chain is outside its valid date range. Check the certificate dates and your computer's clock."
    } else if contains(&["revoked", "0x800b010c", "-2146762484"]) {
        "A certificate in the server's chain has been revoked. Replace it before connecting."
    } else if contains(&["self signed", "self-signed"]) {
        "The certificate is self-signed and is not trusted on this computer. Verify it against the server's configured FTPS certificate before explicitly trusting it, or install a certificate from a trusted authority on the server."
    } else if contains(&[
        "not trusted",
        "untrusted",
        "unknown ca",
        "unknown issuer",
        "unable to get issuer",
        "unable to get local issuer",
        "unable to verify",
        "0x80090325",
        "-2146893019",
        "0x800b0109",
        "-2146762487",
        "0x800b010a",
        "-2146762486",
    ]) {
        "The certificate chain is not trusted on this computer. It may be self-signed, use a private certificate authority, or be missing an intermediate certificate. Verify the certificate and establish trust explicitly, or install the complete trusted certificate chain on the server."
    } else {
        return format!("FTPS TLS handshake failed for {host}. Check certificate trust, certificate names and dates, and the server's TLS compatibility. Certificate verification remains enabled.");
    };
    let ip_guidance = if host.parse::<IpAddr>().is_ok() {
        " You are connecting by IP address; the certificate must include this exact IP as an IP subject alternative name. Trusting a certificate does not fix a name mismatch."
    } else {
        ""
    };
    format!("FTPS TLS validation failed for {host}. {reason}{ip_guidance}")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn message(details: &str, host: &str) -> String {
        ftps_setup_error(&FtpError::SecureError(details.into()), host)
    }
    #[test]
    fn identifies_native_windows_and_openssl_trust_failures() {
        for detail in [
            "self-signed certificate",
            "self signed certificate in certificate chain",
            "0x80090325",
            "os error -2146893019",
            "0x800B0109",
            "unable to get local issuer certificate",
        ] {
            assert!(
                message(detail, "files.example.com").contains("not trusted"),
                "{detail}"
            );
        }
    }
    #[test]
    fn explains_name_mismatch_and_the_separate_ip_requirement() {
        for detail in [
            "hostname mismatch",
            "IP address mismatch",
            "0x80090322",
            "os error -2146762481",
        ] {
            let text = message(detail, "198.244.177.109");
            assert!(text.contains("does not match"));
            assert!(text.contains("IP subject alternative name"));
        }
        assert!(message("0x80090325", "198.244.177.109").contains("does not fix a name mismatch"));
        assert!(
            !message("hostname mismatch", "files.example.com").contains("You are connecting by IP")
        );
    }
    #[test]
    fn distinguishes_date_failures_and_redacts_unknown_details() {
        assert!(message("certificate has expired", "files.example.com").contains("has expired"));
        assert!(
            message("certificate is not yet valid", "files.example.com").contains("not valid yet")
        );
        assert!(message("os error -2146762495", "files.example.com").contains("valid date range"));
        assert!(message("certificate revoked", "files.example.com").contains("revoked"));
        let text = message(
            "unrecognised local detail with test-password",
            "files.example.com",
        );
        assert!(text.contains("handshake failed"));
        assert!(!text.contains("test-password"));
        let text = ftps_setup_error(
            &FtpError::ConnectionError(std::io::Error::other("test-password")),
            "files.example.com",
        );
        assert!(!text.contains("test-password"));
        assert!(text.contains("closed or timed out"));
    }
}
