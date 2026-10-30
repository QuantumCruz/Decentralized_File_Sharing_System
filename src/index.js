import React from 'react';
import ReactDOM from 'react-dom/client';

import {
  HashRouter,
  Route,
  Routes
} from 'react-router-dom';

import App from './App';
import Download from './download';


const isDevelopmentOwner = (
  window.location.hostname === '127.0.0.1' &&
  window.location.port === '15300'
);


function PublicLanding() {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: '#0b0f2b',
        color: '#fff',
        fontFamily: 'sans-serif'
      }}
    >
      <section
        style={{
          padding: 24,
          textAlign: 'center'
        }}
      >
        <h1>Private FileShare</h1>

        <p>
          Open the secure link you received
          to retrieve your file.
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
          isDevelopmentOwner
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