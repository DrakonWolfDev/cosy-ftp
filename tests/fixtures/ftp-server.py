"""Loopback-only integration server. Never use these credentials in production."""
import datetime
import json
import logging
import os
import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[2] / '.test-tools'))
from pyftpdlib.authorizers import DummyAuthorizer
from pyftpdlib.handlers import FTPHandler, TLS_FTPHandler, TLS_DTPHandler
from pyftpdlib.servers import FTPServer

root = Path(sys.argv[1]).resolve()
tls = len(sys.argv) > 2 and sys.argv[2] == 'tls'
resume_version = sys.argv[3] if len(sys.argv) > 3 else None
authorizer = DummyAuthorizer()
authorizer.add_user('tester', 'test-password', str(root), perm='elradfmwMT')
class FixtureHandler(TLS_FTPHandler if tls else FTPHandler):
    def on_login(self, username):
        with (root.parent / 'login-events.txt').open('a', encoding='utf-8') as events:
            events.write(username + '\n')

class ResumingDataHandler(TLS_DTPHandler):
    def handle_ssl_established(self):
        from OpenSSL import SSL
        resumed = bool(SSL._lib.SSL_session_reused(self.socket._ssl))
        with (root.parent / 'resumption-events.txt').open('a', encoding='utf-8') as events:
            events.write(('resumed' if resumed else 'fresh') + '\n')
        if not resumed:
            self.cmd_channel.respond('425 Unable to build data connection: TLS session of data connection not resumed.')
            self.close()

handler = FixtureHandler
if resume_version:
    handler.dtp_handler = ResumingDataHandler
handler.authorizer = authorizer
handler.banner = 'Cosy FTP integration fixture'
cert_file = root.parent / 'test-certificate.pem'
if tls:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'localhost')])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(days=1))
            .not_valid_after(now + datetime.timedelta(days=2))
            .add_extension(x509.SubjectAlternativeName([x509.DNSName('localhost')]), critical=False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .sign(key, hashes.SHA256()))
    cert_file.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_file = root.parent / 'test-key.pem'
    key_file.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption()))
    handler.certfile = str(cert_file)
    handler.keyfile = str(key_file)
    handler.tls_control_required = True
    handler.tls_data_required = True
    if resume_version:
        from OpenSSL import SSL
        context = handler.get_ssl_context()
        context.set_session_id(b'cosy-ftps-resumption-test')
        context.set_session_cache_mode(SSL.SESS_CACHE_SERVER)
        version = SSL.TLS1_2_VERSION if resume_version == '12' else SSL.TLS1_3_VERSION
        context.set_min_proto_version(version)
        context.set_max_proto_version(version)
logging.getLogger('pyftpdlib').setLevel(logging.CRITICAL)
server = FTPServer(('127.0.0.1', 0), handler)
print(json.dumps({'port': server.socket.getsockname()[1], 'certificate': str(cert_file) if tls else None}), flush=True)
server.serve_forever(timeout=0.1, blocking=True, handle_exit=True)
