# Security policy

Cosy FTP is in beta. Security fixes target the current main branch and latest beta; older prereleases are not maintained separately.

Please report suspected vulnerabilities through [GitHub's private vulnerability reporting](https://github.com/DrakonWolfDev/cosy-ftp/security/advisories/new). Do not post credentials, connection profiles, recovery drafts or exploitable details in a public issue. If private reporting is unavailable, use the contact link on [Wolf Forge](https://wolf-forge.co.uk) and ask for a private reporting channel before sending sensitive details.

Include the app version, operating system, protocol and a minimal reproduction using disposable data. Redact hostnames and personal paths. Do not attach real passwords, private keys, tokens or recovery files.

The maintainer will investigate reports as availability permits. No response-time or bug-bounty commitment is offered.

Server fingerprint verification, explicit saves and encrypted credential storage are described in [the README](README.md) and [reliability notes](docs/RELIABILITY.md). These documents also explain transfer races, metadata limits and plaintext local editor recovery copies.
