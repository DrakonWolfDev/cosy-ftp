import { useEffect, useRef, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { createPortal } from 'react-dom';
import { CircleHelp } from 'lucide-react';
import cosyLogo from '../build/icon.svg';

type Update = { status: string; version?: string; notes?: string };
const command = <T,>(operation: string, input: unknown = null) =>
  invoke<T>('dispatch', { operation, input });

export function WolfUpdate({
  version,
  dialog,
}: {
  version: string;
  dialog: (children: ReactNode, close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [automatic, setAutomatic] = useState(
    () => localStorage.getItem('cosy-auto-updates') !== 'false',
  );
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [update, setUpdate] = useState<Update>();
  const checking = useRef(false);
  async function check(manual: boolean) {
    if (checking.current) return;
    checking.current = true;
    setBusy(true);
    if (manual) setStatus('Checking GitHub for updates…');
    try {
      const result = await command<Update>('check-updates', { manual });
      if (result.status === 'available') {
        setUpdate(result);
        setStatus(`Version ${result.version} is available.`);
      } else if (manual && result.status === 'not_published') {
        setStatus(
          'Public update information is not available yet. Please try again after the first public release.',
        );
      } else if (manual) {
        setUpdate(undefined);
        setStatus(`Version ${version} is the newest applicable release.`);
      }
    } catch (error) {
      if (manual) setStatus(String(error));
    } finally {
      checking.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!automatic) return;
    const timer = window.setTimeout(() => void check(false), 5000);
    const interval = window.setInterval(() => void check(false), 24 * 60 * 60 * 1000);
    return () => {
      clearTimeout(timer);
      clearInterval(interval);
    };
  }, [automatic]);
  async function projectPage() {
    try {
      await command('open-project-page');
    } catch (error) {
      setStatus(String(error));
      setOpen(true);
    }
  }
  async function dismiss() {
    try {
      await command('dismiss-update', update?.version);
      setUpdate(undefined);
    } catch (error) {
      setStatus(String(error));
      setOpen(true);
    }
  }
  return (
    <>
      <button onClick={() => setOpen(true)}>
        <CircleHelp size={16} />
        About Cosy FTP{update ? ' · Update available' : ''}
      </button>
      {update &&
        createPortal(
          <aside className="wolf-update-banner" aria-label="Wolf Update" role="status">
            <strong>Cosy FTP {update.version} is available</strong>
            <div>
              <button onClick={() => setOpen(true)}>What’s new</button>
              <button onClick={() => void projectPage()}>View update</button>
              <button onClick={() => void dismiss()}>Dismiss version</button>
            </div>
          </aside>,
          document.body,
        )}
      {open &&
        dialog(
          <div className="about-cosy">
            <div className="about-brand">
              <img src={cosyLogo} alt="Cosy FTP two-pane transfer logo" width="112" height="112" />
              <div>
                <p className="about-eyebrow">FILE TRANSFERS, A LITTLE CALMER</p>
                <h3>Cosy FTP</h3>
                <p>Version {version} · Beta</p>
              </div>
            </div>
            <p>
              A calm place for your files. Two independent panes, secure connections and a text
              editor that keeps your working copies close.
            </p>
            <p>
              Built for Windows and Linux with Rust, Tauri and React. Created by Andrew Hodgson at
              Wolf Forge.
            </p>
            <p className="form-hint">Licensed under GNU AGPL version 3 only. © 2026 Wolf Forge.</p>
            <section className="about-updates" aria-labelledby="wolf-update-heading">
              <h3 id="wolf-update-heading">Wolf Update</h3>
              <p>
                Checks the official Cosy FTP GitHub releases, including betas. View update opens
                the Wolf Forge project page. Downloads and installation stay in your hands.
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={automatic}
                  onChange={(event) => {
                    setAutomatic(event.target.checked);
                    localStorage.setItem('cosy-auto-updates', String(event.target.checked));
                  }}
                />{' '}
                Check automatically once a day
              </label>
              <p className="form-hint">
                Update checks contact GitHub. No connection profiles, passwords or file contents are
                sent.
              </p>
              <p role="status">{status}</p>
              {update?.notes && <pre className="update-notes">{update.notes}</pre>}
              <div className="modal-actions">
                <button disabled={busy} onClick={() => void check(true)}>
                  {busy ? 'Checking…' : 'Check for updates'}
                </button>
                <button onClick={() => void projectPage()}>Wolf Forge project page</button>
              </div>
            </section>
            <p className="about-forge">
              A WOLF FORGE PROJECT <span aria-hidden="true">🐾</span>
            </p>
          </div>,
          () => setOpen(false),
        )}
    </>
  );
}
