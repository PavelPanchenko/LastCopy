import { useState, useEffect } from 'react';
import { api } from '../api';
import ServerForm from './ServerForm';

export default function ServerList() {
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // null | 'new' | server object
  const [testResults, setTestResults] = useState({});

  const load = async () => {
    setLoading(true);
    try {
      setServers(await api.getServers());
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const handleTest = async (id) => {
    setTestResults((r) => ({ ...r, [id]: 'loading' }));
    try {
      const res = await api.testServer(id);
      setTestResults((r) => ({ ...r, [id]: res.ok ? 'ok' : res.error }));
    } catch (err) {
      setTestResults((r) => ({ ...r, [id]: err.message }));
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Удалить сервер?')) return;
    await api.deleteServer(id);
    load();
  };

  const handleSave = async (data) => {
    if (editing === 'new') {
      await api.addServer(data);
    } else {
      await api.updateServer(editing.id, data);
    }
    setEditing(null);
    load();
  };

  return (
    <div>
      <div className="flex-between">
        <h1 className="page-title">Серверы</h1>
        <button className="btn-primary" onClick={() => setEditing('new')}>
          + Добавить
        </button>
      </div>

      {loading ? (
        <div className="empty-state"><span className="spinner" /></div>
      ) : servers.length === 0 ? (
        <div className="empty-state">
          <p>Нет серверов</p>
          <p className="text-dim text-sm mt-1">Добавьте сервер для начала работы</p>
        </div>
      ) : (
        <div className="server-grid">
          {servers.map((s) => (
            <div key={s.id} className="card server-item">
              <div className="server-info">
                <h3>{s.name}</h3>
                <span>{s.username}@{s.host}:{s.port} &middot; {s.basePath}</span>
                <div className="mt-1">
                  {s.authType === 'agent' && <span className="badge badge-info">SSH Agent</span>}
                  {s.authType === 'key' && (
                    <>
                      <span className="badge badge-info">SSH-ключ</span>{' '}
                      {s.hasPassphrase && <span className="badge badge-warning">с passphrase</span>}
                    </>
                  )}
                  {s.authType === 'password' && <span className="badge badge-info">Пароль SSH</span>}
                </div>
                {testResults[s.id] && testResults[s.id] !== 'loading' && (
                  <div className="mt-1">
                    {testResults[s.id] === 'ok' ? (
                      <span className="badge badge-success">Подключён</span>
                    ) : (
                      <span className="badge badge-danger">{testResults[s.id]}</span>
                    )}
                  </div>
                )}
              </div>
              <div className="server-actions">
                <button
                  className="btn-secondary btn-sm"
                  onClick={() => handleTest(s.id)}
                  disabled={testResults[s.id] === 'loading'}
                >
                  {testResults[s.id] === 'loading' ? <span className="spinner" /> : 'Тест'}
                </button>
                <button className="btn-secondary btn-sm" onClick={() => setEditing(s)}>
                  Изменить
                </button>
                <button className="btn-danger btn-sm" onClick={() => handleDelete(s.id)}>
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <ServerForm
          server={editing === 'new' ? null : editing}
          onSave={handleSave}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
