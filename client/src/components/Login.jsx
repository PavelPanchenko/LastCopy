import { useState } from 'react';
import { api } from '../api';

export default function Login({ isFirstSetup, onLogin }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [logoError, setLogoError] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!password.trim()) return;
    setLoading(true);
    setError('');
    try {
      await api.login(password);
      onLogin();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-box">
        {!logoError && (
          <img
            src="/lastcopy-logo.png"
            alt="LastCopy"
            className="login-logo-img"
            onError={() => setLogoError(true)}
          />
        )}
        <h1>LastCopy</h1>
        <p>
          {isFirstSetup
            ? 'Автоматическое резервное копирование сайтов и серверов на ваш компьютер без сложной настройки. Первый запуск: задайте пароль.'
            : 'Автоматическое резервное копирование сайтов и серверов на ваш компьютер без сложной настройки.'}
        </p>
        <form className="login-form" onSubmit={handleSubmit}>
          <input
            type="password"
            placeholder={isFirstSetup ? 'Придумайте пароль' : 'Пароль'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
          />
          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? <span className="spinner" /> : isFirstSetup ? 'Создать' : 'Войти'}
          </button>
          {error && <div className="error-text">{error}</div>}
        </form>
      </div>
    </div>
  );
}
