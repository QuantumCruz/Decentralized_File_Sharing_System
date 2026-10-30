import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';

import { QRCodeCanvas } from 'qrcode.react';
import './App.css';


const API = window.location.origin;
const apiPath = path => `${API}${path}`;

const buttonStyle = {
  background: '#0b0f2b',
  color: '#fff',
  padding: '9px 14px',
  border: 0,
  borderRadius: 7,
  cursor: 'pointer'
};

const panelStyle = {
  background: '#fff',
  color: '#111',
  borderRadius: 12,
  maxWidth: 850,
  padding: 24,
  margin: '0 auto 24px'
};


function App() {
  const [files, setFiles] = useState([]);
  const [zipName, setZipName] = useState('bundle.zip');
  const [maxDownloads, setMaxDownloads] = useState(1);

  const [progress, setProgress] = useState(0);
  const [uploadState, setUploadState] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [history, setHistory] = useState([]);
  const [historyError, setHistoryError] = useState('');
  const [links, setLinks] = useState([]);

  const [dateRange, setDateRange] = useState({
    from: '',
    to: ''
  });

  const [sortOrder, setSortOrder] = useState('desc');
  const [online, setOnline] = useState(navigator.onLine);

  const inputRef = useRef(null);
  const socketRef = useRef(null);

  const size = files.reduce(
    (count, file) => count + file.size,
    0
  );

  const displayName = files.length > 1
    ? zipName
    : (files[0]?.name || '');


  const readJson = async (url, options = {}) => {
    const response = await fetch(
      apiPath(url),
      options
    );

    const data = await response.json().catch(
      () => ({})
    );

    if (!response.ok) {
      throw new Error(
        data.error ||
        `Request failed (${response.status})`
      );
    }

    return data;
  };


  const refreshHistory = useCallback(async () => {
    try {
      const response = await fetch(
        apiPath('/history'),
        {
          cache: 'no-store'
        }
      );

      if (!response.ok) {
        throw new Error(
          `History request failed (${response.status})`
        );
      }

      const data = await response.json();

      if (!Array.isArray(data)) {
        throw new Error(
          'Unexpected history response'
        );
      }

      setHistory(data);
      setHistoryError('');

    } catch (exc) {
      setHistoryError(exc.message);
    }
  }, []);


  useEffect(() => {
    refreshHistory();

    const refreshTimer = window.setInterval(
      refreshHistory,
      10000
    );

    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    return () => {
      window.clearInterval(refreshTimer);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [refreshHistory]);


  useEffect(() => () => {
    if (socketRef.current) {
      socketRef.current.close();
    }
  }, []);


  const shownHistory = useMemo(
    () => history.filter(item => {
      const timestamp = item.expires_at * 1000;

      const from = dateRange.from
        ? new Date(
            `${dateRange.from}T00:00:00`
          ).getTime()
        : -Infinity;

      const to = dateRange.to
        ? new Date(
            `${dateRange.to}T23:59:59.999`
          ).getTime()
        : Infinity;

      return timestamp >= from && timestamp <= to;

    }).sort((a, b) => (
      sortOrder === 'asc'
        ? a.expires_at - b.expires_at
        : b.expires_at - a.expires_at
    )),
    [history, dateRange, sortOrder]
  );


  const copy = async value => {
    try {
      await navigator.clipboard.writeText(
        value
      );

      setError('');
      setUploadState(
        'Link copied to clipboard'
      );

    } catch (_) {
      setError(
        'Could not copy the link. ' +
        'Select and copy it manually.'
      );
    }
  };


  const selectFiles = selection => {
    if (busy) {
      return;
    }

    setFiles(
      Array.from(selection)
    );

    setError('');
    setProgress(0);
    setUploadState('');
  };


  const onDrop = event => {
    event.preventDefault();

    if (busy) {
      return;
    }

    const containsFolder = Array.from(
      event.dataTransfer.items || []
    ).some(
      item => (
        item.kind === 'file' &&
        item.webkitGetAsEntry?.()?.isDirectory
      )
    );

    if (containsFolder) {
      setError(
        'Folders cannot be selected directly. ' +
        'Choose the files inside the folder.'
      );
      return;
    }

    selectFiles(
      event.dataTransfer.files
    );
  };


  const upload = async () => {
    if (busy || files.length === 0) {
      return;
    }

    setBusy(true);
    setError('');
    setProgress(0);

    setUploadState(
      'Connecting to FileShare...'
    );

    const id = window.crypto
      .randomUUID()
      .replaceAll('-', '');

    const socketUrl = new URL(
      `/ws/progress/${id}`,
      API
    );

    socketUrl.protocol =
      socketUrl.protocol === 'https:'
        ? 'wss:'
        : 'ws:';

    let socket;

    try {
      socket = new WebSocket(
        socketUrl.toString()
      );

      socketRef.current = socket;

      await new Promise((resolve, reject) => {
        const timeout = window.setTimeout(
          () => reject(
            new Error(
              'Progress connection timed out'
            )
          ),
          15000
        );

        socket.onopen = () => {
          window.clearTimeout(timeout);
          resolve();
        };

        socket.onerror = () => {
          window.clearTimeout(timeout);
          reject(
            new Error(
              'Progress connection failed'
            )
          );
        };

        socket.onmessage = message => {
          try {
            const event = JSON.parse(
              message.data
            );

            if (
              typeof event.progress === 'number'
            ) {
              setProgress(
                event.progress
              );
            }

            if (event.status) {
              setUploadState(
                event.status
              );
            }

          } catch (_) {
            // Ignore malformed progress events.
          }
        };
      });

      const params = new URLSearchParams({
        share_id: id,
        max_downloads: String(
          maxDownloads
        )
      });

      if (files.length > 1) {
        params.set(
          'zip_name',
          zipName
        );
      }

      const form = new FormData();

      files.forEach(file => {
        form.append(
          'files',
          file,
          file.name
        );
      });

      const data = await readJson(
        `/upload?${params.toString()}`,
        {
          method: 'POST',
          body: form
        }
      );

      if (
        !Array.isArray(data.share_links) ||
        !data.share_links.length
      ) {
        throw new Error(
          'Upload finished but no sharing link was returned'
        );
      }

      setLinks(previous => [
        ...data.share_links,
        ...previous
      ]);

      setFiles([]);

      if (inputRef.current) {
        inputRef.current.value = '';
      }

      setProgress(100);
      setUploadState(
        'File ready to share'
      );

      await refreshHistory();

    } catch (exc) {
      setError(exc.message);
      setUploadState(
        'Upload failed'
      );

    } finally {
      if (
        socket &&
        socket.readyState < WebSocket.CLOSING
      ) {
        socket.close();
      }

      socketRef.current = null;
      setBusy(false);
    }
  };


  const stop = async id => {
    try {
      await readJson(
        `/stop/${encodeURIComponent(id)}`,
        {
          method: 'POST'
        }
      );

      setLinks(previous => previous.filter(
        link => link.share_id !== id
      ));

      setUploadState(
        'Sharing stopped'
      );

      await refreshHistory();

    } catch (exc) {
      setError(
        `Unable to stop sharing: ${exc.message}`
      );
    }
  };


  const grouped = Object.values(
    links.reduce((result, link) => {
      if (!result[link.share_id]) {
        result[link.share_id] = {
          shareId: link.share_id,
          filename: link.filename,
          max: link.max_downloads,
          links: []
        };
      }

      result[link.share_id].links.push(
        link
      );

      return result;

    }, {})
  );


  return (
    <main
      style={{
        minHeight: '100vh',
        background: '#0b0f2b',
        color: '#fff',
        padding: '32px 16px',
        fontFamily: 'Inter, Arial, sans-serif'
      }}
    >
      <h1
        style={{
          textAlign: 'center',
          marginBottom: 30
        }}
      >
        📦 FileShare Development
      </h1>

      <section style={panelStyle}>
        <h2 style={{ marginTop: 0 }}>
          Share files privately
        </h2>

        <p>
          Choose files, encrypt them locally,
          then copy a private sharing link.
        </p>

        {!online && (
          <p
            role="alert"
            style={{ color: '#b91c1c' }}
          >
            No internet connection detected.
            Remote sharing may be unavailable.
          </p>
        )}

        {error && (
          <p
            role="alert"
            style={{
              color: '#b91c1c',
              fontWeight: 600
            }}
          >
            {error}
          </p>
        )}

        <div
          onClick={() => (
            !busy && inputRef.current?.click()
          )}
          onDragOver={e => e.preventDefault()}
          onDrop={onDrop}
          style={{
            border: '2px dashed #8a91ae',
            borderRadius: 10,
            padding: 32,
            cursor: busy
              ? 'not-allowed'
              : 'pointer',
            textAlign: 'center',
            background: '#f5f7ff'
          }}
        >
          <strong>
            {files.length
              ? `${files.length} file(s) selected`
              : 'Click or drop files here'}
          </strong>

          <input
            ref={inputRef}
            type="file"
            multiple
            disabled={busy}
            onChange={e => (
              selectFiles(e.target.files)
            )}
            style={{
              display: 'none'
            }}
          />
        </div>

        {files.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <p>
              <strong>Total size:</strong>{' '}
              {(size / 1024 / 1024).toFixed(2)} MB
            </p>

            <ul>
              {files.map((file, i) => (
                <li key={`${file.name}-${i}`}>
                  {file.name}
                </li>
              ))}
            </ul>
          </div>
        )}

        {files.length > 1 && (
          <label
            style={{
              display: 'block',
              margin: '15px 0'
            }}
          >
            ZIP filename:{' '}

            <input
              value={zipName}
              disabled={busy}
              onChange={e => (
                setZipName(e.target.value)
              )}
            />
          </label>
        )}

        <label
          style={{
            display: 'block',
            margin: '15px 0'
          }}
        >
          Maximum downloads:{' '}

          <input
            type="number"
            min="1"
            max="100000"
            value={maxDownloads}
            disabled={busy}
            onChange={e => (
              setMaxDownloads(
                Math.max(
                  1,
                  Math.min(
                    100000,
                    Number.parseInt(
                      e.target.value,
                      10
                    ) || 1
                  )
                )
              )
            )}
          />
        </label>

        <button
          style={buttonStyle}
          disabled={
            busy ||
            !files.length
          }
          onClick={upload}
        >
          {busy ? 'Uploading...' : 'Share files'}
        </button>

        {(uploadState || busy) && (
          <div
            style={{ marginTop: 16 }}
            role="status"
          >
            <strong>
              {displayName || 'Transfer'}:
              {' '}{uploadState}
            </strong>

            <progress
              style={{
                display: 'block',
                width: '100%',
                marginTop: 8
              }}
              max="100"
              value={progress}
            />

            <span>{progress}%</span>
          </div>
        )}
      </section>

      {grouped.length > 0 && (
        <section style={panelStyle}>
          <h2>New sharing links</h2>

          {grouped.map(group => (
            <article
              key={group.shareId}
              style={{
                padding: '16px 0',
                borderBottom: '1px solid #ddd'
              }}
            >
              <h3>{group.filename}</h3>

              {group.links.map(link => (
                <div
                  key={link.link_type}
                  style={{
                    marginBottom: 12
                  }}
                >
                  <strong>
                    {link.link_type === 'tor'
                      ? '🧅 Tor (private network)'
                      : '🌐 HTTPS (regular browsers)'}
                  </strong>

                  <p
                    style={{
                      overflowWrap: 'anywhere'
                    }}
                  >
                    <a
                      href={link.share_link}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {link.share_link}
                    </a>
                  </p>

                  <button
                    style={buttonStyle}
                    onClick={() => copy(
                      link.share_link
                    )}
                  >
                    Copy link
                  </button>

                  <div
                    style={{ marginTop: 8 }}
                  >
                    <QRCodeCanvas
                      size={100}
                      value={link.share_link}
                    />
                  </div>
                </div>
              ))}

              <p>
                Maximum downloads: {group.max}
              </p>

              <button
                style={buttonStyle}
                onClick={() => stop(
                  group.shareId
                )}
              >
                Stop sharing
              </button>
            </article>
          ))}
        </section>
      )}

      <section style={panelStyle}>
        <h2>History</h2>

        {historyError && (
          <p
            role="alert"
            style={{
              color: '#b91c1c'
            }}
          >
            Unable to update history:
            {' '}{historyError}
          </p>
        )}

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 10
          }}
        >
          <label>
            Sort:{' '}

            <select
              value={sortOrder}
              onChange={e => (
                setSortOrder(e.target.value)
              )}
            >
              <option value="desc">
                Latest first
              </option>
              <option value="asc">
                Earliest first
              </option>
            </select>
          </label>

          <label>
            From:{' '}

            <input
              type="date"
              value={dateRange.from}
              onChange={e => (
                setDateRange(value => ({
                  ...value,
                  from: e.target.value
                }))
              )}
            />
          </label>

          <label>
            To:{' '}

            <input
              type="date"
              value={dateRange.to}
              onChange={e => (
                setDateRange(value => ({
                  ...value,
                  to: e.target.value
                }))
              )}
            />
          </label>

          <button
            style={buttonStyle}
            onClick={() => setDateRange({
              from: '',
              to: ''
            })}
          >
            Clear filters
          </button>

          <button
            style={buttonStyle}
            onClick={refreshHistory}
          >
            Refresh
          </button>
        </div>

        {!shownHistory.length && (
          <p>No shares in this date range.</p>
        )}

        {shownHistory.map(item => (
          <article
            key={item.share_id}
            style={{
              borderBottom: '1px solid #ddd',
              padding: '16px 0'
            }}
          >
            <h3
              style={{
                margin: '0 0 8px'
              }}
            >
              {item.filename}
            </h3>

            <p>
              Downloads:
              {' '}{item.download_count}/
              {item.max_downloads}
              {' — '}
              {item.active
                ? 'Active'
                : 'Expired or stopped'}
            </p>

            <p>
              Expires:
              {' '}
              {new Date(
                item.expires_at * 1000
              ).toLocaleString()}
            </p>

            {item.active && (
              <>
                {item.tor_link && (
                  <p
                    style={{
                      overflowWrap: 'anywhere'
                    }}
                  >
                    Tor:{' '}

                    <a
                      href={item.tor_link}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {item.tor_link}
                    </a>

                    {' '}

                    <button
                      onClick={() => copy(
                        item.tor_link
                      )}
                    >
                      Copy
                    </button>
                  </p>
                )}

                {item.clearnet_link && (
                  <p
                    style={{
                      overflowWrap: 'anywhere'
                    }}
                  >
                    HTTPS:{' '}

                    <a
                      href={item.clearnet_link}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {item.clearnet_link}
                    </a>

                    {' '}

                    <button
                      onClick={() => copy(
                        item.clearnet_link
                      )}
                    >
                      Copy
                    </button>
                  </p>
                )}

                <button
                  style={buttonStyle}
                  onClick={() => stop(
                    item.share_id
                  )}
                >
                  Stop sharing
                </button>
              </>
            )}
          </article>
        ))}
      </section>
    </main>
  );
}


export default App;