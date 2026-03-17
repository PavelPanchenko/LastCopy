import { useState } from 'react';
import { api } from '../api';
import ServerList from './ServerList';
import Backup from './Backup';
import History from './History';
import Settings from './Settings';

const PAGES = {
  servers: { label: 'Серверы', icon: '⬡' },
  backup: { label: 'Бэкап', icon: '↓' },
  history: { label: 'История', icon: '◷' },
  settings: { label: 'Настройки', icon: '⚙' },
};

export default function Layout({ onLogout }) {
  const [page, setPage] = useState('servers');
  const [logoError, setLogoError] = useState(false);

  const handleLogout = async () => {
    await api.logout();
    onLogout();
  };

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="sidebar-brand">
          {!logoError ? (
            <img
              src="/lastcopy-logo.png"
              alt="LastCopy"
              className="sidebar-logo-img"
              onError={() => setLogoError(true)}
            />
          ) : (
            <div className="sidebar-logo">LastCopy</div>
          )}
        </div>
        <nav className="sidebar-nav">
          {Object.entries(PAGES).map(([key, { label, icon }]) => (
            <a
              key={key}
              href="#"
              className={`sidebar-link ${page === key ? 'active' : ''}`}
              onClick={(e) => { e.preventDefault(); setPage(key); }}
            >
              <span>{icon}</span> {label}
            </a>
          ))}
        </nav>
        <button className="btn-secondary btn-sm mt-2" onClick={handleLogout}>
          Выйти
        </button>
      </aside>
      <main className="main-content">
        {page === 'servers' && <ServerList />}
        {page === 'backup' && <Backup />}
        {page === 'history' && <History />}
        {page === 'settings' && <Settings />}
      </main>
    </div>
  );
}
