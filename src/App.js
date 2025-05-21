import React, { useState, useEffect } from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import './App.css';

function App() {
  const [files, setFiles] = useState([]);
  const [fileStatuses, setFileStatuses] = useState({});
  const [shareData, setShareData] = useState([]);
  const [uploadProgress, setUploadProgress] = useState({});
  const [isUploading, setIsUploading] = useState(false);
  const [maxDownloads, setMaxDownloads] = useState(1);
  const [history, setHistory] = useState([]);
  const [totalSize, setTotalSize] = useState(0);
  const [zipName, setZipName] = useState("bundle.zip");
  const [folderError, setFolderError] = useState(false);
  const [sortOrder, setSortOrder] = useState('desc');
  const [dateRange, setDateRange] = useState({ from: '', to: '' });

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text)
      .then(() => alert("Copied to clipboard"))
      .catch(() => alert("Failed to copy"));
  };

  const [isOnline, setIsOnline] = useState(true);

  useEffect(() => {
    fetchHistory();
  }, []);

  const fetchHistory = async () => {
    try {
      const res = await fetch("http://localhost:5000/history");
      const data = await res.json();

      const filtered = data.filter(item => {
        if (!dateRange.from && !dateRange.to) return true;
        const expires = new Date(item.expires_at * 1000);
        const from = dateRange.from ? new Date(dateRange.from) : null;
        const to = dateRange.to ? new Date(dateRange.to) : null;
        return (!from || expires >= from) && (!to || expires <= to);
      });

      const sorted = [...filtered].sort((a, b) =>
        sortOrder === 'asc'
          ? a.expires_at - b.expires_at
          : b.expires_at - a.expires_at
      );

      setHistory(sorted);
    } catch (err) {
      console.error("Failed to fetch history:", err);
    }
  };

  useEffect(() => {
    const interval = setInterval(async () => {
      if (shareData.length === 0) return;

      const checkStatus = async (shareId) => {
        try {
          const res = await fetch(`http://localhost:5000/status/${shareId}`);
          const data = await res.json();
          return data.active;
        } catch {
          return true;
        }
      };

      const filtered = [];
      for (const item of shareData) {
        const isActive = await checkStatus(item.share_id);
        if (isActive) filtered.push(item);
      }

      setShareData(filtered);
      fetchHistory();
    }, 10000);

    return () => clearInterval(interval);
  }, [shareData]);

  useEffect(() => {
    const checkConnectivity = async () => {
      try {
        const res = await fetch("https://clients3.google.com/generate_204");
        setIsOnline(res.status === 204);
      } catch {
        setIsOnline(false);
      }
    };
    checkConnectivity();
  }, []);


  const handleFileChange = (e) => {
    const selected = Array.from(e.target.files);
    setFiles(selected);
    const statusMap = {};
    const progressMap = {};
    let sizeSum = 0;
    selected.forEach(f => {
      statusMap[f.name] = 'Pending';
      progressMap[f.name] = 0;
      sizeSum += f.size;
    });
    setFileStatuses(statusMap);
    setUploadProgress(progressMap);
    setTotalSize(sizeSum);
    if (selected.length === 1) setZipName("bundle.zip");
  };

  const handleUpload = async () => {
    if (files.length === 0) return;

    setIsUploading(true);
    const shareId = Math.random().toString(36).substring(2, 18);
    const formData = new FormData();
    const bundled = files.length > 1;
    const displayFilename = bundled ? zipName : files[0].name;
    files.forEach(f => formData.append("files", f));

    setFileStatuses({ [displayFilename]: 'Uploading...' });
    setUploadProgress({ [displayFilename]: 0 });

    try {
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:5000/ws/progress/${shareId}`);
        ws.onopen = () => resolve(ws);
        ws.onerror = () => {
          setFileStatuses({ [displayFilename]: 'WebSocket error' });
          reject(new Error("WebSocket failed"));
        };
        ws.onmessage = e => {
          const data = JSON.parse(e.data);
          setUploadProgress({ [displayFilename]: data.progress });
          if (data.progress >= 90 && data.progress < 100) {
            setFileStatuses({ [displayFilename]: 'Finalizing...' });
          }
          if (data.status === 'complete') {
            setUploadProgress({ [displayFilename]: 100 });
            setFileStatuses({ [displayFilename]: 'Uploaded' });
            ws.close();
          }
        };
      });

      const url = `http://localhost:5000/upload?share_id=${shareId}&max_downloads=${maxDownloads}${bundled ? `&zip_name=${encodeURIComponent(zipName)}` : ''}`;
      const res = await fetch(url, { method: 'POST', body: formData });
      const data = await res.json();

      if (res.ok && Array.isArray(data.share_links)) {
        setShareData(prev => [...prev, ...data.share_links.map(link => ({ ...link, filename: displayFilename }))]);
        fetchHistory();
      } else {
        setFileStatuses({ [displayFilename]: 'Upload failed' });
      }
    } catch (err) {
      console.error(err);
      setFileStatuses({ [displayFilename]: 'Upload error' });
    }

    setIsUploading(false);
    setFiles([]);
    setFileStatuses({});
    setUploadProgress({});
    setTotalSize(0);
    setZipName("bundle.zip");
  };

  const stopShare = async (shareId) => {
    try {
      const res = await fetch(`http://localhost:5000/stop/${shareId}`, { method: "POST" });
      const data = await res.json();
      if (res.ok && data.status === "stopped") {
        setShareData(prev => prev.filter(x => x.share_id !== shareId));
        fetchHistory();
      }
    } catch (err) {
      console.error(err);
    }
  };

  const displayFilename = files.length > 1 ? zipName : (files[0]?.name || '');

  return (
    <>
      <div id="animated-background"></div>
      <div style={{ color: 'white', minHeight: '100vh', padding: '2rem', fontFamily: 'Inter, sans-serif' }}>
        <h1 style={{ fontSize: '2rem', textAlign: 'center', marginBottom: '2rem' }}>📦 Decentralized File Share</h1>

        <div style={{ backgroundColor: '#fff', color: '#000', padding: '1.5rem', borderRadius: '12px', maxWidth: '800px', margin: '0 auto' }}>
          <div style={{ marginBottom: '1rem' }}>
            <label><strong>Max Downloads:</strong>
              <input
                type="number"
                value={maxDownloads}
                onChange={(e) => setMaxDownloads(Math.max(1, parseInt(e.target.value) || 1))}
                min="1"
                style={{ marginLeft: '10px', padding: '4px 8px', borderRadius: '4px' }}
              />
            </label>
          </div>
          {!isOnline && (
            <div style={{
              backgroundColor: '#ff4d4d',
              color: '#fff',
              padding: '1rem',
              borderRadius: '8px',
              marginBottom: '1rem',
              textAlign: 'center'
            }}>
              ⚠️ No internet connection detected. Some features like Tor or IPFS may be limited.
            </div>
          )}
          <div
            onClick={() => document.getElementById('fileInput').click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={async (e) => {
              e.preventDefault();
              const items = e.dataTransfer.items;
              let containsFolder = false;

              for (const item of items) {
                if (item.kind === 'file') {
                  const entry = item.webkitGetAsEntry?.();
                  if (entry && entry.isDirectory) {
                    containsFolder = true;
                    break;
                  }
                }
              }

              if (containsFolder) {
                setFolderError(true);
                return;
              }

              setFolderError(false);
              handleFileChange({ target: { files: e.dataTransfer.files } });
            }}
            style={{
              border: '2px dashed #fff',
              padding: '40px',
              textAlign: 'center',
              borderRadius: '12px',
              backgroundColor: '#0b0f2b',
              color: '#fff',
              cursor: 'pointer',
              marginBottom: '1rem',
              fontSize: '16px'
            }}
          >
            {files.length === 0 ? '📁 Click or Drag & Drop to choose files' : `${files.length} file(s) selected`}
            <input
              id="fileInput"
              type="file"
              multiple
              onChange={handleFileChange}
              style={{ display: 'none' }}
              disabled={isUploading}
            />
          </div>

          {folderError && (
            <div style={{
              backgroundColor: '#ff4d4d',
              color: '#fff',
              padding: '1rem',
              borderRadius: '8px',
              marginBottom: '1rem',
              textAlign: 'center'
            }}>
              ❌ Folder uploads are not supported. Please select files only.
            </div>
          )}

          {files.length > 1 && (
            <div style={{ backgroundColor: '#fff', color: '#000', padding: '10px', borderRadius: '8px', marginBottom: '1rem', fontSize: '14px' }}>
              <strong>Selected Files:</strong>
              <ul>
                {files.map((file, idx) => (
                  <li key={idx}>{file.name} — {(file.size / 1024 / 1024).toFixed(2)} MB</li>
                ))}
              </ul>
            </div>
          )}

          {files.length > 1 && (
            <div style={{ marginBottom: '1rem' }}>
              <label><strong>ZIP Filename:</strong>
                <input
                  type="text"
                  value={zipName}
                  onChange={(e) => {
                    const val = e.target.value.endsWith('.zip') ? e.target.value : e.target.value + ".zip";
                    setZipName(val);
                  }}
                  style={{ marginLeft: '10px', padding: '4px 8px', borderRadius: '4px' }}
                />
              </label>
            </div>
          )}

          {totalSize > 0 && (
            <div><strong>Total Size:</strong> {(totalSize / (1024 * 1024)).toFixed(2)} MB</div>
          )}

          <button
            onClick={handleUpload}
            disabled={isUploading || files.length === 0}
            style={{
              marginTop: '1rem',
              padding: '10px 20px',
              backgroundColor: '#0b0f2b',
              color: 'white',
              border: 'none',
              borderRadius: '6px'
            }}>
            {isUploading ? 'Uploading...' : 'Upload'}
          </button>

          {displayFilename && uploadProgress[displayFilename] !== undefined && (
            <div style={{ marginTop: '1rem' }}>
              <strong>{displayFilename}</strong>
              <progress value={uploadProgress[displayFilename]} max="100" style={{ width: '100%', height: '10px' }} />
              <div>{uploadProgress[displayFilename]}% — {fileStatuses[displayFilename]}</div>
            </div>
          )}
        </div>

        {shareData.length > 0 && (
          <div style={{ marginTop: '2rem', maxWidth: '800px', margin: '0 auto' }}>
            <h2>🔗 Share Links</h2>
            {shareData.map(({ share_link, filename, share_id, max_downloads }, idx) => (
              <div key={`${share_id}-${idx}`} style={{ backgroundColor: '#fff', color: '#000', borderRadius: '12px', padding: '1rem', marginBottom: '1rem' }}>
                <p><strong>{filename}</strong>{filename === "bundle.zip" && " (multiple files)"}</p>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                  <a href={share_link} target="_blank" rel="noopener noreferrer">{share_link}</a>
                  <button
                    onClick={() => copyToClipboard(share_link)}
                    style={{
                      padding: '6px 10px',
                      backgroundColor: '#0b0f2b',
                      color: '#fff',
                      border: 'none',
                      borderRadius: '6px',
                      cursor: 'pointer'
                    }}
                  >
                    📋 Copy
                  </button>
                </div>
                <div><QRCodeCanvas value={share_link} /></div>
                <p>Maximum downloads: {max_downloads}</p>
                <button onClick={() => stopShare(share_id)} style={{ marginTop: '5px', padding: '6px 10px', backgroundColor: '#0b0f2b', color: '#fff', border: 'none', borderRadius: '6px' }}>Stop Sharing</button>
              </div>
            ))}
          </div>
        )}

        {history.length > 0 || dateRange.from || dateRange.to ? (
          <div style={{ marginTop: '2rem', maxWidth: '800px', margin: '0 auto' }}>
            <h2>📜 History</h2>

            <div style={{ marginBottom: '10px', display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
              <label style={{ color: 'white' }}>
                Sort:
                <select
                  value={sortOrder}
                  onChange={e => setSortOrder(e.target.value)}
                  style={{ marginLeft: '5px', padding: '4px 8px', borderRadius: '4px' }}
                >
                  <option value="desc">Latest First</option>
                  <option value="asc">Earliest First</option>
                </select>
              </label>

              <label style={{ color: 'white' }}>
                From:
                <input
                  type="date"
                  value={dateRange.from}
                  onChange={e => setDateRange(prev => ({ ...prev, from: e.target.value }))}
                  style={{ marginLeft: '5px', padding: '4px 8px', borderRadius: '4px' }}
                />
              </label>

              <label style={{ color: 'white' }}>
                To:
                <input
                  type="date"
                  value={dateRange.to}
                  onChange={e => setDateRange(prev => ({ ...prev, to: e.target.value }))}
                  style={{ marginLeft: '5px', padding: '4px 8px', borderRadius: '4px' }}
                />
              </label>

              <button
                onClick={() => setDateRange({ from: '', to: '' })}
                style={{
                  padding: '6px 12px',
                  backgroundColor: '#0b0f2b',
                  color: 'white',
                  border: 'none',
                  borderRadius: '6px'
                }}
              >
                Clear Filters
              </button>

              <button
                onClick={fetchHistory}
                style={{
                  padding: '6px 12px',
                  backgroundColor: '#0b0f2b',
                  color: 'white',
                  border: 'none',
                  borderRadius: '6px'
                }}
              >
                🔄 Refresh
              </button>
            </div>

            {history.length === 0 ? (
              <p style={{ color: 'white', textAlign: 'center', marginTop: '2rem' }}>No history</p>
            ) : (
              history.map(item => (
                <div key={item.share_id} style={{ backgroundColor: '#fff', color: '#000', borderRadius: '12px', padding: '1rem', marginBottom: '1rem' }}>
                  <strong>{item.filename}</strong><br />
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                    <a href={item.share_link} target="_blank" rel="noreferrer">{item.share_link}</a>
                    <button
                      onClick={() => copyToClipboard(item.share_link)}
                      style={{
                        padding: '6px 10px',
                        backgroundColor: '#0b0f2b',
                        color: '#fff',
                        border: 'none',
                        borderRadius: '6px',
                        cursor: 'pointer'
                      }}
                    >
                      📋 Copy
                    </button>
                  </div>
                  Downloads: {item.download_count} / {item.max_downloads}<br />
                  Status: {item.active ? "Active" : "Expired/Stopped"}<br />
                  Expires: {new Date(item.expires_at * 1000).toLocaleString()}<br />
                  {item.active && (
                    <button
                      onClick={() => stopShare(item.share_id)}
                      style={{
                        marginTop: '5px',
                        padding: '6px 10px',
                        backgroundColor: '#0b0f2b',
                        color: '#fff',
                        border: 'none',
                        borderRadius: '6px'
                      }}
                    >
                      Stop Sharing
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        ) : null}
      </div>
    </>
  );
}

export default App;
