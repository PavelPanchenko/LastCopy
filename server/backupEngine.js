const { Client } = require('ssh2');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { CONFIG_FILES, parseDbConfig } = require('./dbParsers');

const SSH_TIMEOUT = 15000;

const EXCLUDE_PATTERNS = [
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'vendor/cache',
  'cache',
  'wp-content/cache',
  'wp-content/w3tc-config',
  'wp-content/advanced-cache.php',
  'wp-content/object-cache.php',
  'wp-content/updraft',
  'wp-content/backup-db',
  'wp-content/backups',
  'wp-content/ai1wm-backups',
  'wp-content/uploads/backup*',
  'wp-content/debug.log',
  '*.log',
  '*.tmp',
  '*.swp',
  '*.bak',
  'tmp',
  'temp',
  'logs',
  '.DS_Store',
  'Thumbs.db',
  'error_log',
  '.env.backup',
  'core',
];
const DB_DONE_MARKER = 'db.done';
const FILES_DONE_MARKER = 'files.done';
const FILES_PARTIAL_MARKER = 'files.partial';

let _hasRsync = null;
let _rsyncHasProgress2 = null;

function hasRsync() {
  if (_hasRsync === null) {
    try {
      execSync('rsync --version', { stdio: 'ignore' });
      _hasRsync = true;
    } catch {
      _hasRsync = false;
    }
  }
  return _hasRsync;
}

function rsyncHasProgress2() {
  if (_rsyncHasProgress2 === null) {
    try {
      const out = execSync('rsync --version 2>/dev/null').toString();
      const m = out.match(/rsync\s+version\s+(\d+)\.(\d+)/);
      if (m) {
        const major = parseInt(m[1], 10);
        const minor = parseInt(m[2], 10);
        _rsyncHasProgress2 = major > 3 || (major === 3 && minor >= 1);
      } else {
        _rsyncHasProgress2 = false;
      }
    } catch {
      _rsyncHasProgress2 = false;
    }
  }
  return _rsyncHasProgress2;
}

function buildSSHCmd(serverConfig) {
  const parts = [
    'ssh',
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'BatchMode=yes',
    '-p',
    String(serverConfig.port || 22),
  ];
  if (serverConfig.privateKeyPath) {
    parts.push('-i', resolveKeyPath(serverConfig.privateKeyPath));
  }
  return parts.join(' ');
}

function rsyncFiles(serverConfig, remotePath, localDir, onBytes, cancelToken) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(localDir, { recursive: true });
    const sshCmd = buildSSHCmd(serverConfig);
    const src = `${serverConfig.username}@${serverConfig.host}:${remotePath}/`;
    const excludeArgs = EXCLUDE_PATTERNS.flatMap((p) => ['--exclude', p]);
    const useProgress2 = rsyncHasProgress2();
    const progressArgs = useProgress2
      ? ['--info=progress2', '--no-inc-recursive']
      : ['--progress'];
    const args = [
      '-az', '--delete',
      ...progressArgs,
      ...excludeArgs,
      '-e', sshCmd,
      src, localDir + '/',
    ];

    const proc = spawn('rsync', args, {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (cancelToken) cancelToken.kill = () => proc.kill('SIGTERM');

    let lastReport = 0;
    let totalBytes = 0;
    let completedBytes = 0;
    let currentFileBytes = 0;
    let stderr = '';

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      if (useProgress2) {
        const bytesMatch = text.match(/([\d,]+)\s+\d+%/);
        if (bytesMatch) {
          totalBytes = parseInt(bytesMatch[1].replace(/,/g, ''), 10) || 0;
        }
      } else {
        for (const line of text.split('\n')) {
          const m = line.match(/([\d,]+)\s+(\d+)%/);
          if (m) {
            currentFileBytes = parseInt(m[1].replace(/,/g, ''), 10) || 0;
            if (m[2] === '100') {
              completedBytes += currentFileBytes;
              currentFileBytes = 0;
            }
            totalBytes = completedBytes + currentFileBytes;
          }
        }
      }
      const now = Date.now();
      if (onBytes && now - lastReport >= PROGRESS_INTERVAL_MS) {
        lastReport = now;
        onBytes(totalBytes);
      }
    });

    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (cancelToken?.cancelled) return reject(new Error('Отменено'));
      if (code !== 0 && code !== 23 && code !== 24) {
        reject(new Error(stderr || `rsync завершился с кодом ${code}`));
      } else {
        resolve(totalBytes);
      }
    });
    proc.on('error', (err) => reject(new Error(`rsync не удалось запустить: ${err.message}`)));
  });
}

function rsyncFilesFrom(serverConfig, remoteBase, localDir, filesFromPath, onBytes, cancelToken) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(localDir, { recursive: true });
    const sshCmd = buildSSHCmd(serverConfig);
    const src = `${serverConfig.username}@${serverConfig.host}:${remoteBase}/`;
    const excludeArgs = EXCLUDE_PATTERNS.flatMap((p) => ['--exclude', p]);
    const useProgress2 = rsyncHasProgress2();
    const progressArgs = useProgress2
      ? ['--info=progress2', '--no-inc-recursive']
      : ['--progress'];
    const args = [
      '-az',
      ...progressArgs,
      `--files-from=${filesFromPath}`,
      ...excludeArgs,
      '-e', sshCmd,
      src, localDir + '/',
    ];

    const proc = spawn('rsync', args, {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (cancelToken) cancelToken.kill = () => proc.kill('SIGTERM');

    let lastReport = 0;
    let totalBytes = 0;
    let completedBytes = 0;
    let currentFileBytes = 0;
    let stderr = '';

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      if (useProgress2) {
        const bytesMatch = text.match(/([\d,]+)\s+\d+%/);
        if (bytesMatch) {
          totalBytes = parseInt(bytesMatch[1].replace(/,/g, ''), 10) || 0;
        }
      } else {
        for (const line of text.split('\n')) {
          const m = line.match(/([\d,]+)\s+(\d+)%/);
          if (m) {
            currentFileBytes = parseInt(m[1].replace(/,/g, ''), 10) || 0;
            if (m[2] === '100') {
              completedBytes += currentFileBytes;
              currentFileBytes = 0;
            }
            totalBytes = completedBytes + currentFileBytes;
          }
        }
      }
      const now = Date.now();
      if (onBytes && now - lastReport >= PROGRESS_INTERVAL_MS) {
        lastReport = now;
        onBytes(totalBytes);
      }
    });

    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (cancelToken?.cancelled) return reject(new Error('Отменено'));
      if (code !== 0 && code !== 23 && code !== 24) {
        reject(new Error(stderr || `rsync завершился с кодом ${code}`));
      } else {
        resolve(totalBytes);
      }
    });
    proc.on('error', (err) => reject(new Error(`rsync не удалось запустить: ${err.message}`)));
  });
}

function getDirSize(dir) {
  let size = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) size += getDirSize(p);
    else size += fs.statSync(p).size;
  }
  return size;
}

function resolveKeyPath(p) {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return path.resolve(p);
}

function createSSHConnection(serverConfig) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const opts = {
      host: serverConfig.host,
      port: serverConfig.port || 22,
      username: serverConfig.username,
      readyTimeout: SSH_TIMEOUT,
    };

    if (serverConfig.authType === 'agent') {
      opts.agent = process.env.SSH_AUTH_SOCK;
    } else if (serverConfig.authType === 'key' && serverConfig.privateKeyPath) {
      try {
        opts.privateKey = fs.readFileSync(resolveKeyPath(serverConfig.privateKeyPath));
        if (serverConfig.privateKeyPassphrase) {
          opts.passphrase = serverConfig.privateKeyPassphrase;
        }
      } catch (err) {
        return reject(new Error(`SSH-ключ не найден: ${serverConfig.privateKeyPath}`));
      }
    } else if (serverConfig.password) {
      opts.password = serverConfig.password;
    }

    conn.on('ready', () => resolve(conn));
    conn.on('error', (err) => reject(new Error(`SSH ошибка (${serverConfig.host}): ${err.message}`)));
    conn.connect(opts);
  });
}

function sshExec(conn, command) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      stream.on('data', (data) => { stdout += data.toString(); });
      stream.stderr.on('data', (data) => { stderr += data.toString(); });
      stream.on('close', (code) => {
        if (code !== 0 && !stdout) {
          reject(new Error(stderr || `Команда завершилась с кодом ${code}`));
        } else {
          resolve(stdout);
        }
      });
    });
  });
}

const PROGRESS_INTERVAL_MS = 500;
const MODE_MASK = 0o170000;
const MODE_DIR = 0o040000;

function assertSiteName(site) {
  if (!site || site.includes('/') || site.includes('\\') || site.includes('..')) {
    throw new Error('Недопустимое имя сайта');
  }
}

function normalizeRelativePath(relPath = '') {
  const raw = String(relPath || '').replace(/\\/g, '/');
  const parts = raw.split('/').filter(Boolean);
  if (parts.some((p) => p === '..')) throw new Error('Недопустимый путь');
  return parts.join('/');
}

function q(str) {
  return `'${String(str).replace(/'/g, `'\\''`)}'`;
}

function sftpGet(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.stat(remotePath, (err, stats) => {
      if (err) return reject(err);
      resolve(stats);
    });
  });
}

function sftpReadDir(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.readdir(remotePath, (err, list) => {
      if (err) return reject(err);
      resolve(list || []);
    });
  });
}

function sshExecToFile(conn, command, destPath, onBytes, cancelToken) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      const ws = fs.createWriteStream(destPath);
      let totalBytes = 0;
      let stderr = '';
      let lastReport = 0;

      if (cancelToken) cancelToken.kill = () => {
        cancelToken.currentSiteCancelled = true;
        stream.close();
        ws.end();
      };

      stream.on('data', (data) => {
        totalBytes += data.length;
        ws.write(data);
        const now = Date.now();
        if (onBytes && now - lastReport >= PROGRESS_INTERVAL_MS) {
          lastReport = now;
          onBytes(totalBytes);
        }
      });
      stream.stderr.on('data', (data) => { stderr += data.toString(); });
      stream.on('close', (code) => {
        ws.end();
        if (cancelToken?.cancelled || cancelToken?.currentSiteCancelled) {
          return reject(new Error('Отменено'));
        }
        if (code !== 0 && totalBytes === 0) {
          reject(new Error(stderr || `Код ${code}`));
        } else {
          resolve(totalBytes);
        }
      });
      stream.on('error', reject);
      ws.on('error', reject);
    });
  });
}

async function listSites(serverConfig) {
  const conn = await createSSHConnection(serverConfig);
  try {
    const output = await sshExec(conn, `ls -1 ${serverConfig.basePath}`);
    return output.trim().split('\n').filter(Boolean);
  } finally {
    conn.end();
  }
}

async function testConnection(serverConfig) {
  const conn = await createSSHConnection(serverConfig);
  conn.end();
  return true;
}

async function detectDbCredentials(conn, sitePath) {
  for (const { filename } of CONFIG_FILES) {
    const filePath = `${sitePath}/${filename}`;
    try {
      const content = await sshExec(conn, `cat "${filePath}" 2>/dev/null`);
      if (content.trim()) {
        const creds = parseDbConfig(filename, content);
        if (creds) return creds;
      }
    } catch {
      // файл не найден — пробуем следующий
    }
  }
  return null;
}

async function listSiteFiles(serverConfig, site, relPath = '') {
  assertSiteName(site);
  const safeRel = normalizeRelativePath(relPath);
  const siteRoot = path.posix.join(serverConfig.basePath, site);
  const target = safeRel ? path.posix.join(siteRoot, safeRel) : siteRoot;

  const conn = await createSSHConnection(serverConfig);
  try {
    const list = await new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => {
        if (err) return reject(err);
        resolve(sftp);
      });
    });

    const stats = await sftpGet(list, target);
    const isDir = (stats.mode & MODE_MASK) === MODE_DIR;
    if (!isDir) throw new Error('Путь должен быть папкой');

    const entriesRaw = await sftpReadDir(list, target);
    const entries = entriesRaw
      .filter((e) => e.filename !== '.' && e.filename !== '..')
      .map((e) => {
        const isDirectory = (e.attrs.mode & MODE_MASK) === MODE_DIR;
        const childRel = safeRel ? `${safeRel}/${e.filename}` : e.filename;
        return {
          name: e.filename,
          type: isDirectory ? 'dir' : 'file',
          size: e.attrs.size || 0,
          mtime: e.attrs.mtime || 0,
          path: childRel,
        };
      })
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : (a.type === 'dir' ? -1 : 1)));

    const parent = safeRel.includes('/') ? safeRel.split('/').slice(0, -1).join('/') : '';
    return { path: safeRel, parent, entries };
  } finally {
    conn.end();
  }
}

async function downloadSitePath(serverConfig, site, relPath, res) {
  assertSiteName(site);
  const safeRel = normalizeRelativePath(relPath);
  if (!safeRel) throw new Error('Укажите путь к файлу или папке');

  const siteRoot = path.posix.join(serverConfig.basePath, site);
  const remotePath = path.posix.join(siteRoot, safeRel);

  const conn = await createSSHConnection(serverConfig);
  conn.sftp((err, sftp) => {
    if (err) {
      conn.end();
      if (!res.headersSent) res.status(500).json({ error: err.message });
      return;
    }

    sftp.stat(remotePath, (statErr, stats) => {
      if (statErr) {
        conn.end();
        if (!res.headersSent) res.status(404).json({ error: 'Файл или папка не найдены' });
        return;
      }

      const isDir = (stats.mode & MODE_MASK) === MODE_DIR;
      if (isDir) {
        const parent = path.posix.dirname(remotePath);
        const base = path.posix.basename(remotePath);
        const filename = `${base}.tar.gz`;
        res.setHeader('Content-Type', 'application/gzip');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

        const cmd = `tar czf - -C ${q(parent)} ${q(base)} 2>/dev/null`;
        conn.exec(cmd, (execErr, stream) => {
          if (execErr) {
            conn.end();
            if (!res.headersSent) res.status(500).json({ error: execErr.message });
            return;
          }
          stream.pipe(res);
          stream.on('close', () => conn.end());
          stream.on('error', () => conn.end());
          res.on('close', () => conn.end());
        });
      } else {
        const filename = path.posix.basename(remotePath);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        const rs = sftp.createReadStream(remotePath);
        rs.pipe(res);
        rs.on('close', () => conn.end());
        rs.on('error', () => conn.end());
        res.on('close', () => conn.end());
      }
    });
  });
}

/**
 * Выполняет бэкап выбранных сайтов.
 * @param {object} serverConfig — конфиг сервера из config.json
 * @param {string[]} sites — массив имён сайтов
 * @param {string} backupDir — корневая папка для бэкапов
 * @param {function} onProgress — коллбэк (event) для SSE
 * @returns {object} результат бэкапа
 */
async function runBackup(serverConfig, sites, backupDir, onProgress, options = {}) {
  const startedAt = new Date();
  const date = startedAt.toISOString().slice(0, 10);
  const serverDir = serverConfig.host.replace(/[^a-zA-Z0-9.-]/g, '_');
  const backupPath = path.join(backupDir, serverDir, date);
  fs.mkdirSync(backupPath, { recursive: true });

  const rsyncAvailable = hasRsync();
  const mode = options.mode || 'all';
  const skipDb = options.skipExistingDb ?? false;
  const skipFiles = options.skipExistingFiles ?? false;
  const cancelToken = options.cancelToken || {};
  const doDb = mode === 'all' || mode === 'db';
  const doFiles = mode === 'all' || mode === 'files';
  const selectedPathsMap = options.selectedPaths || {};

  const conn = await createSSHConnection(serverConfig);
  const results = [];

  try {
    for (let i = 0; i < sites.length; i++) {
      if (cancelToken.cancelled) break;

      const site = sites[i];
      const isSiteCancelled = () => !!cancelToken.skippedSites?.has(site);
      const canUseRsync = rsyncAvailable && serverConfig.authType !== 'password';
      const sitePath = `${serverConfig.basePath}/${site}`;
      const siteBackupDir = path.join(backupPath, site);
      cancelToken.currentSite = site;
      cancelToken.currentSiteCancelled = false;
      const filesPartialPath = path.join(siteBackupDir, FILES_PARTIAL_MARKER);

      if (isSiteCancelled()) {
        const existingSize = fs.existsSync(siteBackupDir) ? getDirSize(siteBackupDir) : 0;
        results.push({ site, db: { skipped: true }, files: { skipped: true }, duration: 0 });
        onProgress({
          type: 'site_skip', site, current: i + 1, total: sites.length,
          reason: 'Пропущен пользователем',
          size: existingSize,
        });
        continue;
      }

      const hasExistingFiles = fs.existsSync(path.join(siteBackupDir, 'files'))
        || fs.existsSync(path.join(siteBackupDir, 'files.tar.gz'));
      const hasExistingDb = fs.existsSync(path.join(siteBackupDir, 'db.sql'));
      const dbDonePath = path.join(siteBackupDir, DB_DONE_MARKER);
      const filesDonePath = path.join(siteBackupDir, FILES_DONE_MARKER);
      const hasCompletedDb = hasExistingDb && fs.existsSync(dbDonePath);
      const hasCompletedFiles = hasExistingFiles && fs.existsSync(filesDonePath);

      const willSkipDb = !doDb || (skipDb && hasCompletedDb);
      const willSkipFiles = !doFiles || (skipFiles && hasCompletedFiles);

      if (willSkipDb && willSkipFiles) {
        const existingSize = fs.existsSync(siteBackupDir) ? getDirSize(siteBackupDir) : 0;
        results.push({ site, db: { skipped: true }, files: { skipped: true }, duration: 0 });
        onProgress({
          type: 'site_skip', site, current: i + 1, total: sites.length,
          reason: hasCompletedDb || hasCompletedFiles ? 'Бэкап уже есть' : 'Пропущен по настройкам',
          size: existingSize,
        });
        continue;
      }

      fs.mkdirSync(siteBackupDir, { recursive: true });
      const siteStartedAt = Date.now();
      const result = { site, db: null, files: null, error: null };
      const finalizeSkippedSite = () => {
        const existingSize = fs.existsSync(siteBackupDir) ? getDirSize(siteBackupDir) : 0;
        result.db = result.db || { skipped: true, reason: 'Пропущен пользователем' };
        result.files = result.files || { skipped: true, reason: 'Пропущен пользователем' };
        result.duration = Math.round((Date.now() - siteStartedAt) / 1000);
        results.push(result);
        onProgress({
          type: 'site_skip', site, current: i + 1, total: sites.length,
          reason: 'Пропущен пользователем',
          size: existingSize,
        });
      };

      const sitePaths = selectedPathsMap[site] || null;
      const isPartial = Array.isArray(sitePaths) && sitePaths.length > 0;

      let remoteSize = 0;
      if (doFiles && !willSkipFiles) {
        try {
          if (isPartial) {
            const duPaths = sitePaths.map((p) => `"${sitePath}/${normalizeRelativePath(p)}"`).join(' ');
            const duOut = await sshExec(conn, `du -scb ${duPaths} 2>/dev/null | tail -1 | cut -f1`);
            remoteSize = parseInt(duOut.trim(), 10) || 0;
          } else {
            const duOut = await sshExec(conn, `du -sb "${sitePath}" 2>/dev/null | cut -f1`);
            remoteSize = parseInt(duOut.trim(), 10) || 0;
          }
        } catch { /* не критично */ }
      }

      onProgress({
        type: 'site_start', site, current: i + 1, total: sites.length,
        method: canUseRsync ? 'rsync' : 'tar', remoteSize, mode,
      });

      // --- БД ---
      if (willSkipDb) {
        if (hasCompletedDb) {
          const dbSize = fs.statSync(path.join(siteBackupDir, 'db.sql')).size;
          result.db = { skipped: true, size: dbSize };
          onProgress({ type: 'db_skip', site, reason: 'Дамп уже есть за сегодня', size: dbSize });
        } else if (!doDb) {
          result.db = { skipped: true };
          onProgress({ type: 'db_skip', site, reason: 'Режим: только файлы' });
        }
      } else if (!cancelToken.cancelled) {
        try {
          if (fs.existsSync(dbDonePath)) fs.unlinkSync(dbDonePath);
          onProgress({ type: 'db_start', site });
          const creds = await detectDbCredentials(conn, sitePath);
          if (creds) {
            const dumpPath = path.join(siteBackupDir, 'db.sql');
            const dumpCmd = `mysqldump -h${creds.host} -u${creds.user} -p'${creds.password}' ${creds.database} 2>/dev/null`;
            const bytes = await sshExecToFile(conn, dumpCmd, dumpPath, (b) => {
              onProgress({ type: 'db_progress', site, bytes: b });
            }, cancelToken);
            result.db = { source: creds.source, database: creds.database, size: bytes };
            fs.writeFileSync(dbDonePath, 'ok');
            onProgress({ type: 'db_done', site, database: creds.database, size: bytes });
          } else {
            onProgress({ type: 'db_skip', site, reason: 'Конфиг БД не найден' });
          }
        } catch (err) {
          if (cancelToken.cancelled) break;
          if (isSiteCancelled()) {
            result.db = { skipped: true, reason: 'Пропущен пользователем' };
            onProgress({ type: 'db_skip', site, reason: 'Пропущен пользователем' });
          } else {
            result.db = { error: err.message };
            onProgress({ type: 'db_error', site, error: err.message });
          }
        }
      }

      if (cancelToken.cancelled) break;
      if (isSiteCancelled()) {
        finalizeSkippedSite();
        continue;
      }

      // --- Файлы ---
      if (willSkipFiles) {
        if (hasCompletedFiles) {
          const fSize = fs.existsSync(path.join(siteBackupDir, 'files.tar.gz'))
            ? fs.statSync(path.join(siteBackupDir, 'files.tar.gz')).size
            : getDirSize(path.join(siteBackupDir, 'files'));
          result.files = { skipped: true, size: fSize };
          onProgress({ type: 'files_skip', site, reason: 'Файлы уже есть за сегодня', size: fSize });
        } else if (!doFiles) {
          result.files = { skipped: true };
          onProgress({ type: 'files_skip', site, reason: 'Режим: только БД' });
        }
      } else if (!cancelToken.cancelled) {
        try {
          if (fs.existsSync(filesDonePath)) fs.unlinkSync(filesDonePath);

          let usedRsync = false;
          if (canUseRsync) {
            try {
              const method = isPartial ? 'rsync (partial)' : 'rsync';
              onProgress({ type: 'files_start', site, method, remoteSize, partial: isPartial });
              const filesDir = path.join(siteBackupDir, 'files');
              const oldTar = path.join(siteBackupDir, 'files.tar.gz');
              if (fs.existsSync(oldTar)) fs.unlinkSync(oldTar);
              if (isPartial) {
                const tmpFile = path.join(os.tmpdir(), `arkiv_rsync_${Date.now()}.txt`);
                fs.writeFileSync(tmpFile, sitePaths.map((p) => normalizeRelativePath(p)).join('\n'));
                try {
                  await rsyncFilesFrom(serverConfig, sitePath, filesDir, tmpFile, (b) => {
                    onProgress({ type: 'files_progress', site, bytes: b, remoteSize });
                  }, cancelToken);
                } finally {
                  try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
                }
              } else {
                await rsyncFiles(serverConfig, sitePath, filesDir, (b) => {
                  onProgress({ type: 'files_progress', site, bytes: b, remoteSize });
                }, cancelToken);
              }
              const totalSize = getDirSize(filesDir);
              result.files = { size: totalSize, method: 'rsync', remoteSize, partial: isPartial };
              fs.writeFileSync(filesDonePath, 'ok');
              if (isPartial) fs.writeFileSync(filesPartialPath, 'ok');
              else if (fs.existsSync(filesPartialPath)) fs.unlinkSync(filesPartialPath);
              onProgress({ type: 'files_done', site, size: totalSize, method, remoteSize });
              usedRsync = true;
            } catch (rsyncErr) {
              if (cancelToken.cancelled) throw rsyncErr;
              const isSSHError = /code 255|Permission denied|connection unexpectedly closed/i.test(rsyncErr.message);
              if (!isSSHError) throw rsyncErr;
              onProgress({ type: 'files_start', site, method: 'tar (fallback)', remoteSize, partial: isPartial });
            }
          }

          if (!usedRsync) {
            const method = isPartial ? 'tar (partial)' : 'tar';
            if (!canUseRsync) onProgress({ type: 'files_start', site, method, remoteSize, partial: isPartial });
            const archivePath = path.join(siteBackupDir, 'files.tar.gz');
            const tarExcludes = EXCLUDE_PATTERNS.map((p) => `--exclude='${p}'`).join(' ');
            let tarCmd;
            if (isPartial) {
              const tarPaths = sitePaths.map((p) => `"${site}/${normalizeRelativePath(p)}"`).join(' ');
              tarCmd = `tar czf - ${tarExcludes} -C "${serverConfig.basePath}" ${tarPaths} 2>/dev/null`;
            } else {
              tarCmd = `tar czf - ${tarExcludes} -C "${serverConfig.basePath}" "${site}" 2>/dev/null`;
            }
            const bytes = await sshExecToFile(conn, tarCmd, archivePath, (b) => {
              onProgress({ type: 'files_progress', site, bytes: b, remoteSize });
            }, cancelToken);
            result.files = { size: bytes, method: 'tar', remoteSize, partial: isPartial };
            fs.writeFileSync(filesDonePath, 'ok');
            if (isPartial) fs.writeFileSync(filesPartialPath, 'ok');
            else if (fs.existsSync(filesPartialPath)) fs.unlinkSync(filesPartialPath);
            onProgress({ type: 'files_done', site, size: bytes, method: canUseRsync ? 'tar (fallback)' : method, remoteSize });
          }
        } catch (err) {
          if (cancelToken.cancelled) break;
          if (isSiteCancelled()) {
            result.files = { skipped: true, reason: 'Пропущен пользователем' };
            onProgress({ type: 'files_skip', site, reason: 'Пропущен пользователем' });
          } else {
            result.files = { error: err.message };
            onProgress({ type: 'files_error', site, error: err.message });
          }
        }
      }

      if (cancelToken.cancelled) break;
      if (isSiteCancelled()) {
        finalizeSkippedSite();
        continue;
      }

      const siteDuration = Math.round((Date.now() - siteStartedAt) / 1000);
      result.duration = siteDuration;
      results.push(result);
      onProgress({ type: 'site_done', site, current: i + 1, total: sites.length, duration: siteDuration });
    }
  } finally {
    cancelToken.currentSite = null;
    cancelToken.currentSiteCancelled = false;
    conn.end();
  }

  if (cancelToken.cancelled) {
    onProgress({ type: 'backup_cancelled', results });
    return { date, path: backupPath, results, cancelled: true };
  }

  const finishedAt = new Date();
  const totalDuration = Math.round((finishedAt - startedAt) / 1000);

  const meta = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    duration: totalDuration,
    server: serverConfig.host,
    sites: results.map((r) => ({
      name: r.site, duration: r.duration,
      dbSize: r.db?.size || 0, filesSize: r.files?.size || 0,
    })),
  };
  fs.writeFileSync(path.join(backupPath, 'meta.json'), JSON.stringify(meta, null, 2));

  onProgress({ type: 'backup_complete', path: backupPath, results, duration: totalDuration });
  return { date, path: backupPath, results, duration: totalDuration };
}

async function getBackupHistory(backupDir) {
  const history = [];
  if (!fs.existsSync(backupDir)) return history;

  for (const serverDir of fs.readdirSync(backupDir)) {
    const serverPath = path.join(backupDir, serverDir);
    if (!fs.statSync(serverPath).isDirectory() || serverDir.startsWith('.')) continue;

    for (const dateDir of fs.readdirSync(serverPath)) {
      const datePath = path.join(serverPath, dateDir);
      if (!fs.statSync(datePath).isDirectory()) continue;

      const sites = [];
      for (const siteDir of fs.readdirSync(datePath)) {
        const sitePath = path.join(datePath, siteDir);
        if (!fs.statSync(sitePath).isDirectory()) continue;

        const hasDb = fs.existsSync(path.join(sitePath, 'db.sql'));
        const hasTar = fs.existsSync(path.join(sitePath, 'files.tar.gz'));
        const hasDir = fs.existsSync(path.join(sitePath, 'files'));
        const hasFiles = hasTar || hasDir;
        const filesPartial = fs.existsSync(path.join(sitePath, FILES_PARTIAL_MARKER));
        const filesSize = hasTar
          ? fs.statSync(path.join(sitePath, 'files.tar.gz')).size
          : hasDir ? getDirSize(path.join(sitePath, 'files')) : 0;
        const dbSize = hasDb
          ? fs.statSync(path.join(sitePath, 'db.sql')).size
          : 0;
        const filesMethod = hasTar ? 'tar' : hasDir ? 'rsync' : null;

        const dbComplete = hasDb && fs.existsSync(path.join(sitePath, DB_DONE_MARKER));
        const filesComplete = hasFiles && fs.existsSync(path.join(sitePath, FILES_DONE_MARKER));

        sites.push({
          name: siteDir,
          hasDb,
          hasFiles,
          filesSize,
          filesMethod,
          dbSize,
          dbComplete,
          filesComplete,
          filesPartial,
        });
      }

      if (sites.length > 0) {
        const entry = {
          server: serverDir,
          date: dateDir,
          sites,
          totalSize: sites.reduce((s, x) => s + x.filesSize + x.dbSize, 0),
          duration: null,
          startedAt: null,
        };

        const metaPath = path.join(datePath, 'meta.json');
        if (fs.existsSync(metaPath)) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
            entry.duration = meta.duration;
            entry.startedAt = meta.startedAt;
          } catch { /* ignore */ }
        }

        history.push(entry);
      }
    }
  }

  return history.sort((a, b) => b.date.localeCompare(a.date));
}

module.exports = {
  listSites,
  listSiteFiles,
  downloadSitePath,
  testConnection,
  runBackup,
  getBackupHistory,
};
