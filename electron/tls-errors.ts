/** Turn TLS verification failures into guidance for a desktop user. */
export function ftpsCertificateError(error: unknown, host: string): Error | undefined {
  const code = (error as { code?: string } | null)?.code;
  let reason: string;
  switch (code) {
    case 'CERT_HAS_EXPIRED':
      reason = 'The server certificate has expired. Ask the server administrator to renew it.';
      break;
    case 'CERT_NOT_YET_VALID':
      reason =
        'The server certificate is not valid yet. Check your computer’s clock and the certificate dates.';
      break;
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      reason =
        'The certificate does not match this host. Use the server hostname supplied by your provider, or ask the administrator to correct the certificate.';
      break;
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      reason =
        'The server uses a self-signed or untrusted certificate. Ask the administrator to install a valid certificate and its full certificate chain.';
      break;
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
    case 'CERT_UNTRUSTED':
      reason =
        'The certificate chain could not be verified. The server may be missing an intermediate certificate or using a self-signed/private certificate. Ask the administrator to check the certificate and its full chain.';
      break;
    case 'CERT_REVOKED':
      reason = 'The server certificate has been revoked. Ask the administrator to replace it.';
      break;
    default:
      return undefined;
  }
  return new Error(
    `Cannot securely connect to ${host} using FTPS. ${reason} Certificate verification remains enabled.`,
    { cause: error },
  );
}
