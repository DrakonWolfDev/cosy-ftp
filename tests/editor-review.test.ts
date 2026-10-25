import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EditorService } from '../electron/editor';
import { Sessions } from '../electron/sessions';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cosy-review-'));
  const originals = path.join(root, 'originals');
  await fs.mkdir(originals);
  const file = path.join(originals, 'config.txt');
  await fs.writeFile(file, 'original');
  const recovery = path.join(root, 'recovery');
  const sessions = new Sessions(async () => false);
  const editor = new EditorService(recovery, sessions);
  await editor.load();
  const document = await editor.open({ sessionId: 'local', path: file });
  return {
    root,
    originals,
    file,
    recovery,
    sessions,
    editor,
    document,
    async close() {
      sessions.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

test('reviewing a conflict does not write the original; stale reviews are refused and a reviewed draft survives recovery', async () => {
  const f = await fixture();
  try {
    await f.editor.draft(f.document.id, 'my draft');
    await fs.writeFile(f.file, 'external edit');
    const compared = await f.editor.compare(f.document.id);
    assert.equal(compared.changed, true);
    assert.equal(compared.content, 'external edit');
    assert.equal(await fs.readFile(f.file, 'utf8'), 'external edit');
    await fs.writeFile(f.file, 'a newer external edit');
    await assert.rejects(f.editor.review(f.document.id, compared.revision), /changed again/);
    await assert.rejects(f.editor.upload(f.document.id), /changed/);
    const latest = await f.editor.compare(f.document.id);
    await f.editor.draft(f.document.id, 'merged draft');
    const reviewed = await f.editor.review(f.document.id, latest.revision);
    assert.equal(reviewed.dirty, true);
    assert.equal(reviewed.content, 'merged draft');
    assert.equal(await fs.readFile(f.file, 'utf8'), 'a newer external edit');
    await fs.writeFile(f.file, 'changed after review');
    await assert.rejects(f.editor.upload(f.document.id), /changed/);
    await fs.writeFile(f.file, 'a newer external edit');
    const recovered = new EditorService(f.recovery, f.sessions);
    await recovered.load();
    assert.equal((await recovered.compare(f.document.id)).changed, false);
    assert.equal((await recovered.upload(f.document.id)).status, 'Saved to disk');
    assert.equal(await fs.readFile(f.file, 'utf8'), 'merged draft');
  } finally {
    await f.close();
  }
});

test('offline draft export preserves dirty state, refuses the original and requires explicit replacement', async (t) => {
  const f = await fixture();
  try {
    await f.editor.draft(f.document.id, '\ufeffdraft\r\n');
    f.sessions.close();
    const copy = path.join(f.root, 'draft-copy.txt');
    await f.editor.exportCopy(f.document.id, copy);
    assert.equal(await fs.readFile(copy, 'utf8'), '\ufeffdraft\r\n');
    assert.equal(await fs.readFile(f.file, 'utf8'), 'original');
    assert.equal(f.editor.dirty(f.document.id), true);
    await assert.rejects(f.editor.exportCopy(f.document.id, f.file, true), /separate file/);
    await assert.rejects(f.editor.exportCopy(f.document.id, copy), /already exists/);
    await fs.writeFile(copy, 'previous copy');
    await f.editor.exportCopy(f.document.id, copy, true);
    assert.equal(await fs.readFile(copy, 'utf8'), '\ufeffdraft\r\n');
    const hardLink = path.join(f.root, 'hard-link.txt');
    let linked = false;
    try {
      await fs.link(f.file, hardLink);
      linked = true;
    } catch {
      t.diagnostic('Hard-link protection could not be exercised on this filesystem');
    }
    if (linked)
      await assert.rejects(f.editor.exportCopy(f.document.id, hardLink, true), /separate file/);
    const alias = path.join(f.root, 'alias');
    try {
      await fs.symlink(f.originals, alias, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      t.diagnostic('Directory alias protection could not be exercised on this filesystem');
      return;
    }
    await assert.rejects(
      f.editor.exportCopy(f.document.id, path.join(alias, 'config.txt'), true),
      /separate file/,
    );
    assert.equal(await fs.readFile(f.file, 'utf8'), 'original');
  } finally {
    await f.close();
  }
});

test('export remains available after a recovery write failure, while a failed review leaves conflict protection intact', async () => {
  const f = await fixture();
  try {
    await fs.rename(f.recovery, `${f.recovery}-backup`);
    await fs.writeFile(f.recovery, 'blocked');
    await assert.rejects(f.editor.draft(f.document.id, 'latest rescued text'), /recovery copy/);
    await fs.writeFile(f.file, 'external edit');
    const comparison = await f.editor.compare(f.document.id);
    await assert.rejects(f.editor.review(f.document.id, comparison.revision));
    await assert.rejects(f.editor.upload(f.document.id), /changed/);
    const copy = path.join(f.root, 'rescued.txt');
    await f.editor.exportCopy(f.document.id, copy);
    assert.equal(await fs.readFile(copy, 'utf8'), 'latest rescued text');
    assert.equal(await fs.readFile(f.file, 'utf8'), 'external edit');
    assert.equal(f.editor.dirty(f.document.id), true);
  } finally {
    await f.close();
  }
});

test('draft exports refuse directories and symbolic links without modifying their targets', async (t) => {
  const f = await fixture();
  try {
    await assert.rejects(f.editor.exportCopy(f.document.id, f.originals, true), /folder/);
    const target = path.join(f.root, 'target.txt');
    await fs.writeFile(target, 'keep me');
    const link = path.join(f.root, 'link.txt');
    try {
      await fs.symlink(target, link);
    } catch {
      t.diagnostic('File symlink creation unavailable on this filesystem');
      return;
    }
    await assert.rejects(f.editor.exportCopy(f.document.id, link, true), /symbolic link/);
    assert.equal(await fs.readFile(target, 'utf8'), 'keep me');
  } finally {
    await f.close();
  }
});
