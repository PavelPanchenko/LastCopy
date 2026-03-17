const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { listSites, listSiteFiles, downloadSitePath, testConnection, runBackup, getBackupHistory } = require('./backupEngine');

const CONFIG_PATH = process.env.LASTCOPY_CONFIG_PATH
  ? path.resolve(process.env.LASTCOPY_CONFIG_PATH)
  : path.join(__dirname, '..', 'config.json');
const PORT = process.env.PORT || 3000;
const DEFAULT_CONFIG = {
  passwordHash: '',
  servers: [],
  backupDir: './backups',
};

function ensureConfigFile() {
  if (fs.existsSync(CONFIG_PATH)) return;
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
}

function loadConfig() {
  ensureConfigFile();
  const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    servers: Array.isArray(parsed.servers) ? parsed.servers : [],
  };
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

function resolveBackupDir(rawPath) {
  const value = String(rawPath || '').trim();
  if (!value) throw new Error('Укажите путь для хранения бэкапов');
  return path.isAbsolute(value) ? value : path.resolve(path.dirname(CONFIG_PATH), value);
}

function getBackupDir() {
  const config = loadConfig();
  const dir = resolveBackupDir(config.backupDir || './backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function openPathInOS(targetPath) {
  const opener = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'explorer'
      : 'xdg-open';
  const child = spawn(opener, [targetPath], { detached: true, stdio: 'ignore' });
  child.unref();
}

const app = express();
app.use(express.json());
app.use(
  session({
    secret: crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax' },
  }),
);

// --- Статика React (пре-собранная) ---
const publicDir = path.join(__dirname, 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}

// --- Middleware авторизации ---
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ error: 'Необходима авторизация' });
}

// === AUTH ===

app.get('/api/auth/status', (req, res) => {
  const config = loadConfig();
  res.json({
    authenticated: !!req.session.authenticated,
    hasPassword: !!config.passwordHash,
  });
});

app.post('/api/auth/login', async (req, res) => {
  const { password } = req.body;
  const config = loadConfig();

  if (!config.passwordHash) {
    const hash = await bcrypt.hash(password, 10);
    config.passwordHash = hash;
    saveConfig(config);
    req.session.authenticated = true;
    return res.json({ ok: true, firstSetup: true });
  }

  const valid = await bcrypt.compare(password, config.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Неверный пароль' });

  req.session.authenticated = true;
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/runtime', requireAuth, (req, res) => {
  res.json({
    desktop: process.env.ELECTRON_APP === '1',
    platform: process.platform,
  });
});

app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const config = loadConfig();

  if (!config.passwordHash) {
    return res.status(400).json({ error: 'Пароль ещё не задан' });
  }
  if (!newPassword || String(newPassword).trim().length < 6) {
    return res.status(400).json({ error: 'Новый пароль должен быть не короче 6 символов' });
  }

  const valid = await bcrypt.compare(String(currentPassword || ''), config.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Текущий пароль указан неверно' });

  config.passwordHash = await bcrypt.hash(String(newPassword), 10);
  saveConfig(config);
  res.json({ ok: true });
});

// === SETTINGS ===

app.get('/api/settings', requireAuth, (req, res) => {
  const config = loadConfig();
  const backupDir = config.backupDir || './backups';
  const backupDirAbs = resolveBackupDir(backupDir);
  res.json({ backupDir, backupDirAbs });
});

app.put('/api/settings', requireAuth, (req, res) => {
  const config = loadConfig();
  const backupDir = String(req.body?.backupDir || '').trim();

  if (!backupDir) {
    return res.status(400).json({ error: 'Укажите путь хранения бэкапов' });
  }

  let backupDirAbs;
  try {
    backupDirAbs = resolveBackupDir(backupDir);
    fs.mkdirSync(backupDirAbs, { recursive: true });
    fs.accessSync(backupDirAbs, fs.constants.W_OK);
  } catch {
    return res.status(400).json({ error: 'Путь недоступен для записи' });
  }

  config.backupDir = backupDir;
  saveConfig(config);
  res.json({ ok: true, backupDir, backupDirAbs });
});

// === SERVERS ===

app.get('/api/servers', requireAuth, (req, res) => {
  const config = loadConfig();
  const servers = (config.servers || []).map(({ password, privateKeyPassphrase, ...s }) => ({
    ...s,
    hasPassword: !!password,
    hasKey: !!s.privateKeyPath,
    hasPassphrase: !!privateKeyPassphrase,
  }));
  res.json(servers);
});

app.post('/api/servers', requireAuth, (req, res) => {
  const config = loadConfig();
  const server = {
    id: `server-${Date.now()}`,
    name: req.body.name || 'Новый сервер',
    host: req.body.host,
    port: req.body.port || 22,
    username: req.body.username || 'root',
    authType: req.body.authType || 'key',
    privateKeyPath: req.body.privateKeyPath || '',
    privateKeyPassphrase: req.body.privateKeyPassphrase || '',
    password: req.body.password || '',
    basePath: req.body.basePath || '/var/www',
  };
  config.servers = config.servers || [];
  config.servers.push(server);
  saveConfig(config);
  res.json({ ok: true, id: server.id });
});

app.put('/api/servers/:id', requireAuth, (req, res) => {
  const config = loadConfig();
  const idx = config.servers.findIndex((s) => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Сервер не найден' });

  const allowed = ['name', 'host', 'port', 'username', 'authType', 'privateKeyPath', 'privateKeyPassphrase', 'password', 'basePath'];
  for (const key of allowed) {
    if (req.body[key] !== undefined) config.servers[idx][key] = req.body[key];
  }
  saveConfig(config);
  res.json({ ok: true });
});

app.delete('/api/servers/:id', requireAuth, (req, res) => {
  const config = loadConfig();
  config.servers = config.servers.filter((s) => s.id !== req.params.id);
  saveConfig(config);
  res.json({ ok: true });
});

app.get('/api/servers/:id/test', requireAuth, async (req, res) => {
  const config = loadConfig();
  const server = config.servers.find((s) => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Сервер не найден' });

  try {
    await testConnection(server);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.get('/api/servers/:id/sites', requireAuth, async (req, res) => {
  const config = loadConfig();
  const server = config.servers.find((s) => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Сервер не найден' });

  try {
    const sites = await listSites(server);
    res.json(sites);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/servers/:id/sites/:site/tree', requireAuth, async (req, res) => {
  const config = loadConfig();
  const server = config.servers.find((s) => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Сервер не найден' });
  try {
    const tree = await listSiteFiles(server, req.params.site, req.query.path || '');
    res.json(tree);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/servers/:id/sites/:site/download', requireAuth, async (req, res) => {
  const config = loadConfig();
  const server = config.servers.find((s) => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Сервер не найден' });
  try {
    await downloadSitePath(server, req.params.site, req.query.path || '', res);
  } catch (err) {
    if (!res.headersSent) res.status(400).json({ error: err.message });
  }
});

// === BACKUP (SSE) ===

const activeBackups = new Map();

app.post('/api/backup', requireAuth, (req, res) => {
  const { serverId, sites, mode, skipExistingDb, skipExistingFiles, selectedPaths } = req.body;
  if (!serverId || !sites?.length) {
    return res.status(400).json({ error: 'Укажите сервер и сайты' });
  }

  const config = loadConfig();
  const server = config.servers.find((s) => s.id === serverId);
  if (!server) return res.status(404).json({ error: 'Сервер не найден' });

  const backupId = `backup-${Date.now()}`;
  const events = [];
  let finished = false;
  const cancelToken = {
    cancelled: false,
    kill: null,
    skippedSites: new Set(),
    currentSite: null,
    currentSiteCancelled: false,
  };

  const onProgress = (event) => {
    events.push(event);
    if (['backup_complete', 'backup_error', 'backup_cancelled'].includes(event.type)) finished = true;
  };

  activeBackups.set(backupId, { events, finished: () => finished, serverId, sites, cancelToken });

  runBackup(server, sites, getBackupDir(), onProgress, {
    mode: mode || 'all',
    skipExistingDb: !!skipExistingDb,
    skipExistingFiles: !!skipExistingFiles,
    cancelToken,
    selectedPaths: selectedPaths || {},
  }).catch((err) => {
    if (!cancelToken.cancelled) onProgress({ type: 'backup_error', error: err.message });
  });

  res.json({ backupId });
});

app.post('/api/backup/:id/cancel', requireAuth, (req, res) => {
  const backup = activeBackups.get(req.params.id);
  if (!backup) return res.status(404).json({ error: 'Бэкап не найден' });
  if (backup.finished()) return res.json({ ok: true, already: true });

  backup.cancelToken.cancelled = true;
  if (typeof backup.cancelToken.kill === 'function') {
    try { backup.cancelToken.kill(); } catch { /* ignore */ }
  }
  res.json({ ok: true });
});

app.post('/api/backup/:id/cancel-site', requireAuth, (req, res) => {
  const backup = activeBackups.get(req.params.id);
  if (!backup) return res.status(404).json({ error: 'Бэкап не найден' });
  if (backup.finished()) return res.json({ ok: true, already: true });

  const site = String(req.body?.site || '');
  if (!site) return res.status(400).json({ error: 'Укажите сайт' });
  if (!backup.sites.includes(site)) return res.status(400).json({ error: 'Сайт не входит в текущий бэкап' });

  backup.cancelToken.skippedSites.add(site);
  if (backup.cancelToken.currentSite === site && typeof backup.cancelToken.kill === 'function') {
    backup.cancelToken.currentSiteCancelled = true;
    try { backup.cancelToken.kill(); } catch { /* ignore */ }
  }
  res.json({ ok: true });
});

app.get('/api/backup/:id/progress', requireAuth, (req, res) => {
  const backup = activeBackups.get(req.params.id);
  if (!backup) return res.status(404).json({ error: 'Бэкап не найден' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  let sent = 0;
  const interval = setInterval(() => {
    while (sent < backup.events.length) {
      res.write(`data: ${JSON.stringify(backup.events[sent])}\n\n`);
      sent++;
    }
    if (backup.finished()) {
      clearInterval(interval);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }, 300);

  req.on('close', () => clearInterval(interval));
});

// === HISTORY ===

app.get('/api/backups', requireAuth, async (req, res) => {
  try {
    const history = await getBackupHistory(getBackupDir());
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/backups/open', requireAuth, (req, res) => {
  const { server, date, site } = req.body || {};
  if (!server || !date || !site) {
    return res.status(400).json({ error: 'Укажите server, date и site' });
  }
  const backupRoot = getBackupDir();
  const target = path.resolve(backupRoot, server, date, site);
  if (!target.startsWith(path.resolve(backupRoot))) {
    return res.status(400).json({ error: 'Недопустимый путь' });
  }
  if (!fs.existsSync(target)) {
    return res.status(404).json({ error: 'Папка не найдена' });
  }
  try {
    openPathInOS(target);
    return res.json({ ok: true, path: target });
  } catch {
    return res.status(500).json({ error: 'Не удалось открыть папку' });
  }
});

app.delete('/api/backups', requireAuth, (req, res) => {
  const { server, date, site } = req.query;
  if (!server || !date) {
    return res.status(400).json({ error: 'Укажите server и date' });
  }

  const target = site
    ? path.join(getBackupDir(), server, date, site)
    : path.join(getBackupDir(), server, date);

  if (!fs.existsSync(target)) {
    return res.status(404).json({ error: 'Не найдено' });
  }

  fs.rmSync(target, { recursive: true, force: true });

  const parentDir = site ? path.join(getBackupDir(), server, date) : path.join(getBackupDir(), server);
  if (fs.existsSync(parentDir) && fs.readdirSync(parentDir).length === 0) {
    fs.rmSync(parentDir, { recursive: true, force: true });
  }

  res.json({ ok: true });
});

app.get('/api/backups/download', requireAuth, (req, res) => {
  const { server, date, site, file } = req.query;
  if (!server || !date || !site || !file) {
    return res.status(400).json({ error: 'Укажите server, date, site, file' });
  }

  const allowed = ['db.sql', 'files.tar.gz'];
  if (!allowed.includes(file)) {
    return res.status(400).json({ error: 'Недопустимый файл' });
  }

  const siteDir = path.join(getBackupDir(), server, date, site);
  const filePath = path.join(siteDir, file);

  if (file === 'files.tar.gz' && !fs.existsSync(filePath)) {
    const filesDir = path.join(siteDir, 'files');
    if (!fs.existsSync(filesDir)) {
      return res.status(404).json({ error: 'Файл не найден' });
    }
    const { execSync } = require('child_process');
    const tmpTar = filePath;
    try {
      execSync(`tar czf "${tmpTar}" -C "${siteDir}" files`);
      return res.download(tmpTar, `${site}_${date}_${file}`);
    } catch (err) {
      return res.status(500).json({ error: 'Не удалось создать архив' });
    }
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Файл не найден' });
  }

  res.download(filePath, `${site}_${date}_${file}`);
});

// --- SPA fallback ---
app.get('*', (req, res) => {
  const indexPath = path.join(publicDir, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Frontend не собран. Запустите: npm run build');
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`LastCopy запущен: http://localhost:${PORT}`);

  if (process.env.NODE_ENV !== 'development' && process.env.ELECTRON_APP !== '1') {
    const { exec } = require('child_process');
    const url = `http://localhost:${PORT}`;
    const cmd =
      process.platform === 'darwin' ? `open ${url}` :
      process.platform === 'win32' ? `start ${url}` :
      `xdg-open ${url}`;
    exec(cmd);
  }
});
