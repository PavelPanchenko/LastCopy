const BASE = '';

async function request(url, options = {}) {
  const res = await fetch(`${BASE}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (res.status === 401) {
    window.dispatchEvent(new Event('auth:logout'));
    throw new Error('Необходима авторизация');
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Ошибка сервера');
  return data;
}

export const api = {
  authStatus: () => request('/api/auth/status'),
  login: (password) => request('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  changePassword: (currentPassword, newPassword) =>
    request('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  getSettings: () => request('/api/settings'),
  updateSettings: (backupDir) =>
    request('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ backupDir }),
    }),
  getRuntime: () => request('/api/runtime'),

  getServers: () => request('/api/servers'),
  addServer: (data) => request('/api/servers', { method: 'POST', body: JSON.stringify(data) }),
  updateServer: (id, data) => request(`/api/servers/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteServer: (id) => request(`/api/servers/${id}`, { method: 'DELETE' }),
  testServer: (id) => request(`/api/servers/${id}/test`),
  getSites: (id) => request(`/api/servers/${id}/sites`),
  getSiteTree: (id, site, relPath = '') =>
    request(`/api/servers/${id}/sites/${encodeURIComponent(site)}/tree?path=${encodeURIComponent(relPath)}`),

  startBackup: (serverId, sites, opts = {}) =>
    request('/api/backup', {
      method: 'POST',
      body: JSON.stringify({
        serverId, sites,
        mode: opts.mode || 'all',
        skipExistingDb: opts.skipExistingDb,
        skipExistingFiles: opts.skipExistingFiles,
        selectedPaths: opts.selectedPaths || {},
      }),
    }),

  cancelBackup: (backupId) =>
    request(`/api/backup/${backupId}/cancel`, { method: 'POST' }),
  cancelBackupSite: (backupId, site) =>
    request(`/api/backup/${backupId}/cancel-site`, {
      method: 'POST',
      body: JSON.stringify({ site }),
    }),

  getBackups: () => request('/api/backups'),
  deleteBackup: (server, date) =>
    request(`/api/backups?server=${encodeURIComponent(server)}&date=${encodeURIComponent(date)}`, { method: 'DELETE' }),
  deleteBackupSite: (server, date, site) =>
    request(`/api/backups?server=${encodeURIComponent(server)}&date=${encodeURIComponent(date)}&site=${encodeURIComponent(site)}`, { method: 'DELETE' }),
  openBackupSiteFolder: (server, date, site) =>
    request('/api/backups/open', {
      method: 'POST',
      body: JSON.stringify({ server, date, site }),
    }),
};

export function subscribeProgress(backupId, onEvent, handlers = {}) {
  const { onDone, onError } = handlers;
  const es = new EventSource(`${BASE}/api/backup/${backupId}/progress`);
  es.onmessage = (e) => {
    if (e.data === '[DONE]') {
      es.close();
      onDone?.();
      return;
    }
    try {
      onEvent(JSON.parse(e.data));
    } catch { /* ignore */ }
  };
  es.onerror = () => {
    es.close();
    onError?.();
  };
  return () => es.close();
}

export function downloadUrl(server, date, site, file) {
  return `${BASE}/api/backups/download?server=${encodeURIComponent(server)}&date=${encodeURIComponent(date)}&site=${encodeURIComponent(site)}&file=${encodeURIComponent(file)}`;
}

export function siteDownloadUrl(serverId, site, relPath) {
  return `${BASE}/api/servers/${encodeURIComponent(serverId)}/sites/${encodeURIComponent(site)}/download?path=${encodeURIComponent(relPath)}`;
}

export function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return '';
  if (seconds < 60) return `${seconds}с`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s > 0 ? `${m}м ${s}с` : `${m}м`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}ч ${rm}м` : `${h}ч`;
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}
