import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';

export async function ftpServer(root: string, tls = false) {
  return pythonServer('ftp-server.py', root, tls ? ['tls'] : []);
}
export async function pythonServer(script: string, root: string, args: string[] = []) {
  const child = spawn(
    process.env.PYTHON ?? 'python',
    ['-u', path.resolve('tests/fixtures', script), root, ...args],
    { windowsHide: true },
  );
  let output = '';
  let errors = '';
  child.stderr.on('data', (chunk) => {
    errors += chunk.toString();
  });
  const info = await new Promise<{ port: number; certificate: string | null }>(
    (resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`FTP fixture timed out: ${errors}`));
      }, 15000);
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('exit', () => {
        clearTimeout(timeout);
        reject(new Error(`FTP fixture exited: ${errors}`));
      });
      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
        if (output.includes('\n')) {
          clearTimeout(timeout);
          try {
            resolve(JSON.parse(output.split('\n')[0]));
          } catch (error) {
            reject(error);
          }
        }
      });
    },
  );
  return {
    ...info,
    async close() {
      if (child.exitCode === null) {
        child.kill();
        await once(child, 'exit');
      }
    },
  };
}
