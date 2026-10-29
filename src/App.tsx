import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { BrandMark } from './BrandMark';
import { WolfUpdate } from './WolfUpdate';
import { selectionRange, sortEntries, type SortField, type SortDirection } from './file-list';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  CheckCheck,
  ChevronDown,
  CircleHelp,
  Cloud,
  Copy,
  File,
  FileCode2,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Link2,
  LoaderCircle,
  Moon,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  Sun,
  Terminal,
  Trash2,
  Unplug,
  X,
} from 'lucide-react';
import type {
  EditDocument,
  EditComparison,
  Entry,
  InitialState,
  Listing,
  Location,
  LogEntry,
  Profile,
  ProfileInput,
  Result,
  SessionInfo,
  TransferJob,
  TrustedHost,
} from '../shared/types';

async function value<T>(promise: Promise<Result<T>>): Promise<T> {
  const result = await promise;
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
function message(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong';
}
function bytes(size: number) {
  if (size < 1024) return `${size} B`;
  const unit = Math.min(Math.floor(Math.log(size) / Math.log(1024)), 4);
  return `${(size / 1024 ** unit).toFixed(unit > 1 ? 1 : 0)} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`;
}
function date(time: number | null) {
  return time === null
    ? '—'
    : new Date(time).toLocaleDateString(undefined, {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      });
}

interface PaneSelection {
  location: Location;
  entries: Entry[];
  ready: boolean;
}
interface PaneProps {
  side: 'left' | 'right';
  home: string;
  sessions: SessionInfo[];
  profiles: Profile[];
  active: boolean;
  target?: SessionInfo;
  refresh: number;
  onActive(): void;
  onSelection(selection: PaneSelection): void;
  onConnect(profile: Profile, side: 'left' | 'right'): void;
  onEdit(location: Location): void;
  onError(error: unknown): void;
  onTransfer(side: 'left' | 'right', names?: string[]): void;
  onReconnect(id: string): Promise<void>;
}

function FilePane(props: PaneProps) {
  const [listing, setListing] = useState<Listing>();
  const [location, setLocation] = useState<Location>({ sessionId: 'local', path: props.home });
  const [pathInput, setPathInput] = useState(props.home);
  const [selection, setSelection] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [operation, setOperation] = useState<'mkdir' | 'rename' | null>(null);
  const [newName, setNewName] = useState('');
  const [operationBusy, setOperationBusy] = useState(false);
  const [drop, setDrop] = useState(false);
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('ascending');
  const anchor = useRef<string | undefined>(undefined);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(500);
  const scrollContainer = useRef<HTMLDivElement>(null);
  const selectedNames = useMemo(() => new Set(selection), [selection]);
  useEffect(() => {
    const element = scrollContainer.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setViewportHeight(element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (scrollContainer.current) scrollContainer.current.scrollTop = 0;
    setScrollTop(0);
  }, [
    filter,
    hidden,
    listing?.location.path,
    listing?.location.sessionId,
    sortField,
    sortDirection,
  ]);
  const request = useRef(0);
  const current = useRef(location);
  current.current = location;
  const load = useCallback(async (next: Location) => {
    const token = ++request.current;
    setBusy(true);
    setError('');
    setSelection([]);
    anchor.current = undefined;
    try {
      const result = await value(window.cosy.list(next));
      if (token !== request.current) return;
      setListing(result);
      setLocation(result.location);
      setPathInput(result.location.path);
    } catch (error) {
      if (token === request.current) {
        setError(message(error));
        setListing(undefined);
      }
    } finally {
      if (token === request.current) setBusy(false);
    }
  }, []);
  useEffect(() => {
    void load(current.current);
  }, [load, props.refresh]);
  useEffect(() => {
    if (props.target) void load({ sessionId: props.target.id, path: props.target.path });
  }, [props.target, load]);
  useEffect(() => {
    if (!props.sessions.some((session) => session.id === current.current.sessionId))
      void load({ sessionId: 'local', path: props.home });
  }, [props.sessions, props.home, load]);
  const onSelection = props.onSelection;
  useEffect(() => {
    onSelection({
      location,
      entries: listing?.entries.filter((entry) => selectedNames.has(entry.name)) ?? [],
      ready: Boolean(listing) && !busy && !error,
    });
  }, [location, listing, selectedNames, onSelection, busy, error]);
  const entries = useMemo(
    () =>
      sortEntries(
        listing?.entries.filter(
          (entry) =>
            (hidden || !entry.name.startsWith('.')) &&
            entry.name.toLowerCase().includes(filter.toLowerCase()),
        ) ?? [],
        sortField,
        sortDirection,
      ),
    [listing, hidden, filter, sortField, sortDirection],
  );
  const selected = listing?.entries.filter((entry) => selectedNames.has(entry.name)) ?? [];
  const firstRow = Math.min(
    Math.max(0, entries.length - 1),
    Math.max(0, Math.floor((scrollTop - 34) / 34) - 10),
  );
  const visibleEntries = entries.slice(firstRow, firstRow + Math.ceil(viewportHeight / 34) + 22);
  const remainingRows = Math.max(0, entries.length - firstRow - visibleEntries.length);
  const session = props.sessions.find((session) => session.id === location.sessionId);
  async function open(entry: Entry) {
    if (entry.kind === 'directory') await load({ ...location, path: entry.path });
    else if (entry.kind === 'file') props.onEdit({ ...location, path: entry.path });
    else
      props.onError(
        new Error('Symbolic links and special files cannot be opened in this version.'),
      );
  }
  async function mutate() {
    setOperationBusy(true);
    try {
      if (operation === 'mkdir') await value(window.cosy.mkdir({ location, name: newName }));
      else await value(window.cosy.rename({ location, name: selected[0].name, newName }));
      setOperation(null);
      await load(location);
    } catch (error) {
      props.onError(error);
    } finally {
      setOperationBusy(false);
    }
  }
  async function remove() {
    try {
      if (await value(window.cosy.remove({ location, names: selection }))) await load(location);
    } catch (error) {
      props.onError(error);
    }
  }
  function toggle(entry: Entry, additive: boolean, range = false) {
    props.onActive();
    if (range && anchor.current) {
      const names = selectionRange(entries, anchor.current, entry.name);
      setSelection((previous) => (additive ? [...new Set([...previous, ...names])] : names));
      return;
    }
    anchor.current = entry.name;
    setSelection((previous) =>
      additive
        ? previous.includes(entry.name)
          ? previous.filter((name) => name !== entry.name)
          : [...previous, entry.name]
        : [entry.name],
    );
  }
  function sort(field: SortField) {
    anchor.current = undefined;
    if (field === sortField)
      setSortDirection((previous) => (previous === 'ascending' ? 'descending' : 'ascending'));
    else {
      setSortField(field);
      setSortDirection(field === 'name' ? 'ascending' : 'descending');
    }
  }
  return (
    <section
      className={`file-pane ${props.active ? 'active' : ''} ${drop ? 'drop-target' : ''}`}
      aria-label={`${props.side} file pane`}
      onFocusCapture={props.onActive}
      onMouseDown={props.onActive}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('application/x-cosy-files')) {
          event.preventDefault();
          setDrop(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setDrop(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDrop(false);
        try {
          const data = JSON.parse(event.dataTransfer.getData('application/x-cosy-files')) as {
            side: 'left' | 'right';
            names: string[];
          };
          if (data.side !== props.side) props.onTransfer(data.side, data.names);
        } catch {
          props.onError(
            new Error('Only files dragged from the other Cosy FTP pane can be copied.'),
          );
        }
      }}
    >
      <header className="pane-header">
        <div className={`endpoint-icon ${session?.protocol !== 'local' ? 'remote' : ''}`}>
          {session?.protocol === 'local' ? <HardDrive size={19} /> : <Server size={19} />}
        </div>
        <div className="endpoint-title">
          <select
            aria-label={`${props.side} connection`}
            value={location.sessionId}
            onChange={(event) => {
              const option = event.target.value;
              if (option.startsWith('connect:'))
                props.onConnect(
                  props.profiles.find((profile) => profile.id === option.slice(8))!,
                  props.side,
                );
              else {
                const session = props.sessions.find((session) => session.id === option)!;
                void load({ sessionId: session.id, path: session.path });
              }
            }}
          >
            {props.sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.label}
                {session.protocol !== 'local' ? ` · ${session.protocol.toUpperCase()}` : ''}
              </option>
            ))}
            {props.profiles.length > 0 && (
              <optgroup label="Open a new session">
                {props.profiles.map((profile) => (
                  <option key={profile.id} value={`connect:${profile.id}`}>
                    {profile.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>
        <span className={`connection-badge ${session?.protocol === 'ftp' ? 'insecure' : ''}`}>
          <span />
          {session?.protocol === 'local'
            ? 'Local'
            : session?.protocol === 'ftp'
              ? 'Unencrypted'
              : 'Encrypted'}
        </span>
      </header>
      <form
        className="path-bar"
        onSubmit={(event) => {
          event.preventDefault();
          void load({ ...location, path: pathInput });
        }}
      >
        <button
          type="button"
          className="icon-button"
          title="Parent folder"
          aria-label={`${props.side} parent folder`}
          disabled={busy || !listing || listing.parent === location.path}
          onClick={() => void load({ ...location, path: listing!.parent })}
        >
          <ArrowUp size={16} />
        </button>
        <FolderOpen size={16} className="muted shrink" />
        <input
          aria-label={`${props.side} path`}
          value={pathInput}
          onChange={(event) => setPathInput(event.target.value)}
          spellCheck={false}
        />
        <button
          type="button"
          className={`icon-button ${busy ? 'spin' : ''}`}
          title="Refresh"
          aria-label={`${props.side} refresh`}
          disabled={busy}
          onClick={() => void load(location)}
        >
          <RefreshCw size={15} />
        </button>
        {location.sessionId === 'local' && (
          <button
            type="button"
            className="icon-button"
            title="Choose local folder"
            aria-label={`${props.side} choose folder`}
            onClick={async () => {
              try {
                const folder = await value(window.cosy.chooseFolder());
                if (folder) await load({ sessionId: 'local', path: folder });
              } catch (error) {
                props.onError(error);
              }
            }}
          >
            <MoreHorizontal size={17} />
          </button>
        )}
      </form>
      <div className="pane-actions">
        <button
          disabled={busy || !listing}
          onClick={() => {
            setNewName('');
            setOperation('mkdir');
          }}
        >
          <FolderPlus size={15} />
          New folder
        </button>
        <button
          disabled={busy || selected.length !== 1 || selected[0]?.kind !== 'file'}
          onClick={() => void open(selected[0])}
          title="Edit selected text file"
          aria-label={`${props.side} edit selected file`}
        >
          <FileCode2 size={14} />
          Edit
        </button>
        <button
          disabled={busy || selected.length !== 1}
          onClick={() => {
            setNewName(selected[0].name);
            setOperation('rename');
          }}
          title="Rename selected item"
        >
          <Pencil size={14} />
          <span className="action-label">Rename</span>
        </button>
        <button
          disabled={busy || !selected.length}
          onClick={() => void remove()}
          title="Delete selected items"
        >
          <Trash2 size={14} />
        </button>
        <div className="pane-filter">
          <Search size={14} />
          <input
            aria-label={`${props.side} filter files`}
            placeholder="Filter files…"
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
              setSelection([]);
            }}
          />
        </div>
      </div>
      <div
        className="file-table"
        ref={scrollContainer}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        role="group"
        tabIndex={0}
        aria-label={`${props.side} files`}
        aria-busy={busy}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if ((event.ctrlKey || event.metaKey) && event.key === 'a') {
            event.preventDefault();
            setSelection(entries.map((entry) => entry.name));
          }
          if (event.key === 'Enter' && selected.length === 1) void open(selected[0]);
          if (event.key === 'Backspace' && listing) {
            event.preventDefault();
            void load({ ...location, path: listing.parent });
          }
        }}
      >
        <table aria-rowcount={entries.length + 1} inert={busy}>
          <thead>
            <tr>
              <th className="check-cell">
                <input
                  type="checkbox"
                  aria-label={`Select all ${props.side} files`}
                  checked={
                    entries.length > 0 && entries.every((entry) => selectedNames.has(entry.name))
                  }
                  onChange={(event) =>
                    setSelection(event.target.checked ? entries.map((entry) => entry.name) : [])
                  }
                />
              </th>
              {(['name', 'size', 'modified'] as const).map((field) => (
                <th key={field} aria-sort={sortField === field ? sortDirection : 'none'}>
                  <button
                    className="sort-button"
                    aria-label={`Sort ${props.side} files by ${field}`}
                    onClick={() => sort(field)}
                  >
                    {field === 'name' ? 'Name' : field === 'size' ? 'Size' : 'Modified'}
                    {sortField === field && (
                      <ChevronDown
                        size={12}
                        className={sortDirection === 'descending' ? 'sort-descending' : ''}
                      />
                    )}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {firstRow > 0 && (
              <tr aria-hidden="true">
                <td colSpan={4} style={{ height: firstRow * 34, padding: 0, border: 0 }} />
              </tr>
            )}
            {visibleEntries.map((entry, index) => (
              <tr
                key={entry.name}
                aria-rowindex={firstRow + index + 2}
                className={selectedNames.has(entry.name) ? 'selected' : ''}
                onClick={(event) => toggle(entry, event.ctrlKey || event.metaKey, event.shiftKey)}
                onDoubleClick={() => void open(entry)}
                draggable
                onDragStart={(event) => {
                  const names = selectedNames.has(entry.name) ? selection : [entry.name];
                  setSelection(names);
                  event.dataTransfer.setData(
                    'application/x-cosy-files',
                    JSON.stringify({ side: props.side, names }),
                  );
                  event.dataTransfer.effectAllowed = 'copy';
                }}
              >
                <td className="check-cell" onClick={(event) => event.stopPropagation()}>
                  <input
                    type="checkbox"
                    aria-label={`Select ${entry.name}`}
                    checked={selectedNames.has(entry.name)}
                    onChange={(event) =>
                      toggle(entry, true, Boolean((event.nativeEvent as MouseEvent).shiftKey))
                    }
                  />
                </td>
                <td>
                  <button
                    className="file-name"
                    onClick={(event) => {
                      event.stopPropagation();
                      toggle(entry, event.ctrlKey || event.metaKey, event.shiftKey);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        event.stopPropagation();
                        void open(entry);
                      }
                    }}
                  >
                    {entry.kind === 'directory' ? (
                      <Folder size={17} className="folder-icon" />
                    ) : entry.kind === 'link' ? (
                      <Link2 size={16} className="muted" />
                    ) : /\.(json|html|css|js|ts|xml|cfg|ini|md|txt|py|sh|yml|yaml)$/i.test(
                        entry.name,
                      ) ? (
                      <FileCode2 size={16} className="text-icon" />
                    ) : (
                      <File size={16} className="muted" />
                    )}
                    <span>{entry.name}</span>
                  </button>
                </td>
                <td className="file-size">
                  {entry.kind === 'directory' ? '—' : bytes(entry.size)}
                </td>
                <td className="file-date">{date(entry.modified)}</td>
              </tr>
            ))}
            {remainingRows > 0 && (
              <tr aria-hidden="true">
                <td colSpan={4} style={{ height: remainingRows * 34, padding: 0, border: 0 }} />
              </tr>
            )}
          </tbody>
        </table>
        {busy && !listing && (
          <div className="pane-empty">
            <LoaderCircle className="spin" size={25} />
            <strong>Opening folder…</strong>
          </div>
        )}
        {!busy && error && (
          <div className="pane-empty error-state">
            <Cloud size={32} />
            <strong>Couldn’t open this location</strong>
            <p>{error}</p>
            <button onClick={() => void load(location)}>
              <RefreshCw size={14} />
              Try again
            </button>
            {location.sessionId !== 'local' && (
              <button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await props.onReconnect(location.sessionId);
                  } catch (error) {
                    props.onError(error);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Unplug size={14} />
                Reconnect session
              </button>
            )}
          </div>
        )}
        {!busy && !error && !entries.length && (
          <div className="pane-empty">
            <FolderOpen size={34} />
            <strong>{filter ? 'No matching files' : 'A little breathing room'}</strong>
            <p>
              {filter
                ? 'Try another search.'
                : 'This folder is empty. Copy files here or create a folder.'}
            </p>
          </div>
        )}
      </div>
      <footer className="pane-footer">
        <span>
          {selected.length ? `${selected.length} selected` : `${entries.length} items`}
          {selected.length > 0 &&
            ` · ${bytes(selected.reduce((sum, entry) => sum + (entry.kind === 'file' ? entry.size : 0), 0))}`}
        </span>
        <label>
          <input
            type="checkbox"
            checked={hidden}
            onChange={(event) => {
              setHidden(event.target.checked);
              setSelection([]);
            }}
          />
          Hidden files
        </label>
      </footer>
      {operation && (
        <Modal
          title={operation === 'mkdir' ? 'New folder' : 'Rename item'}
          onClose={() => !operationBusy && setOperation(null)}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void mutate();
            }}
          >
            <label className="field">
              {operation === 'mkdir' ? 'Folder name' : 'New name'}
              <input
                autoFocus
                required
                value={newName}
                maxLength={255}
                onChange={(event) => setNewName(event.target.value)}
              />
            </label>
            <p className="form-hint">In {location.path}</p>
            <div className="modal-actions">
              <button type="button" disabled={operationBusy} onClick={() => setOperation(null)}>
                Cancel
              </button>
              <button className="primary" disabled={!newName || operationBusy}>
                {operationBusy ? 'Working…' : operation === 'mkdir' ? 'Create folder' : 'Rename'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}

function Modal({
  title,
  children,
  onClose,
  wide = false,
  closeLabel = 'Close dialog',
}: {
  title: string;
  closeLabel?: string;
  children: ReactNode;
  onClose(): void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const shell = document.querySelector<HTMLElement>('.app-shell');
    if (shell) shell.inert = true;
    const first =
      ref.current?.querySelector<HTMLElement>('input, select, textarea') ??
      ref.current?.querySelector<HTMLElement>('button');
    first?.focus();
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close.current();
      }
      if (event.key !== 'Tab') return;
      const elements = [
        ...(ref.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
        ) ?? []),
      ];
      const index = elements.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && index <= 0) {
        event.preventDefault();
        elements.at(-1)?.focus();
      } else if (!event.shiftKey && index === elements.length - 1) {
        event.preventDefault();
        elements[0]?.focus();
      }
    };
    document.addEventListener('keydown', listener);
    return () => {
      document.removeEventListener('keydown', listener);
      if (shell && document.querySelectorAll('[role="dialog"]').length <= 1) shell.inert = false;
      previous?.focus();
    };
  }, []);
  return createPortal(
    <div className="modal-backdrop">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`modal ${wide ? 'wide' : ''}`}
      >
        <div className="modal-heading">
          <h2>{title}</h2>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label={closeLabel}
            title={closeLabel}
          >
            <X size={19} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

function ConnectionForm({
  existing,
  canStore,
  onSave,
  onClose,
}: {
  existing?: Profile;
  canStore: boolean;
  onSave(profile: ProfileInput): Promise<void>;
  onClose(): void;
}) {
  const [form, setForm] = useState<ProfileInput>(
    existing
      ? { ...existing, rememberPassword: existing.hasPassword && canStore, password: undefined }
      : {
          name: '',
          protocol: 'sftp',
          host: '',
          port: 22,
          username: '',
          initialPath: '/',
          rememberPassword: false,
          allowInsecure: false,
        },
  );
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof ProfileInput>(key: K, val: ProfileInput[K]) =>
    setForm((previous) => ({ ...previous, [key]: val }));
  const canReusePassword =
    existing?.hasPassword &&
    existing.host === form.host &&
    existing.port === form.port &&
    existing.protocol === form.protocol &&
    existing.username === form.username;
  return (
    <Modal
      title={existing ? 'Edit connection' : 'A new place for your files'}
      onClose={() => !busy && onClose()}
    >
      <p className="modal-description">Save a server, then open it in either pane.</p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          try {
            const { hasPassword: _hasPassword, ...clean } = form as ProfileInput & {
              hasPassword?: boolean;
            };
            await onSave({ ...clean, password: password || undefined });
          } catch (error) {
            setError(message(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="field">
          Connection name
          <input
            required
            value={form.name}
            placeholder="My web server"
            maxLength={100}
            onChange={(event) => set('name', event.target.value)}
          />
        </label>
        <div className="form-row">
          <label className="field">
            Protocol
            <select
              value={form.protocol}
              onChange={(event) => {
                const protocol = event.target.value as Profile['protocol'];
                setForm((previous) => ({
                  ...previous,
                  protocol,
                  port: protocol === 'sftp' ? 22 : 21,
                  allowInsecure: false,
                }));
              }}
            >
              <option value="sftp">SFTP · SSH</option>
              <option value="ftps">FTPS · TLS</option>
              <option value="ftp">FTP · unencrypted</option>
            </select>
          </label>
          <label className="field port-field">
            Port
            <input
              required
              type="number"
              min={1}
              max={65535}
              value={form.port || ''}
              onChange={(event) => set('port', Number(event.target.value))}
            />
          </label>
        </div>
        <label className="field">
          Host
          <input
            required
            value={form.host}
            placeholder="files.example.com"
            spellCheck={false}
            onChange={(event) => set('host', event.target.value)}
          />
        </label>
        <div className="form-row">
          <label className="field">
            Username
            <input
              required
              autoComplete="off"
              value={form.username}
              onChange={(event) => set('username', event.target.value)}
            />
          </label>
          <label className="field">
            Password
            <input
              type="password"
              required={form.rememberPassword && !canReusePassword}
              autoComplete="new-password"
              value={password}
              placeholder={
                existing?.hasPassword ? 'Leave blank to keep saved password' : 'Ask when connecting'
              }
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
        </div>
        <label className="field">
          Starting folder
          <input
            required
            value={form.initialPath}
            spellCheck={false}
            onChange={(event) => set('initialPath', event.target.value)}
          />
        </label>
        <label className="check-label">
          <input
            type="checkbox"
            disabled={!canStore}
            checked={form.rememberPassword && canStore}
            onChange={(event) => set('rememberPassword', event.target.checked)}
          />
          Remember password using secure system storage
        </label>
        {!canStore && (
          <p className="form-hint">
            Secure storage is unavailable. Passwords will be requested per session.
          </p>
        )}
        {existing?.hasPassword && (
          <p className="form-hint">
            Changing the host, port, protocol or username clears the saved password unless you enter
            it again.
          </p>
        )}
        {form.protocol === 'ftp' && (
          <label className="check-label warning">
            <input
              type="checkbox"
              required
              checked={form.allowInsecure}
              onChange={(event) => set('allowInsecure', event.target.checked)}
            />
            I understand FTP sends passwords and files without encryption.
          </label>
        )}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save connection'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Queue({
  jobs,
  onError,
  onRefresh,
}: {
  jobs: TransferJob[];
  onError(error: unknown): void;
  onRefresh(): void;
}) {
  const [expanded, setExpanded] = useState(true);
  const active = jobs.filter((job) => job.state === 'running' || job.state === 'queued');
  const needsAttention = active.length > 0 || jobs.some((job) => job.state === 'failed');
  useEffect(() => {
    if (needsAttention) setExpanded(true);
  }, [needsAttention]);
  return (
    <section className="queue" aria-label="Transfer queue">
      <header>
        <button
          className="queue-toggle"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
        >
          <ArrowDown size={16} />
          <strong>Transfer queue</strong>
          <span className="count">{jobs.length}</span>
          <ChevronDown size={14} className={!expanded ? 'rotate' : ''} />
        </button>
        <span className="queue-summary">
          {active.length
            ? `${active.length} in progress`
            : jobs.length
              ? 'All caught up'
              : 'Ready when you are'}
        </span>
        <button
          className="text-button"
          disabled={!jobs.some((job) => !['running', 'queued'].includes(job.state))}
          onClick={async () => {
            try {
              await value(window.cosy.clearJobs());
            } catch (error) {
              onError(error);
            }
          }}
        >
          Clear finished
        </button>
      </header>
      {expanded && (
        <div className="queue-content" tabIndex={0} role="group" aria-label="Transfer items">
          {!jobs.length ? (
            <div className="queue-empty">
              <div>
                <CheckCheck size={20} />
              </div>
              <p>
                No transfers yet
                <span>Select files and copy them to the other pane, or drag them across.</span>
              </p>
            </div>
          ) : (
            [...jobs].reverse().map((job) => (
              <div className={`queue-job ${job.state}`} key={job.id}>
                <div className="job-icon">
                  {job.state === 'running' ? (
                    <LoaderCircle className="spin" size={18} />
                  ) : job.state === 'completed' ? (
                    <Check size={18} />
                  ) : job.state === 'failed' ? (
                    <CircleHelp size={18} />
                  ) : (
                    <File size={18} />
                  )}
                </div>
                <div className="job-main">
                  <div className="job-title">
                    <strong>{job.label}</strong>
                    <span>
                      {job.state === 'completed'
                        ? 'Complete'
                        : job.state === 'failed'
                          ? 'Failed'
                          : job.state === 'cancelled'
                            ? 'Cancelled'
                            : job.mode}
                    </span>
                  </div>
                  <div
                    className="job-path"
                    title={`${job.request.source.path} → ${job.request.destination.path}`}
                  >
                    {job.request.source.path}
                    <ArrowRight size={11} />
                    {job.request.destination.path}
                  </div>
                  {job.state === 'running' && (
                    <progress
                      max={job.total || undefined}
                      value={job.total ? Math.min(job.bytes, job.total) : undefined}
                    />
                  )}
                  {job.error && <p className="job-error">{job.error}</p>}
                </div>
                <span className="job-size">
                  {bytes(job.bytes)}
                  {job.total !== null ? ` / ${bytes(job.total)}` : ''}
                </span>
                {['queued', 'running'].includes(job.state) && (
                  <button
                    className="icon-button"
                    aria-label={`Cancel ${job.label}`}
                    onClick={async () => {
                      try {
                        await value(window.cosy.cancelJob(job.id));
                      } catch (error) {
                        onError(error);
                      }
                    }}
                  >
                    <X size={16} />
                  </button>
                )}
                {['failed', 'cancelled'].includes(job.state) && (
                  <button
                    title="Retry the whole operation; existing completed files may conflict"
                    onClick={async () => {
                      try {
                        await value(window.cosy.retryJob(job.id));
                        onRefresh();
                      } catch (error) {
                        onError(error);
                      }
                    }}
                  >
                    <RefreshCw size={14} />
                    Retry
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
}

function Editor({
  documents,
  selectedId,
  sessions,
  onSelect,
  onDocument,
  onClose,
  onError,
  onRefresh,
}: {
  documents: EditDocument[];
  selectedId: string;
  sessions: SessionInfo[];
  onSelect(id: string): void;
  onDocument(document: EditDocument): void;
  onClose(id: string): Promise<void>;
  onError(error: unknown): void;
  onRefresh(): void;
}) {
  const selected = documents.find((document) => document.id === selectedId) ?? documents[0];
  const [busy, setBusy] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [comparison, setComparison] = useState<EditComparison>();
  const [reviewed, setReviewed] = useState(false);
  const [notice, setNotice] = useState('');
  const revisions = useRef(new Map<string, number>());
  const pending = useRef<Promise<unknown>>(Promise.resolve());
  const textarea = useRef<HTMLTextAreaElement>(null);
  const matching = sessions.filter((session) =>
    selected.profileId ? session.profileId === selected.profileId : session.id === 'local',
  );
  const connected = sessions.some((session) => session.id === selected.location.sessionId);
  const currentComparison = comparison?.documentId === selected.id ? comparison : undefined;
  useEffect(() => {
    setComparison(undefined);
    setReviewed(false);
    setNotice('');
  }, [selected.id]);
  async function compare() {
    setBusy(true);
    setNotice('');
    setReviewed(false);
    try {
      await pending.current.catch(() => {});
      onDocument(
        await value(window.cosy.saveDraft({ id: selected.id, content: selected.content })),
      );
      setComparison(await value(window.cosy.compareEdit(selected.id)));
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }
  async function keepReviewedDraft() {
    if (!currentComparison || !reviewed) return;
    setBusy(true);
    try {
      await pending.current.catch(() => {});
      onDocument(
        await value(window.cosy.saveDraft({ id: selected.id, content: selected.content })),
      );
      onDocument(
        await value(
          window.cosy.reviewEdit({ id: selected.id, revision: currentComparison.revision }),
        ),
      );
      setComparison(undefined);
      setReviewed(false);
      setNotice(
        'Review recorded. Your draft is still local; use Save to server or Save to disk when ready.',
      );
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }
  async function exportCopy() {
    setBusy(true);
    setNotice('');
    try {
      await pending.current.catch(() => {});
      // Export must remain available if recovery storage is full: draft() keeps
      // the latest valid text in main-process memory even when persistence fails.
      const draftResult = await window.cosy.saveDraft({
        id: selected.id,
        content: selected.content,
      });
      if (draftResult.ok) onDocument(draftResult.value);
      const file = await value(window.cosy.exportEdit(selected.id));
      if (file)
        setNotice(
          `Copy saved to ${file}. The original and its unsaved status are unchanged.${draftResult.ok ? '' : ' Recovery storage still needs attention.'}`,
        );
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    try {
      await pending.current.catch(() => {});
      onDocument(
        await value(window.cosy.saveDraft({ id: selected.id, content: selected.content })),
      );
      onDocument(await value(window.cosy.uploadEdit(selected.id)));
      onRefresh();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Text editor"
      wide
      closeLabel="Hide editor (keep working copies)"
      onClose={() => onSelect('')}
    >
      <div className="editor-tabs">
        {documents.map((document) => (
          <div
            key={document.id}
            className={`editor-tab ${selected.id === document.id ? 'selected' : ''}`}
          >
            <button
              aria-pressed={selected.id === document.id}
              disabled={busy}
              onClick={() => onSelect(document.id)}
            >
              <FileCode2 size={14} />
              {document.name}
              {document.dirty && <span className="unsaved-dot" />}
            </button>
            <button
              className="icon-button"
              aria-label={`Close ${document.name}`}
              disabled={busy}
              title="Close this working copy"
              onClick={() => void closeTab(document.id)}
            >
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
      <div className="editor-path">{selected.location.path}</div>
      <div className="editor-tools">
        <button disabled={!connected || busy || savingDraft} onClick={() => void compare()}>
          <Copy size={14} />
          {currentComparison ? 'Refresh comparison' : 'Compare original'}
        </button>
        <button disabled={busy || savingDraft} onClick={() => void exportCopy()}>
          <ArrowDown size={14} />
          Save copy as…
        </button>
        {currentComparison && (
          <button
            disabled={busy}
            onClick={() => {
              setComparison(undefined);
              setReviewed(false);
            }}
          >
            Close comparison
          </button>
        )}
      </div>
      <div className={currentComparison ? 'editor-columns' : ''}>
        {currentComparison && (
          <label className="editor-column">
            <span>Current original · read only</span>
            <textarea
              className="editor-text"
              aria-label={`Current original for ${selected.name}`}
              value={currentComparison.content}
              readOnly
              spellCheck={false}
            />
          </label>
        )}
        <div className="editor-column">
          {currentComparison && <span>Your local draft · edit to merge changes</span>}
          <textarea
            ref={textarea}
            className="editor-text"
            aria-label={`Edit ${selected.name}`}
            spellCheck={false}
            value={selected.content}
            disabled={busy}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === 's') {
                event.preventDefault();
                if (connected && !busy && !savingDraft && !currentComparison?.changed) void save();
              }
              if (event.key === 'Tab') {
                event.preventDefault();
                const element = event.currentTarget;
                const start = element.selectionStart;
                const end = element.selectionEnd;
                const content = `${selected.content.slice(0, start)}  ${selected.content.slice(end)}`;
                change(content);
                requestAnimationFrame(() => {
                  element.selectionStart = element.selectionEnd = start + 2;
                });
              }
            }}
            onChange={(event) => change(event.target.value)}
          />
        </div>
      </div>
      {currentComparison && (
        <div className="comparison-review">
          {currentComparison.changed ? (
            <>
              <p>
                The original changed after this working copy was loaded. Compare both versions and
                edit your local draft to keep the changes you need.
              </p>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={reviewed}
                  disabled={busy || savingDraft}
                  onChange={(event) => setReviewed(event.target.checked)}
                />
                I have reviewed the current original and want to keep my draft.
              </label>
              <button
                disabled={!reviewed || busy || savingDraft}
                onClick={() => void keepReviewedDraft()}
              >
                Keep reviewed draft
              </button>
            </>
          ) : (
            <p>
              The original matches the version this working copy is based on. Saving will still
              check it again.
            </p>
          )}
        </div>
      )}
      {notice && (
        <p className="editor-notice" role="status">
          {notice}
        </p>
      )}
      <div className="editor-footer">
        <span className="editor-status" aria-live="polite">
          {savingDraft ? (
            <LoaderCircle size={14} className="spin" />
          ) : selected.dirty ? (
            <Pencil size={14} />
          ) : (
            <Check size={14} />
          )}
          {savingDraft ? 'Saving recovery copy…' : selected.status}
        </span>
        <span>UTF-8 · {bytes(new TextEncoder().encode(selected.content).length)}</span>
      </div>
      <div className="modal-actions editor-actions">
        {!connected && matching.length > 0 && (
          <button
            disabled={busy}
            onClick={async () => {
              try {
                onDocument(
                  await value(
                    window.cosy.rebindEdit({ id: selected.id, sessionId: matching[0].id }),
                  ),
                );
              } catch (error) {
                onError(error);
              }
            }}
          >
            <Link2 size={14} />
            Use reconnected session
          </button>
        )}
        <p className="form-hint">
          {!connected
            ? 'Reconnect the saved connection to upload this recovered draft.'
            : 'Edits stay on this computer until you save to the original.'}
        </p>
        <button
          disabled={!connected || busy || savingDraft || Boolean(currentComparison?.changed)}
          className="primary"
          onClick={() => void save()}
        >
          {busy ? 'Working…' : selected.profileId ? 'Save to server' : 'Save to disk'}
        </button>
      </div>
    </Modal>
  );
  async function closeTab(id: string) {
    setBusy(true);
    try {
      await pending.current.catch(() => {});
      await onClose(id);
    } finally {
      setBusy(false);
    }
  }
  function change(content: string) {
    if (new TextEncoder().encode(content).length > 10 * 1024 * 1024 || content.includes('\0')) {
      onError(new Error('The editor accepts UTF-8 text up to 10 MiB, without NUL characters.'));
      return;
    }
    const id = selected.id;
    setNotice('');
    const revision = (revisions.current.get(id) ?? 0) + 1;
    revisions.current.set(id, revision);
    onDocument({ ...selected, content, dirty: true, status: 'Saving recovery copy…' });
    setSavingDraft(true);
    const task = value(window.cosy.saveDraft({ id, content }))
      .then((document) => {
        if (revisions.current.get(id) === revision) {
          onDocument(document);
          setSavingDraft(false);
        }
      })
      .catch((error) => {
        setSavingDraft(false);
        if (revisions.current.get(id) === revision)
          onDocument({
            ...selected,
            content,
            dirty: true,
            status: 'Recovery write failed — keep the editor open',
          });
        onError(error);
        throw error;
      });
    pending.current = task;
    void task.catch(() => {});
  }
}

function TrustedServers({
  onClose,
  protocol = 'sftp',
}: {
  onClose(): void;
  protocol?: 'sftp' | 'ftps';
}) {
  const ftps = protocol === 'ftps';
  const [hosts, setHosts] = useState<TrustedHost[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function refresh() {
    setLoading(true);
    setError('');
    try {
      setHosts(await value(ftps ? window.cosy.trustedCertificates() : window.cosy.trustedHosts()));
    } catch (error) {
      setError(message(error));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  return (
    <Modal
      title={ftps ? 'Trusted FTPS certificates' : 'Trusted SSH servers'}
      wide
      onClose={() => !busy && onClose()}
    >
      <p className="modal-description">
        {ftps ? (
          'These are exact FTPS certificates you have explicitly trusted for a server and port. A replacement requires a new review. Expired certificates are refused. Windows certificate trust is unchanged.'
        ) : (
          <>
            These fingerprints identify SFTP servers you have explicitly trusted. If an
            administrator replaces a server key, verify the new fingerprint through a trusted
            channel before accepting it.
          </>
        )}
      </p>
      <button disabled={loading || busy} onClick={() => void refresh()}>
        <RefreshCw size={14} />
        Refresh trusted servers
      </button>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <p role="status" className="form-hint">
          Loading trusted servers…
        </p>
      ) : hosts.length ? (
        <ul className="trusted-hosts">
          {hosts.map((host) => (
            <li key={host.host}>
              <div>
                <strong>{host.host}</strong>
                <code>{host.fingerprint}</code>
                <small>
                  {host.connected
                    ? 'Disconnect this server’s open sessions before forgetting its fingerprint.'
                    : 'No open sessions for this server.'}
                </small>
              </div>
              <button
                disabled={busy || host.connected}
                aria-label={`Forget trust for ${host.host}`}
                onClick={async () => {
                  setBusy(true);
                  setError('');
                  try {
                    if (
                      await value(
                        ftps
                          ? window.cosy.forgetCertificate(host.host)
                          : window.cosy.forgetHost(host.host),
                      )
                    )
                      await refresh();
                  } catch (error) {
                    setError(message(error));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Trash2 size={14} />
                Forget trust
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="form-hint">
          {ftps
            ? 'No FTPS certificate exceptions saved. Certificates that pass normal validation do not need an exception.'
            : 'No trusted SSH servers yet. SFTP connections ask you to verify a server fingerprint on first use.'}
        </p>
      )}
      <p className="form-hint">
        {ftps
          ? 'SSH host keys are managed separately under Trusted SSH servers.'
          : 'FTPS certificates are managed separately under Trusted FTPS certificates.'}
      </p>
    </Modal>
  );
}

export default function App() {
  const [initial, setInitial] = useState<InitialState>();
  const [fatal, setFatal] = useState('');
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [jobs, setJobs] = useState<TransferJob[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [documents, setDocuments] = useState<EditDocument[]>([]);
  const [editorId, setEditorId] = useState('');
  const [theme, setTheme] = useState(() => localStorage.getItem('cosy-theme') ?? 'dark');
  const [active, setActive] = useState<'left' | 'right'>('left');
  const [leftTarget, setLeftTarget] = useState<SessionInfo>();
  const [rightTarget, setRightTarget] = useState<SessionInfo>();
  const [left, setLeft] = useState<PaneSelection>();
  const [right, setRight] = useState<PaneSelection>();
  const [refresh, setRefresh] = useState(0);
  const [connectionForm, setConnectionForm] = useState<Profile | 'new' | null>(null);
  const [connecting, setConnecting] = useState<{ profile: Profile; side: 'left' | 'right' }>();
  const [connectBusy, setConnectBusy] = useState(false);
  const connectionInFlight = useRef(false);
  const [usingSavedPassword, setUsingSavedPassword] = useState(false);
  const [connectError, setConnectError] = useState('');
  const [password, setPassword] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [notification, setNotification] = useState('');
  const [showLogs, setShowLogs] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showAppearance, setShowAppearance] = useState(false);
  const [showTrustedServers, setShowTrustedServers] = useState(false);
  const [showTrustedCertificates, setShowTrustedCertificates] = useState(false);
  const [reconnecting, setReconnecting] = useState<string[]>([]);
  const [connectionMenu, setConnectionMenu] = useState<string>();
  const refreshAll = useCallback(() => setRefresh((previous) => previous + 1), []);
  const onError = useCallback((error: unknown) => setNotification(message(error)), []);
  async function reconnect(id: string) {
    setReconnecting((previous) => [...previous, id]);
    try {
      const session = await value(window.cosy.reconnect(id));
      setSessions((previous) => previous.map((item) => (item.id === id ? session : item)));
      refreshAll();
    } finally {
      setReconnecting((previous) => previous.filter((item) => item !== id));
    }
  }
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('cosy-theme', theme);
  }, [theme]);
  useEffect(() => {
    let mounted = true;
    if (!window.cosy) {
      setFatal(
        'Open Cosy FTP with the desktop launcher. Filesystem access is available only inside the desktop app.',
      );
      return;
    }
    value(window.cosy.initialise())
      .then((state) => {
        if (!mounted) return;
        setInitial(state);
        setProfiles(state.profiles);
        setSessions(state.sessions);
        setJobs(state.jobs);
        setLogs(state.logs);
        setDocuments(state.documents);
      })
      .catch((error) => setFatal(message(error)));
    const unsubscribeJobs = window.cosy.onJobs((jobs) => {
      setJobs(jobs);
      if (jobs.some((job) => job.finishedAt && Date.now() - job.finishedAt < 1500)) refreshAll();
    });
    const unsubscribeLogs = window.cosy.onLog((log) =>
      setLogs((previous) => [...previous.slice(-199), log]),
    );
    return () => {
      mounted = false;
      unsubscribeJobs();
      unsubscribeLogs();
    };
  }, [refreshAll]);
  const updateDocument = useCallback(
    (document: EditDocument) =>
      setDocuments((previous) =>
        previous.some((item) => item.id === document.id)
          ? previous.map((item) => (item.id === document.id ? document : item))
          : [...previous, document],
      ),
    [],
  );
  async function openEditor(location: Location) {
    try {
      const document = await value(window.cosy.openEditor(location));
      updateDocument(document);
      setEditorId(document.id);
    } catch (error) {
      onError(error);
    }
  }
  async function closeDocument(id: string) {
    try {
      if (await value(window.cosy.closeEdit(id))) {
        const index = documents.findIndex((document) => document.id === id);
        const next = documents[index + 1] ?? documents[index - 1];
        setDocuments((previous) => previous.filter((document) => document.id !== id));
        setEditorId((current) => (current === id ? (next?.id ?? '') : current));
      }
    } catch (error) {
      onError(error);
    }
  }
  function connect(profile: Profile, side: 'left' | 'right' = 'right') {
    if (connectionInFlight.current) return;
    const request = { profile, side };
    setConnecting(request);
    setPassword('');
    setConnectError('');
    setUsingSavedPassword(profile.hasPassword);
    if (profile.hasPassword) void openConnection(request);
  }
  async function openConnection(
    request: { profile: Profile; side: 'left' | 'right' },
    enteredPassword?: string,
  ) {
    if (connectionInFlight.current) return;
    connectionInFlight.current = true;
    setConnectBusy(true);
    setConnectError('');
    try {
      const session = await value(
        window.cosy.connect({ profileId: request.profile.id, password: enteredPassword }),
      );
      setSessions((previous) => [...previous, session]);
      if (request.side === 'left') setLeftTarget(session);
      else setRightTarget(session);
      setConnecting(undefined);
      setPassword('');
    } catch (error) {
      setUsingSavedPassword(false);
      setConnectError(message(error));
    } finally {
      connectionInFlight.current = false;
      setConnectBusy(false);
    }
  }
  async function doConnect() {
    if (connecting) await openConnection(connecting, password || undefined);
  }
  async function transfer(side: 'left' | 'right', names?: string[], move = false) {
    const source = side === 'left' ? left : right;
    const destination = side === 'left' ? right : left;
    if (!source?.ready || !destination?.ready) {
      onError(new Error('Open a readable folder in both panes before transferring.'));
      return;
    }
    const selected = names ?? source.entries.map((entry) => entry.name);
    if (!selected.length) return;
    try {
      await value(
        window.cosy.enqueue({
          source: source.location,
          destination: destination.location,
          names: selected,
          overwrite,
          move,
        }),
      );
    } catch (error) {
      onError(error);
    }
  }
  if (fatal)
    return (
      <div className="startup">
        <BrandMark size={40} />
        <h1>Cosy FTP</h1>
        <p role="alert">{fatal}</p>
      </div>
    );
  if (!initial)
    return (
      <div className="startup">
        <BrandMark size={40} />
        <h1>Getting comfortable…</h1>
        <LoaderCircle className="spin" />
      </div>
    );
  const current = active === 'left' ? left : right;
  const activeCount = jobs.filter((job) => ['running', 'queued'].includes(job.state)).length;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <BrandMark size={22} />
          </div>
          <span>
            cosy<span className="brand-ftp">ftp</span>
            <small>A calmer connection.</small>
          </span>
        </div>
        <div className="sidebar-places">
          <div className="sidebar-section-heading">
            YOUR PLACES
            <button
              className="icon-button"
              title="Add connection"
              aria-label="Add connection"
              onClick={() => setConnectionForm('new')}
            >
              <Plus size={16} />
            </button>
          </div>
          <button
            className="place local-place"
            onClick={() => {
              const local = { ...sessions.find((session) => session.id === 'local')! };
              if (active === 'left') setLeftTarget(local);
              else setRightTarget(local);
            }}
          >
            <HardDrive size={17} />
            <span>
              This computer<small>Your local files</small>
            </span>
          </button>
          <div className="sidebar-divider" />
          <div className="sidebar-section-heading saved-heading">
            SAVED CONNECTIONS<span>{profiles.length.toString().padStart(2, '0')}</span>
          </div>
          <div className="saved-connections">
            {profiles.length ? (
              profiles.map((profile) => (
                <div className="connection-item" key={profile.id}>
                  <button className="place" onClick={() => connect(profile)}>
                    <Server size={17} />
                    <span>
                      {profile.name}
                      <small>
                        {profile.protocol.toUpperCase()} · {profile.host}
                      </small>
                    </span>
                    <span
                      className={`status-dot ${sessions.some((session) => session.profileId === profile.id) ? 'online' : ''}`}
                    />
                  </button>
                  <button
                    className="connection-more icon-button"
                    aria-label={`Options for ${profile.name}`}
                    onClick={() =>
                      setConnectionMenu(connectionMenu === profile.id ? undefined : profile.id)
                    }
                  >
                    <MoreHorizontal size={16} />
                  </button>
                  {connectionMenu === profile.id && (
                    <div className="connection-options">
                      <button
                        onClick={() => {
                          setConnectionMenu(undefined);
                          setConnectionForm(profile);
                        }}
                      >
                        <Pencil size={13} />
                        Edit
                      </button>
                      <button
                        onClick={async () => {
                          setConnectionMenu(undefined);
                          try {
                            await value(window.cosy.deleteProfile(profile.id));
                            setProfiles((previous) =>
                              previous.filter((item) => item.id !== profile.id),
                            );
                          } catch (error) {
                            onError(error);
                          }
                        }}
                      >
                        <Trash2 size={13} />
                        Remove
                      </button>
                    </div>
                  )}
                </div>
              ))
            ) : (
              <div className="no-connections">
                <Server size={23} />
                <p>
                  Your familiar servers,
                  <br />
                  one quiet little list.
                </p>
                <button onClick={() => setConnectionForm('new')}>
                  <Plus size={13} />
                  Add a connection
                </button>
              </div>
            )}
          </div>
          {sessions.some((session) => session.id !== 'local') && (
            <div className="session-list">
              <div className="sidebar-section-heading">OPEN SESSIONS</div>
              {sessions
                .filter((session) => session.id !== 'local')
                .map((session) => (
                  <div key={session.id}>
                    <span>{session.label}</span>
                    <button
                      className="icon-button"
                      title="Reconnect session"
                      aria-label={`Reconnect ${session.label}`}
                      disabled={reconnecting.includes(session.id)}
                      onClick={() => void reconnect(session.id).catch(onError)}
                    >
                      <RefreshCw
                        size={14}
                        className={reconnecting.includes(session.id) ? 'spin' : ''}
                      />
                    </button>
                    <button
                      className="icon-button"
                      title="Disconnect session"
                      aria-label={`Disconnect ${session.label}`}
                      onClick={async () => {
                        try {
                          await value(window.cosy.disconnect(session.id));
                          setSessions((previous) =>
                            previous.filter((item) => item.id !== session.id),
                          );
                        } catch (error) {
                          onError(error);
                        }
                      }}
                    >
                      <Unplug size={14} />
                    </button>
                  </div>
                ))}
            </div>
          )}
        </div>
        <div className="sidebar-bottom">
          <button onClick={() => setShowTrustedServers(true)}>
            <ShieldCheck size={16} />
            Trusted SSH servers
          </button>
          <button onClick={() => setShowTrustedCertificates(true)}>
            <ShieldCheck size={16} />
            Trusted FTPS certificates
          </button>
          <div className="comfort-note">
            <ShieldCheck size={17} />
            <p>
              A little peace of mind.
              <span>
                Secure connections. Clear actions.
                <br />
                Your files stay yours.
              </span>
            </p>
          </div>
          <button onClick={() => setShowHelp(true)}>
            <CircleHelp size={16} />A little help
          </button>
          <button onClick={() => setShowAppearance(true)}>
            <Settings2 size={16} />
            Appearance
          </button>
          <WolfUpdate
            version={initial.version}
            dialog={(children, close) => (
              <Modal title="About Cosy FTP" onClose={close}>
                {children}
              </Modal>
            )}
          />
          <div className="sidebar-version">
            COSY FTP <span>v{initial.version} · beta</span>
          </div>
        </div>
      </aside>
      <main className="workspace">
        <header className="workspace-header">
          <h1>File workspace</h1>
          <div className="transfer-actions">
            <label className="replace-toggle">
              <input
                type="checkbox"
                checked={overwrite}
                onChange={(event) => setOverwrite(event.target.checked)}
              />
              Replace existing
            </label>
            <button
              disabled={!current?.entries.length}
              onClick={() => void transfer(active, undefined, true)}
              title="Move within the same server or local filesystem"
            >
              Move {active === 'left' ? <ArrowRight size={14} /> : <ArrowLeft size={14} />}
            </button>
            <button
              className="copy-button"
              disabled={!current?.entries.length}
              onClick={() => void transfer(active)}
            >
              <Copy size={14} />
              Copy {active === 'left' ? <ArrowRight size={14} /> : <ArrowLeft size={14} />}
            </button>
          </div>
          <button className="primary new-connection" onClick={() => setConnectionForm('new')}>
            <Plus size={16} />
            New connection
          </button>
        </header>
        <div className="panes">
          <FilePane
            onReconnect={reconnect}
            side="left"
            home={initial.home}
            sessions={sessions}
            profiles={profiles}
            active={active === 'left'}
            target={leftTarget}
            refresh={refresh}
            onActive={() => setActive('left')}
            onSelection={setLeft}
            onConnect={connect}
            onEdit={openEditor}
            onError={onError}
            onTransfer={transfer}
          />
          <div className="pane-divider">
            <span />
          </div>
          <FilePane
            onReconnect={reconnect}
            side="right"
            home={initial.home}
            sessions={sessions}
            profiles={profiles}
            active={active === 'right'}
            target={rightTarget}
            refresh={refresh}
            onActive={() => setActive('right')}
            onSelection={setRight}
            onConnect={connect}
            onEdit={openEditor}
            onError={onError}
            onTransfer={transfer}
          />
        </div>
        <div className="workspace-hint">
          <span>
            <ShieldCheck size={13} />
            Existing files are protected
            {overwrite ? ' unless replacement is confirmed.' : ' by default.'}
          </span>
          <span>Select a text file and choose Edit. Double-click folders to explore.</span>
        </div>
        {documents.length > 0 && (
          <div className="recovery-strip">
            <FileCode2 size={15} />
            <span>
              {documents.length} working {documents.length === 1 ? 'copy' : 'copies'}
              {documents.some((document) => document.dirty) ? ' · includes local edits' : ''}
            </span>
            <button className="text-button" onClick={() => setEditorId(documents[0].id)}>
              Open editor
              <ArrowRight size={13} />
            </button>
          </div>
        )}
        <Queue jobs={jobs} onError={onError} onRefresh={refreshAll} />
        <footer className="status-bar">
          <span>
            <span className="live-dot" />
            {activeCount
              ? `${activeCount} active ${activeCount === 1 ? 'transfer' : 'transfers'}`
              : 'Everything is quiet'}
            <span className="status-separator">/</span>
            {sessions.length - 1} remote {sessions.length === 2 ? 'session' : 'sessions'}
          </span>
          <button onClick={() => setShowLogs(!showLogs)}>
            <Terminal size={13} />
            Connection log
            {logs.some((log) => log.level === 'error') && <span className="log-dot" />}
          </button>
        </footer>
      </main>
      {notification &&
        createPortal(
          <div className="toast" role="alert">
            <CircleHelp size={19} />
            <p>{notification}</p>
            <button
              className="icon-button"
              aria-label="Dismiss message"
              onClick={() => setNotification('')}
            >
              <X size={17} />
            </button>
          </div>,
          document.body,
        )}
      {connectionForm && (
        <ConnectionForm
          existing={connectionForm === 'new' ? undefined : connectionForm}
          canStore={initial.canStorePasswords}
          onClose={() => setConnectionForm(null)}
          onSave={async (input) => {
            const saved = await value(window.cosy.saveProfile(input));
            setProfiles((previous) => [
              ...previous.filter((profile) => profile.id !== saved.id),
              saved,
            ]);
            setConnectionForm(null);
          }}
        />
      )}
      {connecting && (
        <Modal
          title={`Connect to ${connecting.profile.name}`}
          onClose={() => !connectBusy && setConnecting(undefined)}
        >
          <p className="modal-description">
            Open {connecting.profile.protocol.toUpperCase()} · {connecting.profile.host}:
            {connecting.profile.port} in the {connecting.side} pane.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void doConnect();
            }}
          >
            {usingSavedPassword ? (
              <p className="form-hint" role="status">
                Connecting with your saved password...
              </p>
            ) : (
              <label className="field">
                Password
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  placeholder={
                    connecting.profile.hasPassword
                      ? 'Enter a password to try again'
                      : 'Enter your password'
                  }
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={connectBusy}
                />
              </label>
            )}
            {connecting.profile.protocol === 'ftp' && (
              <p className="warning form-hint">This connection is unencrypted.</p>
            )}
            {connectError && (
              <p className="form-error" role="alert">
                {connectError}
              </p>
            )}
            <div className="modal-actions">
              <button type="button" disabled={connectBusy} onClick={() => setConnecting(undefined)}>
                Cancel
              </button>
              <button className="primary" disabled={connectBusy}>
                {connectBusy ? (
                  <>
                    <LoaderCircle size={14} className="spin" />
                    Connecting…
                  </>
                ) : (
                  'Connect'
                )}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {showLogs && (
        <Modal title="Connection log" wide onClose={() => setShowLogs(false)}>
          <p className="modal-description">
            Recent session events. Passwords and protocol authentication traffic are never logged.
          </p>
          <div className="log-entries">
            {logs.map((log, index) => (
              <div className={log.level} key={index}>
                <time>{new Date(log.time).toLocaleTimeString()}</time>
                <span>{log.message}</span>
              </div>
            ))}
          </div>
        </Modal>
      )}
      {showHelp && (
        <Modal title="Make yourself comfortable" onClose={() => setShowHelp(false)}>
          <div className="help-content">
            <p>
              Each pane can browse this computer or its own remote session. Add a saved connection,
              then choose it from either pane.
            </p>
            <p>
              Select files with their checkboxes, then use <strong>Copy</strong> or drag them to the
              other pane. Copying between servers streams through this computer.
            </p>
            <p>
              <strong>Move</strong> works within the same server or local filesystem. Destination
              names must be unused. Delete is permanent; non-empty folders and their contents are
              deleted recursively after confirmation.
            </p>
            <p>
              Select a file and choose Edit, or double-click a UTF-8 text file (up to 10 MiB),
              including JSON. Edits are saved as local recovery copies. Use{' '}
              <strong>Save to server</strong> or <strong>Ctrl+S</strong> to upload explicitly.
              Changed originals are protected.
            </p>
            <p>
              Use <strong>Ctrl+A</strong> in the file list to select visible items,{' '}
              <strong>Enter</strong> on a filename to open it, and <strong>Backspace</strong> in the
              list to go up.
            </p>
            <p className="warning">
              Preview build: keep backups of important files. Interrupted folder copies keep files
              already completed. No automatic resume, SSH keys, or advanced permission editing yet.
            </p>
          </div>
        </Modal>
      )}
      {showAppearance && (
        <Modal title="Appearance" onClose={() => setShowAppearance(false)}>
          <p className="modal-description">
            Choose the colours that feel comfortable. Your choice is remembered.
          </p>
          <fieldset className="theme-options">
            <legend>Colour theme</legend>
            <label>
              <input
                type="radio"
                name="theme"
                checked={theme === 'light'}
                onChange={() => setTheme('light')}
              />
              <Sun size={18} />
              <span>
                Warm light<small>Soft cream backgrounds and darker text.</small>
              </span>
            </label>
            <label>
              <input
                type="radio"
                name="theme"
                checked={theme === 'dark'}
                onChange={() => setTheme('dark')}
              />
              <Moon size={18} />
              <span>
                Muted dark<small>Slate backgrounds with soft blue accents.</small>
              </span>
            </label>
          </fieldset>
          <div className="modal-actions">
            <button className="primary" onClick={() => setShowAppearance(false)}>
              Done
            </button>
          </div>
        </Modal>
      )}
      {showTrustedServers && <TrustedServers onClose={() => setShowTrustedServers(false)} />}
      {showTrustedCertificates && (
        <TrustedServers protocol="ftps" onClose={() => setShowTrustedCertificates(false)} />
      )}
      {editorId && documents.length > 0 && (
        <Editor
          documents={documents}
          selectedId={editorId}
          sessions={sessions}
          onSelect={setEditorId}
          onDocument={updateDocument}
          onClose={closeDocument}
          onError={onError}
          onRefresh={refreshAll}
        />
      )}
    </div>
  );
}
