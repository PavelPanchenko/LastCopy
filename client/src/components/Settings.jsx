import { useEffect, useState } from 'react';
import { api } from '../api';

export default function Settings() {
  const [loading, setLoading] = useState(true);
  const [backupDir, setBackupDir] = useState('');
  const [backupDirAbs, setBackupDirAbs] = useState('');
  const [savingPath, setSavingPath] = useState(false);
  const [pathMsg, setPathMsg] = useState('');
  const [pathErr, setPathErr] = useState('');

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);
  const [passMsg, setPassMsg] = useState('');
  const [passErr, setPassErr] = useState('');

  const loadSettings = async () => {
    setLoading(true);
    setPathErr('');
    try {
      const data = await api.getSettings();
      setBackupDir(data.backupDir || '');
      setBackupDirAbs(data.backupDirAbs || '');
    } catch (err) {
      setPathErr(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadSettings(); }, []);

  const handleSavePath = async (e) => {
    e.preventDefault();
    setPathErr('');
    setPathMsg('');
    if (!backupDir.trim()) {
      setPathErr('Укажите путь хранения бэкапов');
      return;
    }
    setSavingPath(true);
    try {
      const data = await api.updateSettings(backupDir.trim());
      setBackupDir(data.backupDir || backupDir.trim());
      setBackupDirAbs(data.backupDirAbs || '');
      setPathMsg('Путь сохранён');
    } catch (err) {
      setPathErr(err.message);
    } finally {
      setSavingPath(false);
    }
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    setPassErr('');
    setPassMsg('');
    if (!currentPassword.trim()) return setPassErr('Введите текущий пароль');
    if (newPassword.length < 6) return setPassErr('Новый пароль должен быть не короче 6 символов');
    if (newPassword !== confirmPassword) return setPassErr('Пароли не совпадают');

    setSavingPassword(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      setPassMsg('Пароль изменён');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setPassErr(err.message);
    } finally {
      setSavingPassword(false);
    }
  };

  return (
    <div>
      <h1 className="page-title">Настройки</h1>

      <div className="settings-grid">
        <div className="card settings-card">
          <h3>Путь хранения бэкапов</h3>
          {loading ? (
            <div className="empty-state"><span className="spinner" /></div>
          ) : (
            <form onSubmit={handleSavePath}>
              <label>Путь (относительный или абсолютный)</label>
              <input
                value={backupDir}
                onChange={(e) => setBackupDir(e.target.value)}
                placeholder="./backups"
              />
              {backupDirAbs && (
                <p className="text-dim text-sm mt-1">Текущий абсолютный путь: {backupDirAbs}</p>
              )}
              <div className="settings-actions mt-2">
                <button className="btn-primary" type="submit" disabled={savingPath}>
                  {savingPath ? <span className="spinner" /> : 'Сохранить путь'}
                </button>
              </div>
              {pathErr && <div className="error-text mt-1">{pathErr}</div>}
              {pathMsg && <div className="success-text mt-1">{pathMsg}</div>}
            </form>
          )}
        </div>

        <div className="card settings-card">
          <h3>Смена пароля</h3>
          <form onSubmit={handleChangePassword}>
            <label>Текущий пароль</label>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />

            <label className="mt-1">Новый пароль</label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />

            <label className="mt-1">Повторите новый пароль</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />

            <div className="settings-actions mt-2">
              <button className="btn-primary" type="submit" disabled={savingPassword}>
                {savingPassword ? <span className="spinner" /> : 'Сменить пароль'}
              </button>
            </div>
            {passErr && <div className="error-text mt-1">{passErr}</div>}
            {passMsg && <div className="success-text mt-1">{passMsg}</div>}
          </form>
        </div>
      </div>
    </div>
  );
}
