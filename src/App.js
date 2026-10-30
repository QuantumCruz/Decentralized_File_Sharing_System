import React, { useState, useEffect, useRef } from 'react';
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
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [uploadSpeed, setUploadSpeed] = useState(null); // Mbps
  const uploadStartTime = useRef(null);
  const lastProgressRef = useRef({ bytes: 0, time: Date.now() });

  useEffect(() => {
    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  useEffect(() => { fetchHistory(); }, []);

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text)
      .then(() => alert("Copied to clipboard"))
      .catch(() => alert("Failed to copy"));
  };

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
      setHistory([...filtered].sort((a, b) =>
        sortOrder === 'asc' ? a.expires_at - b.expires_at : b.expires_at - a.expires_at
      ));
    } catch (err) {
      console.error("Failed to fetch history:", err);
    }
  };

  useEffect(() => {
    const interval = setInterval(async () => {
      if (shareData.length === 0) return;
      const updated = [];
      for (const item of shareData) {
        try {
          const res = await fetch(`http://localhost:5000/status/${item.share_id}`);
          const data = await res.json();
          if (data.active) updated.push(item);
        } catch {
          updated.push(item);
        }
      }
      setShareData(updated);
      fetchHistory();
    }, 10000);
    return () => clearInterval(interval);
  }, [shareData]);

  const handleFileChange = (e) => {
    const selected = Array.from(e.target.files);
    setFiles(selected);
    let sizeSum = 0;
    const statusMap = {};
    const progressMap = {};
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
    setUploadSpeed(null);

    const shareId = Math.random().toString(36).substring(2, 18);
    const formData = new FormData();
    const bundled = files.length > 1;
    const displayFilename = bundled ? zipName : files[0].name;
    files.forEach(f => formData.append("files", f));

    setFileStatuses({ [displayFilename]: 'Uploading...' });
    setUploadProgress({ [displayFilename]: 0 });

    uploadStartTime.current = Date.now();
    lastProgressRef.current = { bytes: 0, time: Date.now() };

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
          const now = Date.now();
          const progress = data.progress;

          // Calculate speed based on progress delta
          const prevBytes = (lastProgressRef.current.bytes / 100) * totalSize;
          const currBytes = (progress / 100) * totalSize;
          const bytesDelta = currBytes - prevBytes;
          const timeDelta = (now - lastProgressRef.current.time) / 1000; // seconds

          if (timeDelta > 0 && bytesDelta > 0) {
            const speedMbps = ((bytesDelta * 8) / timeDelta / 1_000_000).toFixed(2);
            setUploadSpeed(speedMbps);
          }

          lastProgressRef.current = { bytes: progress, time: now };
          setUploadProgress({ [displayFilename]: progress });

          if (progress >= 90 && progress < 100)
            setFileStatuses({ [displayFilename]: 'Finalizing...' });
          if (data.status === 'complete') {
            setUploadProgress({ [displayFilename]: 100 });
            setFileStatuses({ [displayFilename]: 'Uploaded' });
            setUploadSpeed(null);
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
    setUploadSpeed(null);
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

  const btnStyle = {
    padding: '6px 10px',
    backgroundColor: '#0b0f2b',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer'
  };

  const groupedShares = shareData.reduce((acc, item) => {
    if (!acc[item.share_id]) acc[item.share_id] = { ...item, links: [] };
    acc[item.share_id].links.push({ url: item.share_link, type: item.link_type });
    return acc;
  }, {});

  return (
    <>
      <div id="animated-background"></div>
      <div style={{ color: 'white', minHeight: '100vh', padding: '2rem', fontFamily: 'Inter, sans-serif' }}>
        <h1 style={{ fontSize: '2rem', textAlign: 'center', marginBottom: '2rem' }}>📦 Decentralized File Share</h1>

        <div style={{ backgroundColor: '#fff', color: '#000', padding: '1.5rem', borderRadius: '12px', maxWidth: '800px', margin: '0 auto' }}>

          {!isOnline && (
            <div style={{ backgroundColor: '#ff4d4d', color: '#fff', padding: '1rem', borderRadius: '8px', marginBottom: '1rem', textAlign: 'center' }}>
              ⚠️ No internet connection detected.
            </div>
          )}

          <div style={{ marginBottom: '1rem' }}>
            <label><strong>Max Downloads:</strong>
              <input
                type="number"
                value={maxDownloads}
                onChange={e => setMaxDownloads(Math.max(1, parseInt(e.target.value) || 1))}
                min="1"
                style={{ marginLeft: '10px', padding: '4px 8px', borderRadius: '4px' }}
              />
            </label>
          </div>

          <div
            onClick={() => document.getElementById('fileInput').click()}
            onDragOver={e => e.preventDefault()}
            onDrop={async e => {
              e.preventDefault();
              for (const item of e.dataTransfer.items) {
                if (item.kind === 'file' && item.webkitGetAsEntry?.()?.isDirectory) {
                  setFolderError(true);
                  return;
                }
              }
              setFolderError(false);
              handleFileChange({ target: { files: e.dataTransfer.files } });
            }}
            style={{
              border: '2px dashed #ccc', padding: '40px', textAlign: 'center',
              borderRadius: '12px', backgroundColor: '#0b0f2b', color: '#fff',
              cursor: 'pointer', marginBottom: '1rem', fontSize: '16px'
            }}
          >
            {files.length === 0 ? '📁 Click or Drag & Drop to choose files' : `${files.length} file(s) selected`}
            <input id="fileInput" type="file" multiple onChange={handleFileChange} style={{ display: 'none' }} disabled={isUploading} />
          </div>

          {folderError && (
            <div style={{ backgroundColor: '#ff4d4d', color: '#fff', padding: '1rem', borderRadius: '8px', marginBottom: '1rem', textAlign: 'center' }}>
              ❌ Folder uploads are not supported. Please select files only.
            </div>
          )}

          {files.length > 1 && (
            <>
              <div style={{ backgroundColor: '#f5f5f5', padding: '10px', borderRadius: '8px', marginBottom: '1rem', fontSize: '14px' }}>
                <strong>Selected Files:</strong>
                <ul>
                  {files.map((file, idx) => (
                    <li key={idx}>{file.name} — {(file.size / 1024 / 1024).toFixed(2)} MB</li>
                  ))}
                </ul>
              </div>
              <div style={{ marginBottom: '1rem' }}>
                <label><strong>ZIP Filename:</strong>
                  <input
                    type="text"
                    value={zipName}
                    onChange={e => setZipName(e.target.value.endsWith('.zip') ? e.target.value : e.target.value + ".zip")}
                    style={{ marginLeft: '10px', padding: '4px 8px', borderRadius: '4px' }}
                  />
                </label>
              </div>
            </>
          )}

          {totalSize > 0 && <div style={{ marginBottom: '0.5rem' }}><strong>Total Size:</strong> {(totalSize / (1024 * 1024)).toFixed(2)} MB</div>}

          <button
            onClick={handleUpload}
            disabled={isUploading || files.length === 0}
            style={{ marginTop: '1rem', padding: '10px 20px', backgroundColor: '#0b0f2b', color: 'white', border: 'none', borderRadius: '6px', cursor: isUploading ? 'not-allowed' : 'pointer' }}
          >
            {isUploading ? 'Uploading...' : 'Upload'}
          </button>

          {displayFilename && uploadProgress[displayFilename] !== undefined && (
            <div style={{ marginTop: '1rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                <strong>{displayFilename}</strong>
                {uploadSpeed && <span style={{ fontSize: '13px', color: '#555' }}>⚡ {uploadSpeed} Mbps</span>}
              </div>
              <div style={{ backgroundColor: '#e0e0e0', borderRadius: '6px', overflow: 'hidden', height: '12px' }}>
                <div style={{
                  width: `${uploadProgress[displayFilename]}%`,
                  backgroundColor: '#0b0f2b',
                  height: '100%',
                  transition: 'width 0.3s ease'
                }} />
              </div>
              <div style={{ fontSize: '13px', marginTop: '4px', color: '#333' }}>
                {uploadProgress[displayFilename]}% — {fileStatuses[displayFilename]}
              </div>
            </div>
          )}
        </div>

        {Object.values(groupedShares).length > 0 && (
          <div style={{ marginTop: '2rem', maxWidth: '800px', margin: '2rem auto 0' }}>
            <h2>🔗 Share Links</h2>
            {Object.values(groupedShares).map(({ share_id, filename, max_downloads, links }) => (
              <div key={share_id} style={{ backgroundColor: '#fff', color: '#000', borderRadius: '12px', padding: '1rem', marginBottom: '1rem' }}>
                <p><strong>{filename}</strong></p>
                {links.map(({ url, type }) => (
                  <div key={type} style={{ marginBottom: '0.75rem' }}>
                    <div style={{ fontSize: '12px', color: '#555', marginBottom: '4px' }}>
                      {type === 'tor' ? '🧅 Tor (anonymous, slower)' : '🌐 Clearnet (fast, any browser)'}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                      <a href={url} target="_blank" rel="noopener noreferrer" style={{ wordBreak: 'break-all' }}>{url}</a>
                      <button onClick={() => copyToClipboard(url)} style={btnStyle}>📋 Copy</button>
                    </div>
                    <div style={{ marginTop: '8px' }}><QRCodeCanvas value={url} size={100} /></div>
                  </div>
                ))}
                <p style={{ marginTop: '8px' }}>Maximum downloads: {max_downloads}</p>
                <button onClick={() => stopShare(share_id)} style={btnStyle}>Stop Sharing</button>
              </div>
            ))}
          </div>
        )}

        {(history.length > 0 || dateRange.from || dateRange.to) && (
          <div style={{ marginTop: '2rem', maxWidth: '800px', margin: '2rem auto 0' }}>
            <h2>📜 History</h2>
            <div style={{ marginBottom: '10px', display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
              <label style={{ color: 'white' }}>Sort:
                <select value={sortOrder} onChange={e => setSortOrder(e.target.value)}
                  style={{ marginLeft: '5px', padding: '4px 8px', borderRadius: '4px' }}>
                  <option value="desc">Latest First</option>
                  <option value="asc">Earliest First</option>
                </select>
              </label>
              <label style={{ color: 'white' }}>From:
                <input type="date" value={dateRange.from}
                  onChange={e => setDateRange(prev => ({ ...prev, from: e.target.value }))}
                  style={{ marginLeft: '5px', padding: '4px 8px', borderRadius: '4px' }} />
              </label>
              <label style={{ color: 'white' }}>To:
                <input type="date" value={dateRange.to}
                  onChange={e => setDateRange(prev => ({ ...prev, to: e.target.value }))}
                  style={{ marginLeft: '5px', padding: '4px 8px', borderRadius: '4px' }} />
              </label>
              <button onClick={() => setDateRange({ from: '', to: '' })} style={{ ...btnStyle, padding: '6px 12px' }}>Clear Filters</button>
              <button onClick={fetchHistory} style={{ ...btnStyle, padding: '6px 12px' }}>🔄 Refresh</button>
            </div>

            {history.length === 0 ? (
              <p style={{ color: 'white', textAlign: 'center', marginTop: '2rem' }}>No history</p>
            ) : history.map(item => (
              <div key={item.share_id} style={{ backgroundColor: '#fff', color: '#000', borderRadius: '12px', padding: '1rem', marginBottom: '1rem' }}>
                <strong>{item.filename}</strong><br />

                <div style={{ marginTop: '6px' }}>
                  <div style={{ fontSize: '12px', color: '#555' }}>🧅 Tor</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                    <a href={item.tor_link} target="_blank" rel="noreferrer" style={{ wordBreak: 'break-all' }}>{item.tor_link}</a>
                    {item.active && (
                      <button onClick={() => copyToClipboard(item.tor_link)} style={btnStyle}>📋 Copy</button>
                    )}
                  </div>
                </div>

                {item.clearnet_link && (
                  <div style={{ marginTop: '6px' }}>
                    <div style={{ fontSize: '12px', color: '#555' }}>🌐 Clearnet</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                      <a href={item.clearnet_link} target="_blank" rel="noreferrer" style={{ wordBreak: 'break-all' }}>{item.clearnet_link}</a>
                      {item.active && (
                        <button onClick={() => copyToClipboard(item.clearnet_link)} style={btnStyle}>📋 Copy</button>
                      )}
                    </div>
                  </div>
                )}

                <div style={{ marginTop: '8px', fontSize: '14px' }}>
                  Downloads: {item.download_count} / {item.max_downloads}<br />
                  Status: <span style={{ color: item.active ? 'green' : 'red', fontWeight: 'bold' }}>
                    {item.active ? "Active" : "Expired/Stopped"}
                  </span><br />
                  Expires: {new Date(item.expires_at * 1000).toLocaleString()}
                </div>

                {item.active && (
                  <button onClick={() => stopShare(item.share_id)} style={{ marginTop: '8px', ...btnStyle }}>Stop Sharing</button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

export default App;