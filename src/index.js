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


// These ports belong to the isolated development,
// preview and stable application respectively.
// Actual authentication is always enforced by the backend.
const ownerPorts = new Set([
  '15300',
  '25300',
  '35300'
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