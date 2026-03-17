import { useState, useEffect } from 'react';
import { api, downloadUrl, formatBytes, formatDuration } from '../api';

function SiteStatus({ site }) {
  const allComplete = (site.hasDb ? site.dbComplete : true)
    && (site.hasFiles ? site.filesComplete : true)
    && !site.filesPartial;
  const partial = (site.hasDb && !site.dbComplete)
    || (site.hasFiles && !site.filesComplete)
    || !!site.filesPartial;

  if (allComplete) return <span className="status-dot status-complete" title="Полный бэкап" />;
  if (partial) return <span className="status-dot status-partial" title="Неполный бэкап" />;
  return <span className="status-dot status-empty" title="Нет данных" />;
}

function DownloadIconLink({ href, title }) {
  return (
    <a href={href} className="download-icon-link" title={title} aria-label={title}>
      <svg viewBox="0 0 24 24" className="download-icon" aria-hidden="true">
        <path d="M12 4v10" />
        <path d="m8 10 4 4 4-4" />
        <path d="M4 19h16" />
      </svg>
    </a>
  );
}

function downloadByUrl(href) {
  const a = document.createElement('a');
  a.href = href;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export default function History() {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isDesktop, setIsDesktop] = useState(false);
  const [actionError, setActionError] = useState('');

  const load = async () => {
    setLoading(true);
    setActionError('');
    try {
      const [backups, runtime] = await Promise.all([
        api.getBackups(),
        api.getRuntime().catch(() => ({ desktop: false })),
      ]);
      setHistory(backups);
      setIsDesktop(!!runtime?.desktop);
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const handleDeleteEntry = async (server, date) => {
    if (!confirm(`Удалить весь бэкап ${date} (${server})?`)) return;
    await api.deleteBackup(server, date);
    load();
  };

  const handleDeleteSite = async (server, date, site) => {
    if (!confirm(`Удалить бэкап сайта ${site}?`)) return;
    await api.deleteBackupSite(server, date, site);
    load();
  };

  const handleDownloadAllForSite = (entry, site) => {
    const links = [];
    if (site.hasFiles) {
      links.push(downloadUrl(entry.server, entry.date, site.name, 'files.tar.gz'));
    }
    if (site.hasDb) {
      links.push(downloadUrl(entry.server, entry.date, site.name, 'db.sql'));
    }
    links.forEach((href, idx) => {
      setTimeout(() => downloadByUrl(href), idx * 150);
    });
  };

  const handleOpenSiteFolder = async (entry, site) => {
    setActionError('');
    try {
      await api.openBackupSiteFolder(entry.server, entry.date, site.name);
    } catch (err) {
      setActionError(err.message);
    }
  };

  if (loading) {
    return <div className="empty-state"><span className="spinner" /></div>;
  }

  return (
    <div>
      <div className="flex-between">
        <h1 className="page-title">История бэкапов</h1>
        <button className="btn-secondary btn-sm" onClick={load}>Обновить</button>
      </div>
      {actionError && <div className="error-text" style={{ marginBottom: '0.6rem' }}>{actionError}</div>}

      {history.length === 0 ? (
        <div className="empty-state">
          <p>Нет бэкапов</p>
          <p className="text-dim text-sm mt-1">Выполните первый бэкап в разделе «Бэкап»</p>
        </div>
      ) : (
        <div className="history-list">
          {history.map((entry, i) => (
            <div key={i} className="card history-item">
              <div className="history-header">
                <div>
                  <strong>{entry.date}</strong>
                  {entry.startedAt && (
                    <span className="text-dim text-sm" style={{ marginLeft: '0.5rem' }}>
                      {new Date(entry.startedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  )}
                  <span className="text-dim text-sm" style={{ marginLeft: '0.5rem' }}>· {entry.server}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                  {entry.duration != null && (
                    <span className="badge badge-info">{formatDuration(entry.duration)}</span>
                  )}
                  <span className="text-dim text-sm">{formatBytes(entry.totalSize)}</span>
                  <button className="btn-danger btn-sm" onClick={() => handleDeleteEntry(entry.server, entry.date)}>
                    Удалить всё
                  </button>
                </div>
              </div>

              <div className="history-sites-table">
                <div className="history-sites-header">
                  <span className="hs-col-status"></span>
                  <span className="hs-col-name">Сайт</span>
                  <span className="hs-col-files">Файлы</span>
                  <span className="hs-col-db">База данных</span>
                  <span className="hs-col-actions"></span>
                </div>
                {entry.sites.map((site) => (
                  <div key={site.name} className="history-site-row">
                    <span className="hs-col-status"><SiteStatus site={site} /></span>
                    <span className="hs-col-name">{site.name}</span>
                    <span className="hs-col-files">
                      {site.hasFiles ? (
                        <span className="history-cell-actions">
                          <span className={`badge ${site.filesComplete && !site.filesPartial ? 'badge-success' : 'badge-warning'}`}>
                            {formatBytes(site.filesSize)} {site.filesComplete && !site.filesPartial ? '' : '(неполный)'}
                          </span>
                          {!isDesktop && (
                            <DownloadIconLink
                              href={downloadUrl(entry.server, entry.date, site.name, 'files.tar.gz')}
                              title="Скачать файлы"
                            />
                          )}
                        </span>
                      ) : (
                        <span className="text-dim text-sm">—</span>
                      )}
                    </span>
                    <span className="hs-col-db">
                      {site.hasDb ? (
                        <span className="history-cell-actions">
                          <span className={`badge ${site.dbComplete ? 'badge-success' : 'badge-warning'}`}>
                            {formatBytes(site.dbSize)} {site.dbComplete ? '' : '(неполный)'}
                          </span>
                          {!isDesktop && (
                            <DownloadIconLink
                              href={downloadUrl(entry.server, entry.date, site.name, 'db.sql')}
                              title="Скачать БД"
                            />
                          )}
                        </span>
                      ) : (
                        <span className="text-dim text-sm">—</span>
                      )}
                    </span>
                    <span className="hs-col-actions">
                      {isDesktop ? (
                        <button
                          className="btn-icon"
                          title="Открыть папку бэкапа"
                          onClick={() => handleOpenSiteFolder(entry, site)}
                        >
                          📁
                        </button>
                      ) : (
                        (site.hasFiles || site.hasDb) && (
                          <button
                            className="btn-secondary btn-sm"
                            title="Скачать всё (файлы и БД)"
                            onClick={() => handleDownloadAllForSite(entry, site)}
                          >
                            ↓ Скачать все
                          </button>
                        )
                      )}
                      <button
                        className="btn-icon"
                        title="Удалить бэкап сайта"
                        onClick={() => handleDeleteSite(entry.server, entry.date, site.name)}
                      >
                        ✕
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
