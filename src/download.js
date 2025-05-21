import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';

function Download() {
    const [status, setStatus] = useState('Loading...');
    const { shareId } = useParams();

    useEffect(() => {
        const downloadFile = async () => {
            try {
                const res = await fetch(`http://localhost:5000/download/${shareId}`);
                if (!res.ok) throw new Error('Invalid or expired link');

                const disposition = res.headers.get('Content-Disposition');
                const filenameMatch = /filename="(.+?)"/.exec(disposition);
                const filename = filenameMatch ? filenameMatch[1] : 'downloaded_file';

                const contentType = res.headers.get('Content-Type') || 'application/octet-stream';

                const stream = res.body;
                const reader = stream.getReader();
                const chunks = [];
                let receivedLength = 0;

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    chunks.push(value);
                    receivedLength += value.length;
                    console.log(`Downloaded ${receivedLength} bytes...`);
                }


                const blob = new Blob(chunks, { type: contentType });
                const url = URL.createObjectURL(blob);

                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                a.click();

                URL.revokeObjectURL(url);
                setStatus('Download complete');
            } catch (err) {
                setStatus('Invalid or expired link');
            }
        };

        downloadFile();
    }, [shareId]);

    return (
        <div className="App">
            <h1>File Download</h1>
            <p>{status}</p>
        </div>
    );
}

export default Download;
