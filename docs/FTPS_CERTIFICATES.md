# FTPS certificate trust

Cosy FTP normally validates the server certificate using the operating system's trusted authorities, certificate dates and hostname/IP address.

For a self-signed/private certificate or a name mismatch, a **Verify FTPS certificate** dialog appears before login. It shows the server and port, SHA-256 fingerprint, subject, issuer, certificate names, dates and any name mismatch. Compare the fingerprint with the **FTPS** certificate in the server administration settings; the server's separate administration certificate may be different.

Choose **Trust certificate** only after that comparison. The app saves the exact leaf-certificate fingerprint for that host and port in its own settings. An explicit name-mismatch exception lets a verified private server be used by IP without changing DNS or Windows trust. It does not trust other certificates or other ports. Password authentication starts only after the decision has been saved successfully.

An identical certificate is remembered. A replacement requires a new review showing the previous and new fingerprints, including when the replacement passes normal CA validation. Expired, not-yet-valid and invalid server-authentication certificates are refused. A rejected certificate is not retried as a new approval request within the same connection attempt.

Encrypted data connections in exception mode must present the accepted control-connection certificate. A different data-channel certificate is refused before file data is transferred.

FTPS also resumes the control connection's TLS session for data connections when the server supports it, including FileZilla servers that require resumption. This works with TLS 1.2 and TLS 1.3. It is separate from certificate approval; a `425 ... TLS session of data connection not resumed` error is a data-channel compatibility problem, not a certificate-renewal failure. Version 0.4.2 adds the resumption fix.

Use **Trusted FTPS certificates** in the sidebar to inspect saved fingerprints. Disconnect that server's sessions before choosing **Forget trust**. Forgetting preserves connection profiles and passwords; the next connection validates normally or asks again.

Trust decisions stay inside Cosy FTP. No Windows certificate-store or hosts-file changes are made. The private key remains on the server. See FileZilla's [connection-security settings](https://filezillapro.com/docs/server/advanced-options/setting-up-connection-security/) for its certificate controls.
