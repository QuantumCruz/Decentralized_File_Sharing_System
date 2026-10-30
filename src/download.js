import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

function Download() {
    const { shareId } = useParams();
    const [status, setStatus] = useState('Preparing download...');
    const [error, setError] = useState(null);

    const baseUrl = window.location.origin.includes('localhost')
        ? 'http://localhost:5000'
        : window.location.origin;

    useEffect(() => {
        const startDownload = async () => {
            try {
                setStatus('Checking file...');

                const check = await fetch(`${baseUrl}/status/${shareId}`);

                if (!check.ok) {
                    setError('Invalid or expired link');
                    return;
                }

                const data = await check.json();

                if (!data.active) {
                    setError('This share link is no longer active');
                    return;
                }

                setStatus('Starting download...');

                const a = document.createElement('a');
                a.href = `${baseUrl}/download/${shareId}`;
                a.rel = 'noopener noreferrer';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);

                setStatus('Download started. Check your browser downloads.');
            } catch (err) {
                setError(`Download failed: ${err.message}`);
            }
        };

        startDownload();
    }, [shareId, baseUrl]);

    const containerStyle = {
        minHeight: '100vh',
        backgroundColor: '#0b0f2b',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'Inter, sans-serif',
        color: 'white',
        padding: '2rem',
    };

    const cardStyle = {
        backgroundColor: '#fff',
        color: '#000',
        borderRadius: '12px',
        padding: '2rem',
        maxWidth: '480px',
        width: '100%',
        textAlign: 'center',
        boxShadow: '0 4px 24px rgba(0,0,0,0.2)',
    };

    return (
        <div style={containerStyle}>
            <div style={cardStyle}>
                {error ? (
                    <>
                        <div style={{ fontSize: '2rem' }}>❌</div>
                        <h2>Download Failed</h2>
                        <p style={{ color: '#dc2626' }}>{error}</p>
                    </>
                ) : (
                    <>
                        <div style={{ fontSize: '2rem' }}>📥</div>
                        <h2>Downloading File</h2>
                        <p style={{ marginTop: '1rem', color: '#333' }}>{status}</p>
                    </>
                )}
            </div>
        </div>
    );
}

export default Download;