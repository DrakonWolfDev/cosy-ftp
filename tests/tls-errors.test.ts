import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ftpsCertificateError } from '../electron/tls-errors';

test('FTPS trust failures explain certificate remedies without suggesting a Node.js launch flag', () => {
  const original = Object.assign(
    new Error('unable to verify the first certificate; try --use-system-ca'),
    { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' },
  );
  const result = ftpsCertificateError(original, 'files.example.com')!;
  assert.match(result.message, /files\.example\.com.*certificate chain/i);
  assert.match(result.message, /administrator/);
  assert.match(result.message, /verification remains enabled/);
  assert.doesNotMatch(result.message, /--use-system-ca/);
  assert.equal(result.cause, original);
});

test('FTPS date and hostname failures have distinct guidance; other failures are untouched', () => {
  assert.match(
    ftpsCertificateError({ code: 'CERT_HAS_EXPIRED' }, 'host')!.message,
    /expired.*renew/,
  );
  assert.match(ftpsCertificateError({ code: 'CERT_NOT_YET_VALID' }, 'host')!.message, /clock/);
  assert.match(
    ftpsCertificateError({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }, 'host')!.message,
    /hostname/,
  );
  assert.equal(ftpsCertificateError({ code: 530 }, 'host'), undefined);
  assert.equal(ftpsCertificateError(null, 'host'), undefined);
});
