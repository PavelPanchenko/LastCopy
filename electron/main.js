const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const net = require('net');
const path = require('path');

const HOST = '127.0.0.1';
const PREFERRED_PORT = 3000;

function ensureDesktopConfig() {
  const userConfigPath = path.join(app.getPath('userData'), 'config.json');
  if (fs.existsSync(userConfigPath)) return userConfigPath;

  const bundledConfigPath = path.join(app.getAppPath(), 'config.json');
  let config = {
    passwordHash: '',
    servers: [],
    backupDir: './backups',
  };

  if (fs.existsSync(bundledConfigPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(bundledConfigPath, 'utf-8'));
      config = {
        ...config,
        ...parsed,
        servers: Array.isArray(parsed.servers) ? parsed.servers : [],
      };
    } catch {
      // ignore invalid bundled config and fallback to defaults
    }
  }

  fs.mkdirSync(path.dirname(userConfigPath), { recursive: true });
  fs.writeFileSync(userConfigPath, JSON.stringify(config, null, 2), 'utf-8');
  return userConfigPath;
}

async function waitForServer(url, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${url}/api/auth/status`);
      if (res.ok || res.status === 401) return true;
    } catch {
      // server not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('Сервер не запустился вовремя');
}

async function isLastCopyServer(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1200);
    const res = await fetch(`${url}/api/auth/status`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok || res.status === 401;
  } catch {
    return false;
  }
}

function canListenOnPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, HOST);
  });
}

async function pickFreePort(start = PREFERRED_PORT, end = PREFERRED_PORT + 30) {
  for (let port = start; port <= end; port += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await canListenOnPort(port)) return port;
  }
  throw new Error('Не удалось найти свободный порт для локального сервера');
}

function createMainWindow(serverUrl) {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1080,
    minHeight: 700,
    autoHideMenuBar: true,
    title: 'LastCopy',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL(serverUrl);
}

app.whenReady().then(async () => {
  process.env.ELECTRON_APP = '1';
  process.env.LASTCOPY_CONFIG_PATH = ensureDesktopConfig();

  const preferredUrl = `http://${HOST}:${PREFERRED_PORT}`;
  let serverUrl = preferredUrl;

  if (await isLastCopyServer(preferredUrl)) {
    await waitForServer(preferredUrl, 5000);
  } else {
    const port = await pickFreePort();
    process.env.PORT = String(port);
    serverUrl = `http://${HOST}:${port}`;
    require(path.join(__dirname, '..', 'server', 'index.js'));
    await waitForServer(serverUrl);
  }
  createMainWindow(serverUrl);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow(serverUrl);
  });
}).catch((err) => {
  console.error(err);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
