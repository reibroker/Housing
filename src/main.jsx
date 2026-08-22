import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

/**
 * Restore the saved theme before first paint so the page does not flash the
 * wrong background on load.
 */
try {
  const t = localStorage.getItem('hmd:theme');
  if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
} catch {
  /* storage blocked; fall back to the OS preference */
}

/**
 * A top-level error boundary. Without one, any render-time exception -- a
 * malformed series, an unexpected null -- unmounts the whole tree and leaves a
 * blank white page with the real error only in the console.
 */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error('Dashboard crashed:', error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="app">
          <div className="notice error">
            <strong>The dashboard hit an unrecoverable error</strong>
            <pre>{this.state.error.message}</pre>
            <p className="tiny-text" style={{ marginTop: 10 }}>
              Clearing the cached data usually fixes this if a provider changed a response shape.
            </p>
            <button
              className="tiny"
              onClick={() => {
                try {
                  Object.keys(localStorage)
                    .filter((k) => k.startsWith('hmd:'))
                    .forEach((k) => localStorage.removeItem(k));
                } catch { /* ignore */ }
                location.reload();
              }}
            >
              Clear cached data and reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
