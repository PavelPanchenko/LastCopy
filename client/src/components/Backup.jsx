import { useState, useEffect, useMemo, useRef } from 'react';
import { api, subscribeProgress, formatBytes, formatDuration } from '../api';

const ACTIVE_BACKUP_KEY = 'arkiv.activeBackup';

function getSiteStatus(events, site, backupCancelledFlag = false) {
  const siteEvents = events.filter((e) => e.site === site);
  const last = siteEvents[siteEvents.length - 1];
  const backupCancelled = backupCancelledFlag || events.some((e) => e.type === 'backup_cancelled');
  if (!last) {
    if (backupCancelled) return { phase: 'skipped', label: 'Отменён' };
    return { phase: 'waiting', label: 'Ожидание...' };
  }

  const skip = siteEvents.find((e) => e.type === 'site_skip');
  if (skip) {
    return {
      phase: 'skipped',
      label: skip.reason || 'Пропущен',
      size: skip.size,
    };
  }

  const db = siteEvents.find((e) => e.type === 'db_done' || e.type === 'db_skip' || e.type === 'db_error');
  const files = siteEvents.find((e) => e.type === 'files_done' || e.type === 'files_error' || e.type === 'files_skip');
  const done = siteEvents.find((e) => e.type === 'site_done');
  const start = siteEvents.find((e) => e.type === 'site_start');
  const method = start?.method || files?.method || null;
  const siteRemoteSize = start?.remoteSize || 0;

  const lastDbProgress = [...siteEvents].reverse().find((e) => e.type === 'db_progress');
  const lastFilesProgress = [...siteEvents].reverse().find((e) => e.type === 'files_progress');

  if (done) {
    return {
      phase: 'done',
      label: done.duration != null ? formatDuration(done.duration) : 'Готов',
      duration: done.duration,
      method,
      db: db?.type === 'db_done' ? { ok: true, database: db.database, size: db.size }
        : db?.type === 'db_skip' ? { skip: true, reason: db.reason }
        : db?.type === 'db_error' ? { error: db.error } : null,
      files: files?.type === 'files_done' ? { ok: true, size: files.size, method: files.method, remoteSize: files.remoteSize }
        : files?.type === 'files_skip' ? { skip: true, reason: files.reason, size: files.size }
        : files?.type === 'files_error' ? { error: files.error } : null,
    };
  }

  if (backupCancelled) {
    return { phase: 'skipped', label: 'Отменён' };
  }

  if (last.type === 'files_progress' || last.type === 'files_start') {
    const bytes = lastFilesProgress?.bytes || 0;
    const remote = last.remoteSize || lastFilesProgress?.remoteSize || 0;
    const m = last.method || method;
    const prefix = m === 'rsync' ? 'rsync' : 'Файлы';
    const total = remote ? ` / ${formatBytes(remote)}` : '';
    return { phase: 'active', label: `${prefix}: ${formatBytes(bytes)}${total}`, liveBytes: bytes, remoteSize: remote };
  }
  if (last.type === 'db_progress' || last.type === 'db_start') {
    const bytes = lastDbProgress?.bytes || 0;
    const sizeHint = siteRemoteSize ? ` (сайт: ${formatBytes(siteRemoteSize)})` : '';
    return { phase: 'active', label: bytes ? `БД: ${formatBytes(bytes)}${sizeHint}` : `Дамп БД...${sizeHint}`, remoteSize: siteRemoteSize };
  }
  if (last.type === 'site_start') {
    const sizeHint = siteRemoteSize ? ` (${formatBytes(siteRemoteSize)})` : '';
    return { phase: 'active', label: `Подключение...${sizeHint}`, remoteSize: siteRemoteSize };
  }
  if (last.type === 'db_done' || last.type === 'db_skip' || last.type === 'db_error') {
    return { phase: 'active', label: 'БД готова, ждём файлы...' };
  }

  return { phase: 'active', label: 'Обработка...' };
}

function getStats(events, totalSites, elapsedSec) {
  const doneSites = events.filter((e) => e.type === 'site_done');
  const skippedSites = events.filter((e) => e.type === 'site_skip');
  const completedCount = doneSites.length + skippedSites.length;

  let totalDownloaded = 0;
  let totalRemote = 0;
  const dbDone = new Set();
  const filesDone = new Set();

  for (const e of events) {
    if (e.type === 'db_done') { totalDownloaded += e.size || 0; dbDone.add(e.site); }
    if (e.type === 'files_done') { totalDownloaded += e.size || 0; filesDone.add(e.site); }
    if (e.type === 'site_start' && e.remoteSize) totalRemote += e.remoteSize;
  }

  const lastDbProg = [...events].reverse().find(
    (e) => e.type === 'db_progress' && !dbDone.has(e.site),
  );
  const lastFilesProg = [...events].reverse().find(
    (e) => e.type === 'files_progress' && !filesDone.has(e.site),
  );
  if (lastDbProg) totalDownloaded += lastDbProg.bytes || 0;
  if (lastFilesProg) totalDownloaded += lastFilesProg.bytes || 0;

  let eta = null;
  let speed = 0;
  if (totalDownloaded > 0 && elapsedSec > 3) {
    speed = totalDownloaded / elapsedSec;
    if (totalRemote > totalDownloaded) {
      eta = Math.round((totalRemote - totalDownloaded) / speed);
    }
  }

  return { completedCount, totalDownloaded, totalRemote, eta, speed };
}

function readActiveBackup() {
  try {
    const raw = sessionStorage.getItem(ACTIVE_BACKUP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.backupId || !Array.isArray(parsed.sites)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeActiveBackup(payload) {
  sessionStorage.setItem(ACTIVE_BACKUP_KEY, JSON.stringify(payload));
}

function clearActiveBackup() {
  sessionStorage.removeItem(ACTIVE_BACKUP_KEY);
}

const MODES = [
  { value: 'all', label: 'БД + Файлы' },
  { value: 'db', label: 'Только БД' },
  { value: 'files', label: 'Только файлы' },
];

export default function Backup() {
  const [servers, setServers] = useState([]);
  const [selectedServer, setSelectedServer] = useState('');
  const [sites, setSites] = useState([]);
  const [selectedSites, setSelectedSites] = useState(new Set());
  const [loadingSites, setLoadingSites] = useState(false);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [events, setEvents] = useState([]);
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [mode, setMode] = useState('all');
  const [skipExistingDb, setSkipExistingDb] = useState(true);
  const [skipExistingFiles, setSkipExistingFiles] = useState(true);

  const [step, setStep] = useState(1);
  const [browsingInSite, setBrowsingInSite] = useState(null);
  const [currentPath, setCurrentPath] = useState('');
  const [entries, setEntries] = useState([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState({});
  const [skippingSites, setSkippingSites] = useState(new Set());

  const timerRef = useRef(null);
  const unsubscribeRef = useRef(null);
  const backupIdRef = useRef(null);
  const cancelledRef = useRef(false);

  const stopElapsedTimer = () => {
    clearInterval(timerRef.current);
    timerRef.current = null;
  };

  const startElapsedTimer = (startedAtMs) => {
    stopElapsedTimer();
    const tick = () => setElapsed(Math.max(0, Math.round((Date.now() - startedAtMs) / 1000)));
    tick();
    timerRef.current = setInterval(tick, 1000);
  };

  const connectProgress = ({ backupId, serverId, sites: selected, startedAt }) => {
    unsubscribeRef.current?.();
    backupIdRef.current = backupId;
    cancelledRef.current = false;
    setSelectedServer(serverId || '');
    setSelectedSites(new Set(selected));
    setEvents([]);
    setRunning(true);
    setFinished(false);
    setCancelled(false);
    setSkippingSites(new Set());
    setError('');
    startElapsedTimer(startedAt || Date.now());

    unsubscribeRef.current = subscribeProgress(
      backupId,
      (event) => {
        setEvents((prev) => [...prev, event]);
        if (event.type === 'backup_cancelled') {
          cancelledRef.current = true;
          setRunning(false);
          setCancelled(true);
          stopElapsedTimer();
          clearActiveBackup();
          return;
        }
      },
      {
        onDone: () => {
          setRunning(false);
          if (!cancelledRef.current) {
            setFinished(true);
          }
          stopElapsedTimer();
          clearActiveBackup();
        },
        onError: () => {
          setRunning(false);
          stopElapsedTimer();
          setError('Соединение с прогрессом потеряно. Обновите страницу.');
        },
      },
    );
  };

  useEffect(() => {
    api.getServers().then(setServers).catch(() => {});

    const active = readActiveBackup();
    if (active) {
      connectProgress(active);
    }

    return () => {
      unsubscribeRef.current?.();
      stopElapsedTimer();
    };
  }, []);

  const handleServerChange = async (serverId) => {
    setSelectedServer(serverId);
    setSelectedSites(new Set());
    setSites([]);
    setEvents([]);
    setFinished(false);
    setStep(1);
    setBrowsingInSite(null);
    setCurrentPath('');
    setEntries([]);
    setSelectedPaths({});
    if (!serverId) return;

    setLoadingSites(true);
    setError('');
    try {
      setSites(await api.getSites(serverId));
    } catch (err) {
      setError(err.message);
    }
    setLoadingSites(false);
  };

  /* ---- Step 2: file browser ---- */

  const openBrowser = async (site) => {
    setBrowsingInSite(site);
    setCurrentPath('');
    setEntries([]);
    setBrowseLoading(true);
    setError('');
    try {
      const tree = await api.getSiteTree(selectedServer, site, '');
      setCurrentPath(tree.path || '');
      setEntries(tree.entries || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setBrowseLoading(false);
    }
  };

  const navigateTo = async (relPath) => {
    if (!browsingInSite) return;
    setBrowseLoading(true);
    setError('');
    try {
      const tree = await api.getSiteTree(selectedServer, browsingInSite, relPath);
      setCurrentPath(tree.path || '');
      setEntries(tree.entries || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setBrowseLoading(false);
    }
  };

  const goUp = () => {
    if (!currentPath) return;
    const parent = currentPath.includes('/') ? currentPath.split('/').slice(0, -1).join('/') : '';
    navigateTo(parent);
  };

  const closeBrowser = () => {
    setBrowsingInSite(null);
    setCurrentPath('');
    setEntries([]);
  };

  const togglePath = (site, entryPath) => {
    setSelectedPaths((prev) => {
      const siteSet = new Set(prev[site] || []);
      if (siteSet.has(entryPath)) siteSet.delete(entryPath);
      else siteSet.add(entryPath);
      const next = { ...prev };
      if (siteSet.size === 0) delete next[site];
      else next[site] = siteSet;
      return next;
    });
  };

  const clearSitePaths = (site) => {
    setSelectedPaths((prev) => {
      const next = { ...prev };
      delete next[site];
      return next;
    });
  };

  const sitePathCount = (site) => (selectedPaths[site]?.size || 0);

  /* ---- Step 1: site selection ---- */

  const toggleSite = (site) => {
    setSelectedSites((prev) => {
      const next = new Set(prev);
      next.has(site) ? next.delete(site) : next.add(site);
      return next;
    });
  };

  const toggleAll = () => {
    setSelectedSites(selectedSites.size === sites.length ? new Set() : new Set(sites));
  };

  const goToStep2 = () => {
    if (selectedSites.size === 0) return;
    setBrowsingInSite(null);
    setStep(2);
  };

  const goBackToStep1 = () => {
    setBrowsingInSite(null);
    setCurrentPath('');
    setEntries([]);
    setStep(1);
  };

  /* ---- Backup ---- */

  const startBackup = async () => {
    if (!selectedServer || selectedSites.size === 0) return;

    try {
      const startedAt = Date.now();
      const spObj = {};
      for (const [site, pathSet] of Object.entries(selectedPaths)) {
        if (selectedSites.has(site) && pathSet.size > 0) spObj[site] = [...pathSet];
      }
      const result = await api.startBackup(selectedServer, [...selectedSites], {
        mode,
        skipExistingDb: mode !== 'files' && skipExistingDb,
        skipExistingFiles: mode !== 'db' && skipExistingFiles,
        selectedPaths: spObj,
      });
      const payload = {
        backupId: result.backupId,
        serverId: selectedServer,
        sites: [...selectedSites],
        startedAt,
      };
      writeActiveBackup(payload);
      connectProgress(payload);
    } catch (err) {
      setError(err.message);
      setRunning(false);
      stopElapsedTimer();
      clearActiveBackup();
    }
  };

  const cancelBackup = async () => {
    if (!backupIdRef.current) return;
    try {
      await api.cancelBackup(backupIdRef.current);
    } catch { /* ignore */ }
  };

  const cancelSiteBackup = async (site) => {
    if (!backupIdRef.current) return;
    if (skippingSites.has(site)) return;
    setSkippingSites((prev) => new Set([...prev, site]));
    try {
      await api.cancelBackupSite(backupIdRef.current, site);
    } catch {
      setSkippingSites((prev) => {
        const next = new Set(prev);
        next.delete(site);
        return next;
      });
    }
  };

  const reset = () => {
    unsubscribeRef.current?.();
    backupIdRef.current = null;
    setRunning(false);
    setFinished(false);
    setCancelled(false);
    setEvents([]);
    setSkippingSites(new Set());
    setElapsed(0);
    setStep(1);
    stopElapsedTimer();
    clearActiveBackup();
  };

  const backupSites = useMemo(() => [...selectedSites], [selectedSites]);
  const completeEvent = events.find((e) => e.type === 'backup_complete');
  const totalDuration = completeEvent?.duration ?? elapsed;
  const isActive = running || finished || cancelled;
  const stats = useMemo(() => getStats(events, backupSites.length, elapsed), [events, backupSites.length, elapsed]);

  const totalSelectedPaths = Object.values(selectedPaths).reduce((sum, s) => sum + (s.size || 0), 0);

  return (
    <div>
      <h1 className="page-title">Бэкап</h1>

      {/* ===== STEP 1: server + sites + mode ===== */}
      {!isActive && step === 1 && (
        <>
          <div className="card" style={{ marginBottom: '1rem' }}>
            <label>Выберите сервер</label>
            <select
              value={selectedServer}
              onChange={(e) => handleServerChange(e.target.value)}
            >
              <option value="">-- Выберите --</option>
              {servers.map((s) => (
                <option key={s.id} value={s.id}>{s.name} ({s.host})</option>
              ))}
            </select>
          </div>

          {error && <div className="error-text" style={{ marginBottom: '1rem' }}>{error}</div>}

          {loadingSites && (
            <div className="empty-state"><span className="spinner" /></div>
          )}

          {!loadingSites && sites.length > 0 && (
            <>
              <div className="card" style={{ marginBottom: '1rem' }}>
                <div className="flex-between" style={{ marginBottom: '0.8rem' }}>
                  <label style={{ margin: 0 }}>Сайты ({selectedSites.size} из {sites.length})</label>
                  <button className="btn-secondary btn-sm" onClick={toggleAll}>
                    {selectedSites.size === sites.length ? 'Снять все' : 'Выбрать все'}
                  </button>
                </div>
                <div className="site-list">
                  {sites.map((site) => (
                    <label key={site} className="site-item">
                      <input
                        type="checkbox"
                        checked={selectedSites.has(site)}
                        onChange={() => toggleSite(site)}
                      />
                      <span>{site}</span>
                    </label>
                  ))}
                </div>
              </div>

              <button
                className="btn-primary"
                onClick={goToStep2}
                disabled={selectedSites.size === 0}
                style={{ width: '100%', padding: '0.8rem', fontSize: '1rem' }}
              >
                Продолжить ({selectedSites.size} сайтов)
              </button>
            </>
          )}
        </>
      )}

      {/* ===== STEP 2: file selection per site ===== */}
      {!isActive && step === 2 && (
        <>
          {browsingInSite ? (
            /* --- File browser inside one site --- */
            <div className="card" style={{ marginBottom: '1rem' }}>
              <div className="flex-between" style={{ marginBottom: '0.8rem' }}>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <button className="btn-secondary btn-sm" onClick={closeBrowser}>
                    &larr; Назад
                  </button>
                  {currentPath && (
                    <button className="btn-secondary btn-sm" onClick={goUp}>Вверх</button>
                  )}
                </div>
                {sitePathCount(browsingInSite) > 0 && (
                  <button className="btn-secondary btn-sm" onClick={() => clearSitePaths(browsingInSite)}>
                    Сбросить ({sitePathCount(browsingInSite)})
                  </button>
                )}
              </div>

              <div className="text-dim text-sm" style={{ marginBottom: '0.6rem' }}>
                <strong>{browsingInSite}</strong>{currentPath ? ` / ${currentPath}` : ''}
              </div>

              {browseLoading && <div className="empty-state"><span className="spinner" /></div>}

              {!browseLoading && entries.length > 0 && (
                <div className="site-list">
                  {entries.map((entry) => {
                    const isChecked = selectedPaths[browsingInSite]?.has(entry.path) || false;
                    return (
                      <div key={entry.path} className="site-item" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => togglePath(browsingInSite, entry.path)}
                        />
                        {entry.type === 'dir' ? (
                          <span
                            style={{ cursor: 'pointer', flex: 1, display: 'flex', alignItems: 'center', gap: '0.4rem' }}
                            onClick={() => navigateTo(entry.path)}
                          >
                            <span style={{ opacity: 0.7 }}>&#128193;</span>
                            <span style={{ borderBottom: '1px dashed var(--border)' }}>{entry.name}</span>
                          </span>
                        ) : (
                          <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                            <span style={{ opacity: 0.7 }}>&#128196;</span>
                            <span>{entry.name}</span>
                            <span className="text-dim text-sm">({formatBytes(entry.size)})</span>
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {!browseLoading && entries.length === 0 && (
                <div className="empty-state">Папка пуста</div>
              )}
            </div>
          ) : (
            /* --- List of selected sites --- */
            <div className="card" style={{ marginBottom: '1rem' }}>
              <div className="flex-between" style={{ marginBottom: '0.8rem' }}>
                <label style={{ margin: 0 }}>Выбор файлов ({backupSites.length} сайтов)</label>
                <button className="btn-secondary btn-sm" onClick={goBackToStep1}>
                  &larr; Назад
                </button>
              </div>
              <div className="text-dim text-sm" style={{ marginBottom: '0.8rem' }}>
                Нажмите на сайт чтобы выбрать конкретные файлы. Без выбора — скачается всё.
              </div>
              <div className="site-list">
                {backupSites.map((site) => {
                  const pc = sitePathCount(site);
                  return (
                    <div
                      key={site}
                      className="site-item"
                      style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}
                      onClick={() => openBrowser(site)}
                    >
                      <span style={{ flex: 1, borderBottom: '1px dashed var(--border)' }}>{site}</span>
                      <span className={`badge ${pc > 0 ? 'badge-info' : 'badge-success'}`} style={{ fontSize: '0.75rem' }}>
                        {pc > 0 ? `${pc} выбрано` : 'Все файлы'}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {error && <div className="error-text" style={{ marginBottom: '1rem' }}>{error}</div>}

          {!browsingInSite && (
            <>
              <div className="card" style={{ marginBottom: '1rem', padding: '0.8rem 1rem' }}>
                <label style={{ marginBottom: '0.5rem', display: 'block' }}>Режим бэкапа</label>
                <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.8rem' }}>
                  {MODES.map((m) => (
                    <button
                      key={m.value}
                      className={mode === m.value ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'}
                      onClick={() => setMode(m.value)}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>

                {mode !== 'files' && (
                  <label className="site-item" style={{ marginBottom: '0.3rem' }}>
                    <input type="checkbox" checked={skipExistingDb} onChange={(e) => setSkipExistingDb(e.target.checked)} />
                    <span className="text-dim text-sm">Пропускать БД, если дамп уже есть за сегодня</span>
                  </label>
                )}
                {mode !== 'db' && (
                  <label className="site-item">
                    <input type="checkbox" checked={skipExistingFiles} onChange={(e) => setSkipExistingFiles(e.target.checked)} />
                    <span className="text-dim text-sm">Пропускать файлы, если уже скачаны за сегодня</span>
                  </label>
                )}
              </div>

              <button
                className="btn-primary"
                onClick={startBackup}
                style={{ width: '100%', padding: '0.8rem', fontSize: '1rem' }}
              >
                Начать бэкап{totalSelectedPaths > 0 ? ` (${totalSelectedPaths} файлов/папок выбрано)` : ''}
              </button>
            </>
          )}
        </>
      )}

      {/* ===== ACTIVE BACKUP: progress ===== */}
      {isActive && (
        <div className="backup-progress-view">
          <div className="card backup-stats">
            <div className="backup-stats-grid">
              <div className="backup-stat">
                <span className="backup-stat-label">Сайты</span>
                <div className="backup-stat-value">
                  {stats.completedCount} / {backupSites.length}
                </div>
              </div>
              <div className="backup-stat">
                <span className="backup-stat-label">Скачано</span>
                <div className="backup-stat-value">
                  {formatBytes(stats.totalDownloaded)}
                  {stats.totalRemote > 0 && (
                    <span className="backup-stat-value-sub">
                      {' '}/ {formatBytes(stats.totalRemote)} на сервере
                    </span>
                  )}
                </div>
              </div>
              <div className="backup-stat">
                <span className="backup-stat-label">Прошло</span>
                <div className="backup-stat-value">
                  {formatDuration(totalDuration)}
                </div>
              </div>
              {running && stats.speed > 0 && (
                <div className="backup-stat">
                  <span className="backup-stat-label">Скорость</span>
                  <div className="backup-stat-value">
                    {formatBytes(stats.speed)}/с
                  </div>
                </div>
              )}
              {running && stats.eta != null && (
                <div className="backup-stat">
                  <span className="backup-stat-label">Осталось ~</span>
                  <div className="backup-stat-value" style={{ color: 'var(--accent)' }}>
                    {formatDuration(stats.eta)}
                  </div>
                </div>
              )}
              <div className="backup-stats-actions">
                {running && (
                  <button className="btn-secondary btn-sm" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }} onClick={cancelBackup}>
                    Остановить всё
                  </button>
                )}
                {(finished || cancelled) && (
                  <button className="btn-secondary btn-sm" onClick={reset}>
                    Новый бэкап
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="progress-bar-track" style={{ marginBottom: '1.2rem' }}>
            <div
              className="progress-bar-fill"
              style={{ width: `${backupSites.length ? (stats.completedCount / backupSites.length) * 100 : 0}%` }}
            />
          </div>

          <div className="site-progress-list">
            {backupSites.map((site) => {
              const status = getSiteStatus(events, site, cancelled);
              const canSkip = running
                && !skippingSites.has(site)
                && (status.phase === 'active' || status.phase === 'waiting');
              return (
                <div key={site} className={`card site-progress-card ${status.phase}`} style={{ marginBottom: '0.6rem' }}>
                  <div className="flex-between">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                      <SiteStatusIcon phase={status.phase} />
                      <strong style={{ fontSize: '0.9rem' }}>{site}</strong>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      {canSkip && (
                        <button
                          className="btn-secondary btn-sm"
                          style={{ borderColor: 'var(--warning)', color: 'var(--warning)' }}
                          onClick={() => cancelSiteBackup(site)}
                        >
                          Пропустить
                        </button>
                      )}
                      <span className={`badge badge-${badgeVariant(status.phase)}`}>
                        {status.label}
                      </span>
                    </div>
                  </div>

                  {status.phase === 'done' && (
                    <div style={{ marginTop: '0.6rem', display: 'flex', gap: '0.8rem', flexWrap: 'wrap', alignItems: 'center' }}>
                      {status.db?.ok && (
                        <span className="size-label">БД: {status.db.database} ({formatBytes(status.db.size)})</span>
                      )}
                      {status.db?.skip && (
                        <span className="size-label" style={{ color: 'var(--warning)' }}>БД: {status.db.reason}</span>
                      )}
                      {status.db?.error && (
                        <span className="size-label" style={{ color: 'var(--danger)' }}>БД: {status.db.error}</span>
                      )}
                      {status.files?.ok && (
                        <span className="size-label">
                          Файлы: {formatBytes(status.files.size)}
                          {status.files.remoteSize ? ` / ${formatBytes(status.files.remoteSize)} на сервере` : ''}
                          {status.files.method === 'rsync' && ' (rsync)'}
                        </span>
                      )}
                      {status.files?.skip && (
                        <span className="size-label" style={{ color: 'var(--text-dim)' }}>
                          Файлы: {status.files.reason}{status.files.size ? ` (${formatBytes(status.files.size)})` : ''}
                        </span>
                      )}
                      {status.files?.error && (
                        <span className="size-label" style={{ color: 'var(--danger)' }}>Файлы: {status.files.error}</span>
                      )}
                    </div>
                  )}
                  {status.phase === 'skipped' && status.size > 0 && (
                    <div style={{ marginTop: '0.4rem' }}>
                      <span className="size-label">Существующий бэкап: {formatBytes(status.size)}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {finished && (
            <div className="card mt-2" style={{ borderColor: 'var(--success)', textAlign: 'center' }}>
              <span className="badge badge-success" style={{ fontSize: '0.85rem' }}>Бэкап завершён</span>
              <p className="text-dim text-sm mt-1">
                Перейдите в «Историю» чтобы скачать файлы
              </p>
            </div>
          )}

          {cancelled && (
            <div className="card mt-2" style={{ borderColor: 'var(--warning)', textAlign: 'center' }}>
              <span className="badge badge-warning" style={{ fontSize: '0.85rem' }}>Бэкап отменён</span>
              <p className="text-dim text-sm mt-1">
                Уже скачанные данные сохранены
              </p>
            </div>
          )}

          {error && <div className="error-text mt-1">{error}</div>}
        </div>
      )}
    </div>
  );
}

function SiteStatusIcon({ phase }) {
  if (phase === 'done') return <span style={{ color: 'var(--success)', fontSize: '1.1rem' }}>&#10003;</span>;
  if (phase === 'skipped') return <span style={{ color: 'var(--text-dim)', fontSize: '1.1rem' }}>&#8212;</span>;
  if (phase === 'active') return <span className="spinner" />;
  return <span style={{ color: 'var(--text-dim)', fontSize: '1.1rem' }}>&#9711;</span>;
}

function badgeVariant(phase) {
  if (phase === 'done') return 'success';
  if (phase === 'skipped') return 'warning';
  if (phase === 'active') return 'info';
  return 'warning';
}
