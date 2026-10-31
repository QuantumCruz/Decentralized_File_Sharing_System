import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import './App.css';

const MAX_FILES = 100;
const MAX_BYTES = 5 * 1024 ** 3;

const symbols = {
  upload: <><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></>,
  file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h6"/></>,
  shield: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/></>,
  link: <><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></>,
  copy: <><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
  close: <><path d="M18 6 6 18M6 6l12 12"/></>,
  refresh: <><path d="M20 11a8 8 0 0 0-14.7-4.3L3 9"/><path d="M3 3v6h6"/><path d="M4 13a8 8 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/><path d="M20 11a8 8 0 0 0-14.7-4.3L3 9"/><path d="M3 3v6h6"/><path d="M4 13a8 8 0 0 0 14.7 4.3L21 15"/><path d="M15 15h6v6"/></>,
  stop: <><circle cx="12" cy="12" r="9"/><rect x="9" y="9" width="6" height="6" rx="1"/></>,
  qr: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM21 14v4M17 21h4M14 21v-2"/></>,
  globe: <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a16 16 0 0 1 0 18M12 3a16 16 0 0 0 0 18"/></>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  arrow: <><path d="M5 12h14M13 6l6 6-6 6"/></>,
  sparkle: <><path d="m12 3 1.8 6.2L20 11l-6.2 1.8L12 19l-1.8-6.2L4 11l6.2-1.8L12 3Z"/><path d="m19 18 .6 1.4L21 20l-1.4.6L19 22l-.6-1.4L17 20l1.4-.6L19 18Z"/></>,
};

function Icon({ name, size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {symbols[name] || symbols.file}
    </svg>
  );
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length);
  return `${(bytes / (1024 ** exponent)).toFixed(exponent > 1 ? 2 : 1)} ${units[exponent - 1]}`;
}

function formatDate(seconds) {
  const timestamp = Number(seconds) * 1000;

  if (!Number.isFinite(timestamp)) {
    return 'Unknown date';
  }

  const date = new Date(timestamp);

  if (Number.isNaN(date.getTime())) {
    return 'Unknown date';
  }

  try {
    return date.toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short'
    });
  } catch (_) {
    return date.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  }
}

function stageLabel(stage) {
  const labels = {
    connecting: 'Establishing secure connection',
    encrypting: 'Encrypting your files',
    'uploading to IPFS': 'Publishing encrypted file',
    finalizing: 'Preparing your private links',
    complete: 'Ready to share'
  };
  return labels[stage] || (stage ? stage.charAt(0).toUpperCase() + stage.slice(1) : 'Preparing upload');
}

function App() {
  const inputRef = useRef(null);
  const socketRef = useRef(null);

  const [files, setFiles] = useState([]);
  const [zipName, setZipName] = useState('bundle.zip');
  const [maxDownloads, setMaxDownloads] = useState(1);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [transfer, setTransfer] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copiedUrl, setCopiedUrl] = useState('');
  const [shareLinks, setShareLinks] = useState([]);
  const [qrUrl, setQrUrl] = useState('');
  const [stoppingId, setStoppingId] = useState('');
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState('');
  const [sortOrder, setSortOrder] = useState('desc');
  const [dateRange, setDateRange] = useState({ from: '', to: '' });
  const [online, setOnline] = useState(navigator.onLine);

  const totalBytes = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files]);

  const refreshHistory = useCallback(async () => {
    try {
      const response = await fetch('/history', { cache: 'no-store' });
      if (!response.ok) throw new Error(`History unavailable (${response.status})`);
      const data = await response.json();
      if (!Array.isArray(data)) throw new Error('Unexpected history response');
      setHistory(data);
      setHistoryError('');
    } catch (err) {
      setHistoryError(err.message || 'Unable to load history');
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshHistory();
    const timer = window.setInterval(refreshHistory, 10000);
    const connected = () => setOnline(true);
    const disconnected = () => setOnline(false);
    window.addEventListener('online', connected);
    window.addEventListener('offline', disconnected);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('online', connected);
      window.removeEventListener('offline', disconnected);
      socketRef.current?.close();
    };
  }, [refreshHistory]);

  const filteredHistory = useMemo(() => {
    const from = dateRange.from ? new Date(`${dateRange.from}T00:00:00`).getTime() : -Infinity;
    const to = dateRange.to ? new Date(`${dateRange.to}T23:59:59.999`).getTime() : Infinity;
    return history
      .filter(item => item.expires_at * 1000 >= from && item.expires_at * 1000 <= to)
      .sort((a, b) => sortOrder === 'asc' ? a.expires_at - b.expires_at : b.expires_at - a.expires_at);
  }, [history, dateRange, sortOrder]);

  const activeRecordById = useMemo(
    () => new Map(history.map(item => [item.share_id, item.active])),
    [history]
  );

  const recentShares = useMemo(() => {
    const grouped = new Map();
    for (const link of shareLinks) {
      if (!grouped.has(link.share_id)) {
        grouped.set(link.share_id, {
          shareId: link.share_id,
          filename: link.filename,
          max: link.max_downloads,
          links: []
        });
      }
      grouped.get(link.share_id).links.push(link);
    }
    return [...grouped.values()].filter(
      share => activeRecordById.get(share.shareId) !== false
    );
  }, [shareLinks, activeRecordById]);

  const chooseFiles = selection => {
    if (uploading) return;
    const selected = Array.from(selection || []);
    setFiles(selected);
    setError('');
    setNotice('');
    setTransfer(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  const handleDrop = event => {
    event.preventDefault();
    setDragging(false);
    if (uploading) return;
    const folder = Array.from(event.dataTransfer.items || []).some(item =>
      item.kind === 'file' && item.webkitGetAsEntry?.()?.isDirectory
    );
    if (folder) {
      setError('Please select files, not folders. Multiple files are bundled into a ZIP automatically.');
      return;
    }
    chooseFiles(event.dataTransfer.files);
  };

  const removeFile = index => {
    if (uploading) return;
    setFiles(current => current.filter((_, i) => i !== index));
    setError('');
  };

  const copy = async url => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedUrl(url);
      setNotice('Link copied to clipboard');
      setError('');
    } catch (_) {
      setError('Could not copy automatically. Select the link and copy it manually.');
    }
  };

  const upload = async () => {
    if (uploading || !files.length) return;
    if (files.length > MAX_FILES) {
      setError(`Choose up to ${MAX_FILES} files at a time.`);
      return;
    }
    if (totalBytes > MAX_BYTES) {
      setError('Your selected files exceed the 5 GB upload limit.');
      return;
    }
    if (files.length > 1 && new Set(files.map(file => file.name)).size !== files.length) {
      setError('Two selected files have the same name. Please rename one before bundling.');
      return;
    }
    if (files.length > 1 && !zipName.trim()) {
      setError('Enter a name for your ZIP file.');
      return;
    }

    setUploading(true);
    setError('');
    setNotice('');
    setTransfer({ progress: 0, stage: 'connecting' });

    const shareId = window.crypto.randomUUID().replace(/-/g, '');
    const socketUrl = new URL(`/ws/progress/${shareId}`, window.location.origin);
    socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket;

    try {
      socket = new WebSocket(socketUrl.toString());
      socketRef.current = socket;
      await new Promise((resolve, reject) => {
        let opened = false;
        const timeout = window.setTimeout(() => {
          if (opened) return;
          socket.close();
          reject(new Error('The transfer connection timed out. Please try again.'));
        }, 12000);
        socket.addEventListener('open', () => {
          opened = true;
          window.clearTimeout(timeout);
          resolve();
        }, { once: true });
        socket.addEventListener('error', () => {
          if (!opened) {
            window.clearTimeout(timeout);
            reject(new Error('Unable to establish the transfer connection.'));
          }
        }, { once: true });
        socket.addEventListener('message', event => {
          try {
            const data = JSON.parse(event.data);
            setTransfer(previous => ({
              progress: typeof data.progress === 'number'
                ? Math.max(0, Math.min(100, data.progress))
                : (previous?.progress || 0),
              stage: data.status || previous?.stage || 'encrypting'
            }));
          } catch (_) {
            // Ignore invalid progress notifications; the HTTP request remains authoritative.
          }
        });
      });

      const params = new URLSearchParams({
        share_id: shareId,
        max_downloads: String(maxDownloads)
      });
      if (files.length > 1) params.set('zip_name', zipName.trim());

      const body = new FormData();
      files.forEach(file => body.append('files', file, file.name));
      const response = await fetch(`/upload?${params.toString()}`, { method: 'POST', body });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Upload failed (${response.status})`);
      if (!Array.isArray(data.share_links) || !data.share_links.length) {
        throw new Error('Upload completed but no sharing link was returned.');
      }

      setShareLinks(current => [...data.share_links, ...current]);
      setTransfer({ progress: 100, stage: 'complete' });
      setNotice('File encrypted and ready to share. Copy a link below.');
      setFiles([]);
      setZipName('bundle.zip');
      await refreshHistory();
    } catch (err) {
      setError(err.message || 'Unable to upload your file');
      setTransfer(null);
    } finally {
      if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
      socketRef.current = null;
      setUploading(false);
    }
  };

  const stopShare = async shareId => {
    if (stoppingId) return;
    if (!window.confirm('Stop sharing this file? Existing links will no longer work.')) return;
    setStoppingId(shareId);
    setError('');
    try {
      const response = await fetch(`/stop/${encodeURIComponent(shareId)}`, { method: 'POST' });
      if (!response.ok) throw new Error(`Unable to stop sharing (${response.status})`);
      setShareLinks(current => current.filter(item => item.share_id !== shareId));
      setQrUrl('');
      setNotice('Sharing stopped. Existing links are no longer active.');
      await refreshHistory();
    } catch (err) {
      setError(err.message || 'Unable to stop sharing');
    } finally {
      setStoppingId('');
    }
  };

  const selectedName = files.length > 1 ? (zipName || 'bundle.zip') : (files[0]?.name || '');
  const activeCount = history.filter(item => item.active).length;

  return (
    <div className="fs-shell">
      <div id="animated-background" aria-hidden="true" />
      <header className="fs-topbar">
        <div className="fs-brand">
          <span className="fs-brand-mark"><Icon name="link" size={22} /></span>
          <span className="fs-brand-name">FileShare<span className="fs-brand-dot">.</span></span>
          <span className="fs-dev-tag">DEVELOPMENT</span>
        </div>
        <div className="fs-topbar-right">
          <span className={`fs-connection ${online ? 'fs-online' : 'fs-offline'}`}>
            <span className="fs-connection-dot" />{online ? 'Network online' : 'Network offline'}
          </span>
        </div>
      </header>

      <main className="fs-content">
        <section className="fs-hero">
          <span className="fs-eyebrow"><Icon name="sparkle" size={15} /> PRIVATE BY DESIGN</span>
          <h1>Your files. <span>Your rules.</span></h1>
          <p>Send files securely, share a link, and stay in control of who can download them.</p>
        </section>

        {(error || notice) && (
          <div className={`fs-alert ${error ? 'fs-alert-error' : 'fs-alert-success'}`}
            role={error ? 'alert' : 'status'}>
            <Icon name={error ? 'close' : 'check'} size={19} />
            <span>{error || notice}</span>
            <button className="fs-alert-dismiss" type="button" aria-label="Dismiss message"
              onClick={() => { setError(''); setNotice(''); }}><Icon name="close" size={17} /></button>
          </div>
        )}

        <div className="fs-main-grid">
          <section className="fs-panel fs-upload-panel" aria-labelledby="upload-heading">
            <div className="fs-section-heading">
              <span className="fs-section-icon"><Icon name="upload" size={22} /></span>
              <div>
                <h2 id="upload-heading">Send a file</h2>
                <p>Encrypted before it leaves your computer.</p>
              </div>
            </div>

            <input ref={inputRef} className="fs-visually-hidden" type="file" multiple
              aria-label="Select files to share" onChange={event => chooseFiles(event.target.files)} />
            <button type="button"
              className={`fs-dropzone ${dragging ? 'fs-dropzone-active' : ''}`}
              disabled={uploading}
              onClick={() => inputRef.current?.click()}
              onDragEnter={event => { event.preventDefault(); setDragging(true); }}
              onDragOver={event => event.preventDefault()}
              onDragLeave={event => { event.preventDefault(); setDragging(false); }}
              onDrop={handleDrop}>
              <span className="fs-drop-icon"><Icon name="upload" size={29} /></span>
              <strong>{files.length ? `${files.length} file${files.length === 1 ? '' : 's'} selected` : 'Drop your files here'}</strong>
              <span>{files.length ? 'Click to choose different files' : 'or click to browse your computer'}</span>
              <small>Up to 100 files · 5 GB total</small>
            </button>

            {files.length > 0 && (
              <div className="fs-selected">
                <div className="fs-selected-top">
                  <span>SELECTED FILES</span>
                  <button type="button" disabled={uploading} className="fs-text-button"
                    onClick={() => chooseFiles([])}>Clear all</button>
                </div>
                <div className="fs-file-list">
                  {files.map((file, index) => (
                    <div className="fs-file-row" key={`${file.name}-${file.lastModified}-${index}`}>
                      <span className="fs-file-icon"><Icon name="file" size={18} /></span>
                      <div className="fs-file-details">
                        <strong title={file.name}>{file.name}</strong>
                        <small>{formatBytes(file.size)}</small>
                      </div>
                      <button type="button" className="fs-icon-button" disabled={uploading}
                        aria-label={`Remove ${file.name}`} onClick={() => removeFile(index)}>
                        <Icon name="close" size={17} />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="fs-file-total"><span>Total</span><strong>{formatBytes(totalBytes)}</strong></div>
              </div>
            )}

            <div className="fs-options">
              <label className="fs-field">
                <span>Download limit</span>
                <input type="number" min="1" max="100000" value={maxDownloads} disabled={uploading}
                  onChange={event => setMaxDownloads(Math.min(100000, Math.max(1, Number.parseInt(event.target.value, 10) || 1)))} />
                <small>Link stops working after this many downloads.</small>
              </label>
              {files.length > 1 && (
                <label className="fs-field">
                  <span>ZIP filename</span>
                  <input type="text" value={zipName} disabled={uploading}
                    onChange={event => setZipName(event.target.value)} placeholder="bundle.zip" />
                  <small>Selected files will be bundled automatically.</small>
                </label>
              )}
            </div>

            {transfer && (
              <div className={`fs-transfer ${transfer.stage === 'complete' ? 'fs-transfer-done' : ''}`} role="status">
                <div className="fs-transfer-header">
                  <span><Icon name={transfer.stage === 'complete' ? 'check' : 'file'} size={17} /> {stageLabel(transfer.stage)}</span>
                  <strong>{Math.round(transfer.progress)}%</strong>
                </div>
                <div className="fs-progress-track"><div className="fs-progress-fill"
                  style={{ width: `${transfer.progress}%` }} /></div>
                {uploading && <small>{selectedName}</small>}
              </div>
            )}

            <button className="fs-primary-button" type="button" disabled={!files.length || uploading}
              onClick={upload}>
              <Icon name={uploading ? 'refresh' : 'arrow'} size={19} />
              {uploading ? 'Securing and uploading...' : 'Create sharing link'}
            </button>
            <p className="fs-upload-footnote"><Icon name="shield" size={15} /> Your files are encrypted before publishing.</p>
          </section>

          <aside className="fs-side-column">
            <section className="fs-panel fs-links-panel" aria-labelledby="links-heading">
              <div className="fs-section-heading fs-compact-heading">
                <span className="fs-section-icon fs-teal-icon"><Icon name="link" size={21} /></span>
                <div>
                  <h2 id="links-heading">Fresh links</h2>
                  <p>Ready to send to anyone.</p>
                </div>
              </div>

              {!recentShares.length ? (
                <div className="fs-empty-links">
                  <span className="fs-empty-illustration"><Icon name="link" size={30} /></span>
                  <h3>No links yet</h3>
                  <p>Upload a file and its private sharing links will appear here.</p>
                </div>
              ) : recentShares.map(share => (
                <div className="fs-share-card" key={share.shareId}>
                  <div className="fs-share-title">
                    <span className="fs-file-icon"><Icon name="file" size={19} /></span>
                    <div><strong title={share.filename}>{share.filename}</strong><small>{share.max} download{share.max === 1 ? '' : 's'} allowed</small></div>
                  </div>
                  {share.links.map(link => (
                    <div className="fs-share-link" key={`${share.shareId}-${link.link_type}`}>
                      <div className="fs-share-link-label"><Icon name={link.link_type === 'tor' ? 'shield' : 'globe'} size={15} />
                        {link.link_type === 'tor' ? 'Tor private link' : 'HTTPS link · works in any browser'}
                      </div>
                      <div className="fs-link-actions">
                        <a href={link.share_link} title={link.share_link} target="_blank" rel="noreferrer">{link.share_link}</a>
                        <button type="button" className="fs-small-button" onClick={() => copy(link.share_link)}>
                          <Icon name={copiedUrl === link.share_link ? 'check' : 'copy'} size={15} />
                          {copiedUrl === link.share_link ? 'Copied' : 'Copy'}
                        </button>
                        <button type="button" className="fs-icon-button fs-qr-button"
                          aria-label="Show QR code" title="Show QR code"
                          onClick={() => setQrUrl(current => current === link.share_link ? '' : link.share_link)}>
                          <Icon name="qr" size={17} />
                        </button>
                      </div>
                      {qrUrl === link.share_link && (
                        <div className="fs-qr-wrap"><QRCodeCanvas value={link.share_link} size={132} marginSize={1} />
                          <span>Scan to open on your phone</span></div>
                      )}
                    </div>
                  ))}
                  <button type="button" className="fs-stop-link" disabled={Boolean(stoppingId)}
                    onClick={() => stopShare(share.shareId)}>
                    <Icon name="stop" size={16} /> {stoppingId === share.shareId ? 'Stopping...' : 'Stop sharing'}
                  </button>
                </div>
              ))}
            </section>

            <section className="fs-guide-panel">
              <div className="fs-guide-title"><Icon name="shield" size={19} /> Secure sharing, made simple</div>
              <div className="fs-guide-item"><span>01</span><p><strong>Select</strong> one or more files.</p></div>
              <div className="fs-guide-item"><span>02</span><p><strong>Share</strong> the generated link or QR code.</p></div>
              <div className="fs-guide-item"><span>03</span><p><strong>Stay in control</strong> with download limits and revocation.</p></div>
            </section>
          </aside>
        </div>

        <section className="fs-panel fs-history-panel" aria-labelledby="history-heading">
          <div className="fs-history-top">
            <div className="fs-section-heading fs-compact-heading">
              <span className="fs-section-icon"><Icon name="clock" size={21} /></span>
              <div>
                <h2 id="history-heading">Sharing history</h2>
                <p>{activeCount} active · {history.length} total shares</p>
              </div>
            </div>
            <button className="fs-outline-button" type="button" onClick={refreshHistory}>
              <Icon name="refresh" size={17} /> Refresh
            </button>
          </div>

          <div className="fs-filters">
            <label>Sort <select value={sortOrder} onChange={event => setSortOrder(event.target.value)}>
              <option value="desc">Newest first</option><option value="asc">Oldest first</option>
            </select></label>
            <label>From <input type="date" value={dateRange.from}
              onChange={event => setDateRange(current => ({ ...current, from: event.target.value }))} /></label>
            <label>To <input type="date" value={dateRange.to}
              onChange={event => setDateRange(current => ({ ...current, to: event.target.value }))} /></label>
            <button className="fs-text-button" type="button" onClick={() => setDateRange({ from: '', to: '' })}>Clear filters</button>
          </div>

          {historyError && <p className="fs-history-error" role="alert">{historyError}</p>}
          {historyLoading ? (
            <div className="fs-history-empty">Loading your sharing history...</div>
          ) : !filteredHistory.length ? (
            <div className="fs-history-empty"><Icon name="clock" size={26} />
              <p>{history.length ? 'No shares match your filters.' : 'Your shared files will appear here.'}</p>
            </div>
          ) : (
            <div className="fs-history-scroll">
              <table className="fs-history-table">
                <thead><tr><th>FILE</th><th>DOWNLOADS</th><th>EXPIRY</th><th>STATUS</th><th>ACTIONS</th></tr></thead>
                <tbody>{filteredHistory.map(item => (
                  <tr key={item.share_id}>
                    <td><div className="fs-history-file"><span className="fs-file-icon"><Icon name="file" size={17} /></span>
                      <strong title={item.filename}>{item.filename}</strong></div></td>
                    <td><span className="fs-count">{item.download_count} / {item.max_downloads}</span></td>
                    <td className="fs-date">{formatDate(item.expires_at)}</td>
                    <td><span className={`fs-status-badge ${item.active ? 'fs-active' : 'fs-inactive'}`}>
                      <span />{item.active ? 'Active' : 'Inactive'}</span></td>
                    <td>
                      <div className="fs-history-actions">
                        {item.active && item.tor_link && (
                          <button
                            className="fs-small-button"
                            type="button"
                            onClick={() => copy(item.tor_link)}
                            title="Copy Onion sharing link"
                            aria-label={`Copy Onion link for ${item.filename}`}
                          >
                            <Icon name={copiedUrl === item.tor_link ? 'check' : 'shield'} size={15} />
                            {copiedUrl === item.tor_link ? 'Copied Onion' : 'Copy Onion'}
                          </button>
                        )}
                        {item.active && item.clearnet_link && (
                          <button
                            className="fs-small-button"
                            type="button"
                            onClick={() => copy(item.clearnet_link)}
                            title="Copy HTTPS sharing link"
                            aria-label={`Copy HTTPS link for ${item.filename}`}
                          >
                            <Icon name={copiedUrl === item.clearnet_link ? 'check' : 'globe'} size={15} />
                            {copiedUrl === item.clearnet_link ? 'Copied HTTPS' : 'Copy HTTPS'}
                          </button>
                        )}
                        {item.active && (
                          <button
                            className="fs-icon-button fs-danger-button"
                            type="button"
                            disabled={Boolean(stoppingId)}
                            title="Stop sharing"
                            aria-label={`Stop sharing ${item.filename}`}
                            onClick={() => stopShare(item.share_id)}
                          >
                            <Icon name="stop" size={17} />
                          </button>
                        )}
                        {item.active && !item.tor_link && !item.clearnet_link && (
                          <span className="fs-muted">Link unavailable</span>
                        )}
                        {!item.active && <span className="fs-muted">—</span>}
                      </div>
                    </td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </section>
        <footer className="fs-footer"><Icon name="shield" size={15} /> FileShare Development · Local control, private transfers.</footer>
      </main>
    </div>
  );
}

export default App;