import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';

class ErrorBoundary extends React.Component {
  state = { hasError: false, error: null, appKey: 0 };

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  handleDismiss = () => {
    this.setState((s) => ({ hasError: false, error: null, appKey: s.appKey + 1 }));
  };

  render() {
    if (this.state.hasError && this.state.error) {
      const msg = this.state.error.message || '';
      const isLikelyExtension = /MetaMask|ethereum|wallet|extension/i.test(msg);
      return (
        <div style={{
          padding: 24,
          maxWidth: 480,
          margin: '40px auto',
          background: '#1a1a1a',
          color: '#eee',
          borderRadius: 12,
          fontFamily: 'system-ui, sans-serif',
          boxShadow: '0 4px 20px rgba(0,0,0,0.3)'
        }}>
          <h2 style={{ color: '#f55', marginBottom: 12 }}>Something went wrong</h2>
          {isLikelyExtension ? (
            <p style={{ marginBottom: 16, lineHeight: 1.5 }}>
              This error often comes from a <strong>browser extension</strong> (e.g. MetaMask) injecting into the page.
              Try disabling extensions for this site or use a different browser/profile, then refresh.
            </p>
          ) : (
            <p style={{ marginBottom: 16, lineHeight: 1.5, color: '#aaa' }}>{msg}</p>
          )}
          <button
            type="button"
            onClick={this.handleDismiss}
            style={{
              padding: '10px 20px',
              background: '#2d8cff',
              color: 'white',
              border: 'none',
              borderRadius: 8,
              cursor: 'pointer',
              fontWeight: 600
            }}
          >
            Dismiss and reload app
          </button>
        </div>
      );
    }
    return <App key={this.state.appKey} />;
  }
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <ErrorBoundary />
  </React.StrictMode>
);
