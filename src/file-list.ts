import type { Entry } from '../shared/types';

export type SortField = 'name' | 'size' | 'modified';
export type SortDirection = 'ascending' | 'descending';
const names = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function sortEntries(entries: Entry[], field: SortField, direction: SortDirection): Entry[] {
  const sign = direction === 'ascending' ? 1 : -1;
  return [...entries].sort((a, b) => {
    const folders = Number(b.kind === 'directory') - Number(a.kind === 'directory');
    if (folders) return folders;
    if (field === 'modified') {
      // Unknown dates stay at the end in either direction.
      if (a.modified === null && b.modified !== null) return 1;
      if (b.modified === null && a.modified !== null) return -1;
    }
    const difference =
      field === 'name'
        ? names.compare(a.name, b.name)
        : field === 'size'
          ? a.size - b.size
          : (a.modified ?? 0) - (b.modified ?? 0);
    return difference * sign || names.compare(a.name, b.name);
  });
}

export function selectionRange(entries: Entry[], anchor: string, name: string): string[] {
  const first = entries.findIndex((entry) => entry.name === anchor);
  const last = entries.findIndex((entry) => entry.name === name);
  if (first < 0 || last < 0) return [name];
  return entries.slice(Math.min(first, last), Math.max(first, last) + 1).map((entry) => entry.name);
}
