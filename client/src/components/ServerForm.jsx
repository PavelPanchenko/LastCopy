import { useState } from 'react';

export default function ServerForm({ server, onSave, onClose }) {
  const [form, setForm] = useState({
    name: server?.name || '',
    host: server?.host || '',
    port: server?.port || 22,
    username: server?.username || 'root',
    authType: server?.authType || 'agent',
    privateKeyPath: server?.privateKeyPath || '~/.ssh/id_rsa',
    privateKeyPassphrase: '',
    password: '',
    basePath: server?.basePath || '/var/www',
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.host.trim()) return setError('Укажите хост');
    const payload = { ...form };
    if (payload.authType === 'key' && !payload.privateKeyPassphrase.trim()) {
      delete payload.privateKeyPassphrase;
    }
    if (payload.authType === 'password' && !payload.password.trim()) {
      delete payload.password;
    }
    setSaving(true);
    setError('');
    try {
      await onSave(payload);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{server ? 'Редактировать сервер' : 'Новый сервер'}</h2>
        <form onSubmit={handleSubmit}>
          <div className="form-grid">
            <div className="form-full">
              <label>Название</label>
              <input value={form.name} onChange={set('name')} placeholder="Мой сервер" />
            </div>
            <div>
              <label>Хост (IP или домен)</label>
              <input value={form.host} onChange={set('host')} placeholder="192.168.1.1" required />
            </div>
            <div>
              <label>Порт</label>
              <input type="number" value={form.port} onChange={set('port')} />
            </div>
            <div>
              <label>Пользователь</label>
              <input value={form.username} onChange={set('username')} />
            </div>
            <div>
              <label>Авторизация</label>
              <select value={form.authType} onChange={set('authType')}>
                <option value="agent">SSH Agent (рекомендуется)</option>
                <option value="key">SSH-ключ (файл)</option>
                <option value="password">Пароль</option>
              </select>
            </div>
            {form.authType === 'agent' && (
              <div className="form-full">
                <span className="text-dim text-sm">
                  Используется системный SSH Agent. Если в терминале ssh работает без ввода пароля — здесь тоже будет работать.
                </span>
              </div>
            )}
            {form.authType === 'key' && (
              <>
                <div className="form-full">
                  <label>Путь к SSH-ключу</label>
                  <input value={form.privateKeyPath} onChange={set('privateKeyPath')} />
                </div>
                <div className="form-full">
                  <label>Passphrase ключа (если есть)</label>
                  <input
                    type="password"
                    value={form.privateKeyPassphrase}
                    onChange={set('privateKeyPassphrase')}
                    placeholder={server ? 'Оставьте пустым, чтобы не менять' : ''}
                  />
                </div>
              </>
            )}
            {form.authType === 'password' && (
              <div className="form-full">
                <label>Пароль SSH</label>
                <input type="password" value={form.password} onChange={set('password')} />
              </div>
            )}
            <div className="form-full">
              <label>Базовый путь к сайтам</label>
              <input value={form.basePath} onChange={set('basePath')} placeholder="/var/www" />
            </div>
          </div>
          {error && <div className="error-text">{error}</div>}
          <div className="form-actions">
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? <span className="spinner" /> : 'Сохранить'}
            </button>
            <button type="button" className="btn-secondary" onClick={onClose}>
              Отмена
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
