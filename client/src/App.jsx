import { useState, useEffect } from 'react';
import { api } from './api';
import Login from './components/Login';
import Layout from './components/Layout';

export default function App() {
  const [auth, setAuth] = useState(null); // null = loading
  const [hasPassword, setHasPassword] = useState(true);

  const checkAuth = async () => {
    try {
      const status = await api.authStatus();
      setAuth(status.authenticated);
      setHasPassword(status.hasPassword);
    } catch {
      setAuth(false);
    }
  };

  useEffect(() => {
    checkAuth();
    const handler = () => setAuth(false);
    window.addEventListener('auth:logout', handler);
    return () => window.removeEventListener('auth:logout', handler);
  }, []);

  if (auth === null) {
    return (
      <div className="login-page">
        <div className="spinner" />
      </div>
    );
  }

  if (!auth) {
    return (
      <Login
        isFirstSetup={!hasPassword}
        onLogin={() => setAuth(true)}
      />
    );
  }

  return <Layout onLogout={() => setAuth(false)} />;
}
