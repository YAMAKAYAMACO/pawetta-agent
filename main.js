'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const dns = require('node:dns/promises');
const { spawn } = require('node:child_process');
const { app, BrowserWindow, dialog, ipcMain, shell, session, Tray, Menu, Notification, nativeImage, powerSaveBlocker, clipboard } = require('electron');
const core = require('./src/agent-core');

const API_STREAM_URL = 'https://pawetta.com/api/ai-chat-stream';
const SITE_URL = 'https://pawetta.com';
const UPDATE_URL = `${SITE_URL}/downloads/pawetta-agent-latest.json`;
const QA_SCREENSHOT = process.argv.includes('--qa-screenshot');
const START_HIDDEN = process.argv.includes('--background') && !QA_SCREENSHOT;
let mainWindow;
let tray;
let quitting = false;
let powerBlockerId = null;
let projectRoot = '';
let preferences = { autoLaunch: true, closeToTray: true, notifyOnComplete: true };
const chatControllers = new Map();
const writeRecords = new Map();
const checkpoints = new Map();
let projectIndexCache = { root: '', at: 0, value: null };
// Visual QA must not be blocked by an installed Pawetta instance that may be
// sitting quietly in the tray under the same Electron application id.
const singleInstance = QA_SCREENSHOT || app.requestSingleInstanceLock();

if (!singleInstance) app.quit();

function activityPath() {
  return path.join(app.getPath('userData'), 'logs', 'activity.jsonl');
}

function safeLogValue(value) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/[\r\n\t]+/g, ' ').slice(0, 500);
}

async function logActivity(type, details = {}) {
  const entry = { at: new Date().toISOString(), type: safeLogValue(type) };
  for (const [key, value] of Object.entries(details || {})) entry[key] = safeLogValue(value);
  const target = activityPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    const stat = await fs.stat(target);
    if (stat.size > 2_000_000) await fs.rename(target, `${target}.1`).catch(() => {});
  } catch {}
  await fs.appendFile(target, `${JSON.stringify(entry)}\n`, 'utf8').catch(() => {});
}

async function recentActivity(limit = 120) {
  try {
    const lines = (await fs.readFile(activityPath(), 'utf8')).trim().split(/\r?\n/).filter(Boolean).slice(-Math.min(Math.max(limit, 1), 300));
    return lines.reverse().map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

async function siteFetch(route, options = {}) {
  return session.defaultSession.fetch(new URL(route, SITE_URL).toString(), options);
}

async function accountSnapshot() {
  try {
    const response = await siteFetch('/api/ai/account', { headers: { Accept: 'application/json' } });
    const account = await response.json();
    return {
      ...(account || { authorized: false }),
      appVersion: app.getVersion(),
      limits: { steps: 10, requestSeconds: 120, fileKb: Math.round(core.MAX_FILE_BYTES / 1000), filesPerRead: 8 }
    };
  } catch (error) {
    return { authorized: false, offline: true, error: error.message || String(error), appVersion: app.getVersion(), limits: { steps: 10, requestSeconds: 120, fileKb: 300, filesPerRead: 8 } };
  }
}

function publicProject() {
  return projectRoot ? { selected: true, path: projectRoot, name: path.basename(projectRoot) } : { selected: false };
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

async function loadSettings() {
  try {
    const settings = JSON.parse(await fs.readFile(settingsPath(), 'utf8'));
    preferences = {
      autoLaunch: settings.preferences?.autoLaunch !== false,
      closeToTray: settings.preferences?.closeToTray !== false,
      notifyOnComplete: settings.preferences?.notifyOnComplete !== false
    };
    if (typeof settings.projectRoot === 'string') {
      const stat = await fs.stat(settings.projectRoot);
      if (stat.isDirectory()) projectRoot = path.resolve(settings.projectRoot);
    }
  } catch {}
}

async function saveSettings() {
  await fs.mkdir(path.dirname(settingsPath()), { recursive: true });
  await fs.writeFile(settingsPath(), JSON.stringify({ projectRoot, preferences }, null, 2), 'utf8');
}

function launchExecutablePath() {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}

function applyAutoLaunch() {
  if (!app.isPackaged || QA_SCREENSHOT) return;
  app.setLoginItemSettings({
    openAtLogin: preferences.autoLaunch,
    path: launchExecutablePath(),
    args: ['--background']
  });
}

function showMainWindow(newTask = false) {
  const created = !mainWindow || mainWindow.isDestroyed();
  if (created) createWindow();
  mainWindow.setSkipTaskbar(false);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (newTask) {
    if (created && mainWindow.webContents.isLoadingMainFrame()) mainWindow.webContents.once('did-finish-load', () => mainWindow.webContents.send('agent:new-task'));
    else mainWindow.webContents.send('agent:new-task');
  }
}

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть Паветту', click: () => showMainWindow() },
    { label: 'Новая задача', click: () => showMainWindow(true) },
    { type: 'separator' },
    {
      label: 'Запускать вместе с Windows',
      type: 'checkbox',
      checked: preferences.autoLaunch,
      click: async item => {
        preferences.autoLaunch = item.checked;
        await saveSettings();
        applyAutoLaunch();
        mainWindow?.webContents.send('agent:preferences-changed', preferences);
      }
    },
    { type: 'separator' },
    { label: 'Выйти', click: () => { quitting = true; app.quit(); } }
  ]));
}

function createTray() {
  if (tray) return;
  const trayIcon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')).resize({ width: 20, height: 20 });
  tray = new Tray(trayIcon);
  tray.setToolTip('Паветта Агент');
  tray.on('click', () => showMainWindow());
  rebuildTrayMenu();
}

function notifyComplete() {
  if (!preferences.notifyOnComplete || mainWindow?.isFocused()) return;
  if (Notification.isSupported()) new Notification({ title: 'Паветта', body: 'Задача завершена' }).show();
}

function compareVersions(left, right) {
  const a = String(left || '').split('.').map(value => Number(value) || 0);
  const b = String(right || '').split('.').map(value => Number(value) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0);
  }
  return 0;
}

async function updateSnapshot() {
  const current = app.getVersion();
  try {
    const response = await session.defaultSession.fetch(UPDATE_URL, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const remote = await response.json();
    const latest = String(remote.version || current);
    const url = /^https:\/\/pawetta\.com\//i.test(String(remote.url || '')) ? remote.url : `${SITE_URL}/downloads/Pawetta-Agent-Windows.exe`;
    return { current, latest, available: compareVersions(latest, current) > 0, url, notes: String(remote.notes || '') };
  } catch (error) {
    return { current, latest: current, available: false, offline: true, error: error.message || String(error) };
  }
}

function keepComputerAwake() {
  if (powerBlockerId === null) powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
}

function releaseComputerAwake() {
  if (powerBlockerId !== null && powerSaveBlocker.isStarted(powerBlockerId)) powerSaveBlocker.stop(powerBlockerId);
  powerBlockerId = null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 860,
    minHeight: 620,
    backgroundColor: '#f7f6f2',
    title: 'Паветта Агент',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#fbfaf7', symbolColor: '#292a2e', height: 38 },
    show: !START_HIDDEN,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (START_HIDDEN) mainWindow.setSkipTaskbar(true);
  mainWindow.on('close', event => {
    if (!quitting && preferences.closeToTray && !QA_SCREENSHOT) {
      event.preventDefault();
      mainWindow.hide();
      mainWindow.setSkipTaskbar(true);
    }
  });
  if (QA_SCREENSHOT) {
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        // Give Chromium one frame to paint before capturePage. Without this,
        // Windows can intermittently return UnknownVizError on a cold start.
        await new Promise(resolve => setTimeout(resolve, 250));
        const metrics = await mainWindow.webContents.executeJavaScript(`({
        title: document.title,
        shell: document.querySelector('.app-shell')?.getBoundingClientRect().toJSON(),
        sidebar: document.querySelector('.sidebar')?.getBoundingClientRect().toJSON(),
        composer: document.querySelector('.composer')?.getBoundingClientRect().toJSON(),
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
        })`);
        const image = await mainWindow.webContents.capturePage();
        await fs.writeFile(path.join(__dirname, 'qa-render.png'), image.toPNG());
        await mainWindow.webContents.executeJavaScript(`document.getElementById('accountDialog').showModal(); true`);
        await new Promise(resolve => setTimeout(resolve, 120));
        const accountImage = await mainWindow.webContents.capturePage();
        await fs.writeFile(path.join(__dirname, 'qa-account.png'), accountImage.toPNG());
        console.log('desktop visual QA', JSON.stringify(metrics));
      } catch (error) {
        console.error('desktop visual QA failed', error.message || String(error));
        process.exitCode = 1;
      } finally {
        app.quit();
      }
    });
  }
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function requireProject() {
  if (!projectRoot) throw new Error('Сначала выберите папку проекта.');
  return projectRoot;
}

async function indexedProject(force = false) {
  const root = requireProject();
  if (!force && projectIndexCache.root === root && projectIndexCache.value && Date.now() - projectIndexCache.at < 60_000) return projectIndexCache.value;
  const value = await core.projectIndex(root, { maxFiles: 900, maxDepth: 8 });
  projectIndexCache = { root, at: Date.now(), value };
  return value;
}

async function writeWithBackup(request) {
  const root = requireProject();
  const checkpoint = checkpoints.get(String(request?.checkpointId || ''));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupRoot = path.join(app.getPath('userData'), 'backups', stamp);
  await fs.mkdir(backupRoot, { recursive: true });
  const preview = await core.previewWrite(root, request.path, request.content);
  if (checkpoint && preview.changed && !checkpoint.records.has(preview.path)) {
    const checkpointRecord = { path: preview.path, created: !preview.exists, backupRoot: checkpoint.backupRoot };
    if (preview.exists) {
      const source = core.safeResolve(root, preview.path);
      const backup = core.safeResolve(checkpoint.backupRoot, preview.path);
      await fs.mkdir(path.dirname(backup), { recursive: true });
      await fs.copyFile(source, backup);
    }
    checkpoint.records.set(preview.path, checkpointRecord);
  }
  const result = await core.writeTextFile(root, request.path, request.content, backupRoot);
  await logActivity(result.changed ? 'file_written' : 'file_unchanged', { path: result.path });
  if (!result.changed) return result;
  const record = { path: result.path, created: result.created, backupRoot };
  const undoToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeRecords.set(undoToken, record);
  projectIndexCache = { root: '', at: 0, value: null };
  return { path: result.path, changed: true, created: result.created, undoToken };
}

async function readLimitedResponse(response, limit = 500_000) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.length > limit) {
      await reader.cancel().catch(() => {});
      return `${text.slice(0, limit)}\n…ответ API обрезан приложением…`;
    }
  }
  return text + decoder.decode();
}

async function ensurePublicHost(hostname) {
  const addresses = await dns.lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(item => core.isPrivateAddress(item.address))) throw new Error('API указывает на локальный или недоступный адрес.');
}

async function externalApiRequest(request) {
  const url = core.validateExternalUrl(request?.url);
  await ensurePublicHost(url.hostname);
  const method = core.normalizeHttpMethod(request?.method);
  const headers = {};
  for (const [name, value] of Object.entries(request?.headers || {}).slice(0, 30)) {
    if (!/^[A-Za-z0-9-]{1,80}$/.test(name) || /^(?:host|content-length|cookie|origin|referer)$/i.test(name)) continue;
    headers[name] = String(value).slice(0, 8_000);
  }
  const body = ['GET', 'HEAD'].includes(method) ? undefined : String(request?.body ?? '').slice(0, 200_000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await session.defaultSession.fetch(url.toString(), { method, headers, body, redirect: 'manual', signal: controller.signal });
    const text = await readLimitedResponse(response);
    await logActivity('external_api_request', { host: url.hostname, method, status: response.status });
    return { url: url.toString(), method, status: response.status, ok: response.ok, contentType: response.headers.get('content-type') || '', body: text };
  } finally { clearTimeout(timeout); }
}

async function browserCheck(request) {
  const url = core.validateBrowserUrl(request?.url);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '::1' || /^127\./.test(host);
  if (!loopback) await ensurePublicHost(url.hostname);
  const started = Date.now();
  const consoleMessages = [];
  const loadErrors = [];
  const partition = `temp:pawetta-browser-check-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, partition }
  });
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    try {
      const requested = new URL(details.url);
      if (['data:', 'blob:', 'about:'].includes(requested.protocol)) return callback({ cancel: false });
      if (!['http:', 'https:', 'ws:', 'wss:'].includes(requested.protocol)) return callback({ cancel: true });
      const requestedHost = requested.hostname.toLowerCase().replace(/^\[|\]$/g, '');
      const requestedLoopback = requestedHost === 'localhost' || requestedHost === '::1' || /^127\./.test(requestedHost);
      if (requestedLoopback && !loopback) return callback({ cancel: true });
      if (!requestedLoopback && core.isPrivateAddress(requestedHost)) return callback({ cancel: true });
      callback({ cancel: false });
    } catch { callback({ cancel: true }); }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level < 2 || consoleMessages.length >= 40) return;
    consoleMessages.push({ level, message: String(message || '').slice(0, 600), line, source: String(sourceId || '').slice(0, 300) });
  });
  window.webContents.on('did-fail-load', (_event, code, description, failedUrl, isMainFrame) => {
    if (loadErrors.length < 30) loadErrors.push({ code, description, url: failedUrl, mainFrame: !!isMainFrame });
  });
  const timeoutMs = Math.min(Math.max(Number(request?.timeoutMs) || 20_000, 3_000), 30_000);
  let timer;
  try {
    await Promise.race([
      window.loadURL(url.toString()),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Страница не загрузилась за отведённое время.')), timeoutMs); })
    ]);
    const page = await window.webContents.executeJavaScript(`(() => ({
      title: document.title,
      url: location.href,
      text: (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 12000),
      links: document.links?.length || 0,
      forms: document.forms?.length || 0,
      images: document.images?.length || 0,
      viewport: { width: innerWidth, height: innerHeight },
      documentSize: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }
    }))()`);
    const result = { ok: !loadErrors.some(item => item.mainFrame), loadMs: Date.now() - started, page, consoleMessages, loadErrors };
    await logActivity('browser_checked', { host: url.hostname, ok: result.ok, consoleErrors: consoleMessages.length, loadErrors: loadErrors.length });
    return result;
  } finally {
    clearTimeout(timer);
    if (!window.isDestroyed()) window.destroy();
  }
}

ipcMain.handle('agent:select-project', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Выберите папку проекта',
    properties: ['openDirectory', 'createDirectory']
  });
  if (!result.canceled && result.filePaths[0]) {
    projectRoot = path.resolve(result.filePaths[0]);
    projectIndexCache = { root: '', at: 0, value: null };
    await saveSettings();
    await logActivity('project_selected', { project: path.basename(projectRoot) });
  }
  return publicProject();
});
ipcMain.handle('agent:account', async () => accountSnapshot());
ipcMain.handle('agent:login', async () => {
  const existing = await accountSnapshot();
  if (existing.authorized) return existing;
  return new Promise(resolve => {
    let finished = false;
    const authWindow = new BrowserWindow({
      width: 520,
      height: 720,
      minWidth: 420,
      minHeight: 560,
      parent: mainWindow,
      modal: true,
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      title: 'Вход в Паветту',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    const finish = async () => {
      if (finished) return;
      finished = true;
      const account = await accountSnapshot();
      await logActivity(account.authorized ? 'login_success' : 'login_cancelled', { account: account.email || account.name || '' });
      if (!authWindow.isDestroyed()) authWindow.destroy();
      resolve(account);
    };
    const check = async (_event, url) => {
      if (/^https:\/\/(?:www\.)?pawetta\.com\/ai\/?/i.test(String(url))) {
        const account = await accountSnapshot();
        if (account.authorized) finish();
      }
    };
    authWindow.webContents.on('did-navigate', check);
    authWindow.webContents.on('did-redirect-navigation', check);
    authWindow.on('closed', finish);
    authWindow.loadURL(`${SITE_URL}/api/auth/login?return=/ai/`).catch(finish);
  });
});
ipcMain.handle('agent:logout', async () => {
  await siteFetch('/api/auth/logout?return=/ai/', { redirect: 'follow' }).catch(() => null);
  await logActivity('logout');
  return accountSnapshot();
});
ipcMain.handle('agent:activity', async (_event, limit) => recentActivity(limit));
ipcMain.handle('agent:clear-activity', async () => {
  await fs.rm(activityPath(), { force: true }).catch(() => {});
  await logActivity('activity_cleared');
  return recentActivity();
});
ipcMain.handle('agent:log', async (_event, payload) => {
  const details = payload && typeof payload.details === 'object' ? payload.details : {};
  await logActivity(payload?.type || 'renderer_event', details);
  return true;
});
ipcMain.handle('agent:preferences', async () => ({ ...preferences, startHidden: START_HIDDEN, packaged: app.isPackaged }));
ipcMain.handle('agent:set-preferences', async (_event, next) => {
  for (const key of ['autoLaunch', 'closeToTray', 'notifyOnComplete']) {
    if (typeof next?.[key] === 'boolean') preferences[key] = next[key];
  }
  await saveSettings();
  applyAutoLaunch();
  rebuildTrayMenu();
  return { ...preferences, startHidden: START_HIDDEN, packaged: app.isPackaged };
});
ipcMain.handle('agent:check-update', async () => updateSnapshot());
ipcMain.handle('agent:status', async () => publicProject());
ipcMain.handle('agent:tree', async (_event, options) => { await logActivity('project_scanned', { project: path.basename(requireProject()) }); return core.projectTree(requireProject(), options || {}); });
ipcMain.handle('agent:index', async (_event, force) => { await logActivity('project_indexed', { project: path.basename(requireProject()) }); return indexedProject(!!force); });
ipcMain.handle('agent:list-directory', async (_event, request) => { await logActivity('directory_listed', { path: request?.path || '.' }); return core.listDirectory(requireProject(), request?.path || '.', request?.options || {}); });
ipcMain.handle('agent:read-file', async (_event, relativePath) => { await logActivity('file_read', { path: relativePath }); return core.readTextFile(requireProject(), relativePath); });
ipcMain.handle('agent:read-many', async (_event, paths) => { await logActivity('files_read', { count: Array.isArray(paths) ? paths.length : 0 }); return core.readManyTextFiles(requireProject(), paths); });
ipcMain.handle('agent:search', async (_event, query) => { await logActivity('project_searched', { queryLength: String(query || '').length }); return core.searchProject(requireProject(), query); });
ipcMain.handle('agent:system-info', async () => ({ platform: 'Windows', release: os.release(), arch: os.arch(), cpuCores: os.cpus().length, memoryGb: Math.round(os.totalmem() / 1073741824) }));
ipcMain.handle('agent:http-request', async (_event, request) => externalApiRequest(request));
ipcMain.handle('agent:browser-check', async (_event, request) => browserCheck(request));
ipcMain.handle('agent:open-url', async (_event, value) => {
  const url = core.validateExternalUrl(value);
  await shell.openExternal(url.toString());
  await logActivity('external_url_opened', { host: url.hostname });
  return { opened: true, url: url.toString() };
});
ipcMain.handle('agent:open-path', async (_event, relativePath) => {
  const target = core.safeResolve(requireProject(), relativePath || '.');
  const error = await shell.openPath(target);
  if (error) throw new Error(error);
  await logActivity('project_path_opened', { path: relativePath || '.' });
  return { opened: true, path: relativePath || '.' };
});
ipcMain.handle('agent:clipboard-write', async (_event, value) => {
  const text = String(value || '').slice(0, 50_000);
  clipboard.writeText(text);
  await logActivity('clipboard_written', { chars: text.length });
  return { copied: true, chars: text.length };
});
ipcMain.handle('agent:launch-app', async (_event, appId) => {
  const applications = { notepad: 'notepad.exe', calculator: 'calc.exe', paint: 'mspaint.exe', explorer: 'explorer.exe', vscode: 'code.cmd' };
  const command = applications[String(appId || '').toLowerCase()];
  if (!command) throw new Error('Это приложение не входит в разрешённый список.');
  const child = spawn(command, [], { detached: true, windowsHide: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  await logActivity('application_launched', { app: appId });
  return { launched: true, app: appId };
});
ipcMain.handle('agent:preview-write', async (_event, request) => core.previewWrite(requireProject(), request.path, request.content));
ipcMain.handle('agent:write-file', async (_event, request) => writeWithBackup(request));
ipcMain.handle('agent:preview-edit', async (_event, request) => {
  const preview = await core.previewEdit(requireProject(), request.path, request.oldText, request.newText, !!request.replaceAll);
  const { content, ...publicPreview } = preview;
  return publicPreview;
});
ipcMain.handle('agent:edit-file', async (_event, request) => {
  const edit = await core.previewEdit(requireProject(), request.path, request.oldText, request.newText, !!request.replaceAll);
  return writeWithBackup({ path: request.path, content: edit.content, checkpointId: request.checkpointId });
});
ipcMain.handle('agent:create-checkpoint', async () => {
  requireProject();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const backupRoot = path.join(app.getPath('userData'), 'checkpoints', id);
  checkpoints.set(id, { backupRoot, records: new Map() });
  await logActivity('checkpoint_created', { id });
  return { id };
});
ipcMain.handle('agent:rollback-checkpoint', async (_event, id) => {
  const checkpoint = checkpoints.get(String(id || ''));
  if (!checkpoint) throw new Error('Контрольная точка больше недоступна.');
  const records = [...checkpoint.records.values()].reverse();
  for (const record of records) await core.undoWrite(requireProject(), record);
  checkpoints.delete(String(id));
  projectIndexCache = { root: '', at: 0, value: null };
  await logActivity('checkpoint_rolled_back', { files: records.length });
  return { restored: records.length };
});
ipcMain.handle('agent:discard-checkpoint', async (_event, id) => {
  const checkpoint = checkpoints.get(String(id || ''));
  checkpoints.delete(String(id || ''));
  if (checkpoint && !checkpoint.records.size) await fs.rm(checkpoint.backupRoot, { recursive: true, force: true }).catch(() => {});
  return true;
});
ipcMain.handle('agent:undo-write', async (_event, token) => {
  const record = writeRecords.get(String(token || ''));
  if (!record) throw new Error('Это изменение уже нельзя отменить.');
  const result = await core.undoWrite(requireProject(), record);
  await logActivity('write_undone', { path: record.path });
  writeRecords.delete(String(token));
  return result;
});
ipcMain.handle('agent:run-command', async (_event, request) => {
  const started = Date.now();
  try {
    const result = await core.runCommand(requireProject(), request.command, request.options || {});
    await logActivity('command_finished', { code: result.code, durationMs: Date.now() - started });
    return result;
  } catch (error) {
    await logActivity('command_failed', { error: error.message || String(error), durationMs: Date.now() - started });
    throw error;
  }
});
ipcMain.on('agent:chat-start', async (event, request) => {
  const requestId = String(request?.requestId || '');
  if (!requestId || chatControllers.has(requestId)) return;
  const controller = new AbortController();
  chatControllers.set(requestId, controller);
  keepComputerAwake();
  const send = payload => {
    if (!event.sender.isDestroyed()) event.sender.send('agent:chat-event', { requestId, ...payload });
  };
  const payload = {
    q: core.compactPrompt(request.prompt, 72_000),
    h: core.compactHistory(request.history, 12_000),
    m: 'coder',
    model: request.model || 'auto',
    web: false
  };
  await logActivity('agent_request_started', { requestId, model: payload.model, promptChars: String(request.prompt || '').length, historyItems: Array.isArray(request.history) ? request.history.length : 0 });
  const timeout = setTimeout(() => controller.abort(new Error('Ответ занял больше двух минут.')), 120_000);
  let finalUsage = null;
  try {
    const response = await session.defaultSession.fetch(API_STREAM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!response.ok || !response.body) {
      if (response.status === 413) throw new Error('Контекст шага слишком большой. Приложение сократит вывод — повторите запрос.');
      throw new Error(`Сервер вернул ошибку ${response.status}.`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = pending.split('\n');
      pending = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.type === 'error') throw new Error(message.error || 'Не удалось получить ответ.');
        if (message.type === 'done') finalUsage = message.usage || finalUsage;
        send({ type: message.type, data: message });
      }
      if (done) break;
    }
    if (pending.trim()) {
      const message = JSON.parse(pending);
      if (message.type === 'error') throw new Error(message.error || 'Не удалось получить ответ.');
      if (message.type === 'done') finalUsage = message.usage || finalUsage;
      send({ type: message.type, data: message });
    }
    send({ type: 'complete' });
    await logActivity('agent_request_finished', { requestId, tokens: finalUsage?.tokens || '', rub: finalUsage?.rub || '' });
    notifyComplete();
  } catch (error) {
    send({ type: controller.signal.aborted ? 'aborted' : 'error', error: error.message || String(error) });
    await logActivity(controller.signal.aborted ? 'agent_request_aborted' : 'agent_request_failed', { requestId, error: error.message || String(error) });
  } finally {
    clearTimeout(timeout);
    chatControllers.delete(requestId);
    if (!chatControllers.size) releaseComputerAwake();
  }
});
ipcMain.on('agent:chat-abort', (_event, requestId) => chatControllers.get(String(requestId || ''))?.abort());
ipcMain.handle('agent:open-external', async (_event, url) => {
  if (/^https:\/\/(?:www\.)?pawetta\.com(?:\/|$)/i.test(String(url))) await shell.openExternal(url);
});

if (singleInstance) {
  app.on('second-instance', () => showMainWindow());
  app.whenReady().then(async () => {
    await loadSettings();
    applyAutoLaunch();
    createTray();
    if (!START_HIDDEN) createWindow();
    app.on('activate', () => showMainWindow());
  });
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => {
    if (process.platform === 'darwin' || tray) return;
    app.quit();
  });
}
