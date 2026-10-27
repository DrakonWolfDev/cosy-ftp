"""Independent SSH/SFTP implementation for interoperability tests, loopback only."""
import errno
import json
import os
import socket
import sys
import threading
import struct
import base64
import hashlib
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[2] / '.test-tools'))
import paramiko

root = Path(sys.argv[1]).resolve()
key = paramiko.RSAKey.generate(2048)

class Authentication(paramiko.ServerInterface):
    def check_auth_password(self, username, password):
        return paramiko.AUTH_SUCCESSFUL if username == 'tester' and password == 'test-password' else paramiko.AUTH_FAILED

    def get_allowed_auths(self, username):
        return 'password'

    def check_channel_request(self, kind, channel_id):
        return paramiko.OPEN_SUCCEEDED if kind == 'session' else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

class Filesystem(paramiko.SFTPServerInterface):
    def local(self, filename):
        candidate = root / filename.lstrip('/')
        candidate = Path(os.path.abspath(candidate))
        if os.path.commonpath([str(root), str(candidate)]) != str(root):
            raise PermissionError(errno.EACCES, 'Outside test root')
        return candidate

    def canonicalize(self, filename):
        return '/' + os.path.relpath(self.local(filename), root).replace('\\', '/').lstrip('./')

    def list_folder(self, filename):
        try:
            result = []
            for item in self.local(filename).iterdir():
                attributes = paramiko.SFTPAttributes.from_stat(item.lstat())
                attributes.filename = item.name
                result.append(attributes)
            return result
        except OSError as error:
            return paramiko.SFTPServer.convert_errno(error.errno)

    def stat(self, filename):
        try:
            return paramiko.SFTPAttributes.from_stat(self.local(filename).stat())
        except OSError as error:
            return paramiko.SFTPServer.convert_errno(error.errno)

    def lstat(self, filename):
        try:
            return paramiko.SFTPAttributes.from_stat(self.local(filename).lstat())
        except OSError as error:
            return paramiko.SFTPServer.convert_errno(error.errno)

    def open(self, filename, flags, attributes):
        try:
            fd = os.open(self.local(filename), flags | getattr(os, 'O_BINARY', 0), getattr(attributes, 'st_mode', None) or 0o600)
            mode = 'r+b' if flags & os.O_RDWR else 'wb' if flags & os.O_WRONLY else 'rb'
            file = os.fdopen(fd, mode)
            handle = paramiko.SFTPHandle(flags)
            if not flags & os.O_WRONLY:
                handle.readfile = file
            if flags & (os.O_WRONLY | os.O_RDWR):
                handle.writefile = file
            return handle
        except OSError as error:
            return paramiko.SFTPServer.convert_errno(error.errno)

    def action(self, operation):
        try:
            operation()
            return paramiko.SFTP_OK
        except OSError as error:
            return paramiko.SFTPServer.convert_errno(error.errno)

    def remove(self, filename):
        return self.action(lambda: self.local(filename).unlink())

    def mkdir(self, filename, attributes):
        return self.action(lambda: self.local(filename).mkdir())

    def rmdir(self, filename):
        return self.action(lambda: self.local(filename).rmdir())

    def rename(self, source, destination):
        if self.local(destination).exists():
            return paramiko.SFTP_FAILURE
        return self.action(lambda: self.local(source).rename(self.local(destination)))

    def posix_rename(self, source, destination):
        return self.action(lambda: os.replace(self.local(source), self.local(destination)))

    def chattr(self, filename, attributes):
        return self.action(lambda: paramiko.SFTPServer.set_file_attr(str(self.local(filename)), attributes))

class ExtendedSFTPServer(paramiko.SFTPServer):
    # Paramiko implements posix-rename, but its default handshake advertises only
    # check-file. Advertise the extension this fixture actually implements.
    def _send_server_version(self):
        kind, data = self._read_packet()
        if kind != 1:
            raise paramiko.SFTPError('Expected INIT')
        message = paramiko.Message()
        message.add_int(3)
        message.add_string('posix-rename@openssh.com')
        message.add_string('1')
        self._send_packet(2, message)
        return struct.unpack('>I', data[:4])[0]

def serve(client):
    transport = paramiko.Transport(client)
    # This fixture has no moduli file. Remove GEX before Paramiko snapshots its
    # advertised algorithms, so advertisement and negotiation stay consistent
    # for clients using Windows CNG as well as OpenSSL.
    options = transport.get_security_options()
    options.kex = tuple(name for name in options.kex if not name.startswith('diffie-hellman-group-exchange-'))
    transport.add_server_key(key)
    transport.set_subsystem_handler('sftp', ExtendedSFTPServer, Filesystem)
    try:
        transport.start_server(server=Authentication())
        while transport.is_active():
            threading.Event().wait(0.05)
    except Exception:
        pass
    finally:
        transport.close()

listener = socket.socket()
listener.bind(('127.0.0.1', 0))
listener.listen(20)
print(json.dumps({'port': listener.getsockname()[1], 'fingerprint': 'SHA256:' + base64.b64encode(hashlib.sha256(key.asbytes()).digest()).decode().rstrip('=')}), flush=True)
while True:
    client, _ = listener.accept()
    threading.Thread(target=serve, args=(client,), daemon=True).start()
