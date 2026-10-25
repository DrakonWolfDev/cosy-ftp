import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectionRange, sortEntries } from '../src/file-list';
import type { Entry } from '../shared/types';

const entry = (
  name: string,
  size: number,
  modified: number | null,
  kind: Entry['kind'] = 'file',
): Entry => ({ name, path: `/${name}`, size, modified, kind });
const files = [
  entry('file10', 10, 100),
  entry('file2', 2, null),
  entry('folder', 0, 500, 'directory'),
  entry('file1', 1, 200),
];

test('file sorting keeps folders first, handles numeric names and leaves unknown dates last', () => {
  assert.deepEqual(
    sortEntries(files, 'name', 'ascending').map((item) => item.name),
    ['folder', 'file1', 'file2', 'file10'],
  );
  assert.deepEqual(
    sortEntries(files, 'size', 'descending').map((item) => item.name),
    ['folder', 'file10', 'file2', 'file1'],
  );
  assert.deepEqual(
    sortEntries(files, 'modified', 'ascending').map((item) => item.name),
    ['folder', 'file10', 'file1', 'file2'],
  );
  assert.deepEqual(
    sortEntries(files, 'modified', 'descending').map((item) => item.name),
    ['folder', 'file1', 'file10', 'file2'],
  );
  assert.equal(files[0].name, 'file10', 'Sorting must not mutate the pane listing');
});

test('range selection uses displayed order in either direction and handles a filtered-out anchor', () => {
  const ordered = sortEntries(files, 'name', 'ascending');
  assert.deepEqual(selectionRange(ordered, 'file1', 'file10'), ['file1', 'file2', 'file10']);
  assert.deepEqual(selectionRange(ordered, 'file10', 'file1'), ['file1', 'file2', 'file10']);
  assert.deepEqual(selectionRange(ordered, 'no-longer-visible', 'file2'), ['file2']);
});
