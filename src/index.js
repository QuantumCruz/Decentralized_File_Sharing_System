import React from 'react';
import ReactDOM from 'react-dom/client';
import {
  HashRouter,
  Routes,
  Route
} from 'react-router-dom';

import App from './App';
import Download from './download';
import './preview_branding.css';

// Only explicit loopback OWNER ports render the management dashboard.
// Public services use separate ports and never expose owner API routes.
const ownerPorts = new Set([
  '15300',
  '25300'
]);

const isOwner = (
  window.location.hostname === '127.0.0.1' &&
  ownerPorts.has(window.location.port)
);

function PublicLanding() {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
        background: '#0b0f2b',
        color: '#fff',
        fontFamily: 'Inter, Arial, sans-serif'
      }}
    >
      <section
        style={{
          textAlign: 'center',
          maxWidth: 450
        }}
      >
        <h1>FileShare</h1>
        <p>
          Use the private sharing link you received
          to download a file.
        </p>
      </section>
    </main>
  );
}

ReactDOM.createRoot(
  document.getElementById('root')
).render(
  <HashRouter>
    <Routes>
      <Route
        path="/"
        element={
          isOwner
            ? <App />
            : <PublicLanding />
        }
      />
      <Route
        path="/get/:shareId"
        element={<Download />}
      />
    </Routes>
  </HashRouter>
);