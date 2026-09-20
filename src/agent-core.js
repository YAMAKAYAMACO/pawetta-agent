'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const IGNORED = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'dist', 'build', '.next', '.nuxt',
  '.cache', '.idea', '.vscode', '__pycache__', '.venv', 'venv', 'coverage'
]);
const MAX_FILE_BYTES = 300_000;
const MAX_OUTPUT = 120_000;

function assertRoot(root) {
  if (!root || !path.isAbsolute(root)) throw new Error('Сначала выберите папку проекта.');
}

function safeResolve(root, relativePath = '.') {
  assertRoot(root);
  if (typeof relativePath !== 'string' || relativePath.includes('\0')) {
    throw new Error('Некорректный путь.');
  }
  const normalizedRoot = path.resolve(root);
  const candidate = path.resolve(normalizedRoot, relativePath);
  const prefix = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep;
  if (candidate !== normalizedRoot && !candidate.startsWith(prefix)) {
    throw new Error('Доступ за пределами выбранной папки запрещён.');
  }
  return candidate;
}

function toRelative(root, absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join('/');
}

async function walkFiles(root, options = {}) {
  assertRoot(root);
  const maxFiles = options.maxFiles || 700;
  const maxDepth = options.maxDepth || 7;
  const files = [];

  async function visit(directory, depth) {
    if (files.length >= maxFiles || depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'ru'));
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      if (IGNORED.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(absolute, depth + 1);
      } else if (entry.isFile()) {
        files.push(absolute);
      }
    }
  }

  await visit(path.resolve(root), 0);
  return files;
}

async function projectTree(root, options = {}) {
  const files = await walkFiles(root, options);
  const visible = files.map(file => toRelative(root, file));
  return {
    files: visible,
    text: visible.join('\n'),
    truncated: files.length >= (options.maxFiles || 700)
  };
}

async function readTextFile(root, relativePath) {
  const target = safeResolve(root, relativePath);
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error('Это не файл.');
  if (stat.size > MAX_FILE_BYTES) throw new Error('Файл больше 300 КБ — для MVP он слишком большой.');
  const buffer = await fs.readFile(target);
  if (buffer.includes(0)) throw new Error('Бинарные файлы пока не читаются.');
  return { path: toRelative(root, target), content: buffer.toString('utf8'), size: stat.size };
}

async function readManyTextFiles(root, relativePaths, options = {}) {
  const paths = Array.isArray(relativePaths) ? relativePaths.slice(0, options.maxFiles || 8) : [];
  if (!paths.length) throw new Error('Не указаны файлы для чтения.');
  const settled = await Promise.allSettled(paths.map(file => readTextFile(root, file)));
  return settled.map((item, index) => item.status === 'fulfilled'
    ? { ok: true, ...item.value }
    : { ok: false, path: String(paths[index] || ''), error: item.reason?.message || String(item.reason) });
}

async function listDirectory(root, relativePath = '.', options = {}) {
  const target = safeResolve(root, relativePath || '.');
  const maxEntries = Math.min(Math.max(options.maxEntries || 120, 1), 300);
  const entries = await fs.readdir(target, { withFileTypes: true });
  const all = entries
    .filter(entry => !entry.isSymbolicLink() && !IGNORED.has(entry.name))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'ru'));
  const visible = all.slice(0, maxEntries)
    .map(entry => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' }));
  return { path: toRelative(root, target) || '.', entries: visible, truncated: all.length > visible.length };
}

async function searchProject(root, query) {
  const needle = String(query || '').trim();
  if (!needle) throw new Error('Пустой поисковый запрос.');
  if (needle.length > 180) throw new Error('Слишком длинный поисковый запрос.');
  const files = await walkFiles(root, { maxFiles: 900, maxDepth: 8 });
  const lower = needle.toLocaleLowerCase('ru');
  const results = [];
  for (const file of files) {
    if (results.length >= 80) break;
    let stat;
    try { stat = await fs.stat(file); } catch { continue; }
    if (stat.size > MAX_FILE_BYTES) continue;
    let buffer;
    try { buffer = await fs.readFile(file); } catch { continue; }
    if (buffer.includes(0)) continue;
    const lines = buffer.toString('utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length && results.length < 80; index += 1) {
      if (lines[index].toLocaleLowerCase('ru').includes(lower)) {
        results.push({ path: toRelative(root, file), line: index + 1, text: lines[index].trim().slice(0, 260) });
      }
    }
  }
  return { query: needle, results, truncated: results.length >= 80 };
}

function languageFor(file) {
  const extension = path.extname(file).toLowerCase();
  return ({ '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.ts': 'TypeScript', '.tsx': 'TypeScript', '.jsx': 'JavaScript', '.py': 'Python', '.php': 'PHP', '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.cs': 'C#', '.html': 'HTML', '.css': 'CSS', '.scss': 'SCSS', '.json': 'JSON', '.md': 'Markdown' })[extension] || extension.slice(1).toUpperCase() || 'other';
}

function extractSymbols(content) {
  const patterns = [
    /^\s*(?:export\s+)?(?:async\s+)?function\s+([\w$]+)/,
    /^\s*(?:export\s+)?class\s+([\w$]+)/,
    /^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>/,
    /^\s*(?:async\s+)?def\s+([\w_]+)/,
    /^\s*class\s+([\w_]+)/,
    /^\s*(?:public|private|protected|internal|static|final|async|func|fn)\s+(?:[\w<>,?\[\]]+\s+)?([\w_]+)\s*\(/
  ];
  const symbols = [];
  const lines = String(content || '').split(/\r?\n/);
  for (let index = 0; index < lines.length && symbols.length < 24; index += 1) {
    for (const pattern of patterns) {
      const match = lines[index].match(pattern);
      if (match) { symbols.push(`${match[1]}:${index + 1}`); break; }
    }
  }
  return symbols;
}

async function projectIndex(root, options = {}) {
  const files = await walkFiles(root, { maxFiles: options.maxFiles || 900, maxDepth: options.maxDepth || 8 });
  const languages = new Map();
  const entries = [];
  const important = [];
  const importantNames = new Set(['AGENTS.md', 'README.md', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod']);
  for (const file of files) {
    const relative = toRelative(root, file);
    const language = languageFor(file);
    languages.set(language, (languages.get(language) || 0) + 1);
    let stat;
    try { stat = await fs.stat(file); } catch { continue; }
    if (importantNames.has(path.basename(file)) && stat.size <= 80_000) {
      const content = await fs.readFile(file, 'utf8').catch(() => '');
      important.push(`--- ${relative} ---\n${content.slice(0, 12_000)}`);
    }
    if (stat.size > MAX_FILE_BYTES || !/\.(?:[cm]?[jt]sx?|py|php|go|rs|java|cs)$/i.test(file)) continue;
    const buffer = await fs.readFile(file).catch(() => null);
    if (!buffer || buffer.includes(0)) continue;
    const symbols = extractSymbols(buffer.toString('utf8'));
    if (symbols.length) entries.push(`${relative} → ${symbols.join(', ')}`);
  }
  const languageText = [...languages.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name}: ${count}`).join(', ');
  const fileText = files.map(file => toRelative(root, file)).join('\n');
  return {
    files: files.map(file => toRelative(root, file)),
    languages: Object.fromEntries(languages),
    text: `ЯЗЫКИ: ${languageText || 'не определены'}\n\nФАЙЛЫ:\n${fileText.slice(0, 16_000)}\n\nСИМВОЛЫ:\n${entries.join('\n').slice(0, 18_000)}\n\nПРАВИЛА И КОНФИГУРАЦИЯ:\n${important.join('\n\n').slice(0, 18_000)}`,
    truncated: files.length >= (options.maxFiles || 900)
  };
}

async function previewEdit(root, relativePath, oldText, newText, replaceAll = false) {
  const file = await readTextFile(root, relativePath);
  const needle = String(oldText ?? '');
  if (!needle) throw new Error('Для точечной правки нужен непустой старый фрагмент.');
  const occurrences = file.content.split(needle).length - 1;
  if (!occurrences) throw new Error('Старый фрагмент не найден — сначала перечитайте файл.');
  if (!replaceAll && occurrences !== 1) throw new Error(`Фрагмент встречается ${occurrences} раз. Укажите более точный фрагмент.`);
  const content = replaceAll ? file.content.split(needle).join(String(newText ?? '')) : file.content.replace(needle, String(newText ?? ''));
  const preview = await previewWrite(root, relativePath, content);
  return { ...preview, occurrences, content };
}

async function previewWrite(root, relativePath, content) {
  const target = safeResolve(root, relativePath);
  let oldContent = '';
  let exists = true;
  try { oldContent = (await fs.readFile(target)).toString('utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    exists = false;
  }
  const next = String(content ?? '');
  if (Buffer.byteLength(next, 'utf8') > MAX_FILE_BYTES * 2) throw new Error('Новый файл слишком большой.');
  return {
    path: toRelative(root, target), exists, changed: oldContent !== next,
    oldContent: oldContent.slice(0, 40_000), newContent: next.slice(0, 40_000),
    oldTruncated: oldContent.length > 40_000, newTruncated: next.length > 40_000
  };
}

async function writeTextFile(root, relativePath, content, backupRoot) {
  const target = safeResolve(root, relativePath);
  const preview = await previewWrite(root, relativePath, content);
  if (!preview.changed) return { path: preview.path, changed: false };
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (preview.exists && backupRoot) {
    const backup = safeResolve(backupRoot, preview.path);
    await fs.mkdir(path.dirname(backup), { recursive: true });
    try { await fs.access(backup); } catch { await fs.copyFile(target, backup); }
  }
  const temporary = `${target}.pawetta-${process.pid}-${Date.now()}.tmp`;
  await fs.writeFile(temporary, String(content ?? ''), 'utf8');
  try {
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
  return { path: preview.path, changed: true, created: !preview.exists, backupRoot: backupRoot || '' };
}

async function undoWrite(root, record) {
  const relativePath = String(record?.path || '');
  const target = safeResolve(root, relativePath);
  if (record?.created) {
    await fs.rm(target, { force: true });
    return { path: relativePath, removed: true };
  }
  const backupRoot = String(record?.backupRoot || '');
  if (!backupRoot || !path.isAbsolute(backupRoot)) throw new Error('Резервная копия не найдена.');
  const backup = safeResolve(backupRoot, relativePath);
  await fs.copyFile(backup, target);
  return { path: relativePath, restored: true };
}

function commandIsBlocked(command) {
  const text = String(command || '').trim();
  if (!text) return 'Пустая команда.';
  const blocked = [
    /\bformat(?:\.com)?\b/i, /\bdiskpart\b/i, /\bbcdedit\b/i,
    /\bshutdown\b/i, /\brestart-computer\b/i, /\bstop-computer\b/i,
    /\breg(?:\.exe)?\s+delete\b/i, /\bremove-item\b[^\r\n]*\s-recurse\b/i,
    /\brm\b[^\r\n]*\s-(?:r|rf|fr)\b/i, /\bdel\b[^\r\n]*\/s\b/i
  ];
  return blocked.some(pattern => pattern.test(text)) ? 'Потенциально разрушительная команда заблокирована.' : '';
}

function isPrivateAddress(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.local') || host === '::1') return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true;
  const match = host.match(/^172\.(\d+)\./);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  return /^f[cd][0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host);
}

function validateExternalUrl(value) {
  let url;
  try { url = new URL(String(value || '')); } catch { throw new Error('Некорректный адрес API.'); }
  if (url.protocol !== 'https:') throw new Error('Внешние запросы разрешены только по HTTPS.');
  if (url.username || url.password) throw new Error('Логин и пароль нельзя передавать внутри URL.');
  if (isPrivateAddress(url.hostname)) throw new Error('Запросы к локальной сети и этому компьютеру запрещены.');
  return url;
}

function validateBrowserUrl(value) {
  let url;
  try { url = new URL(String(value || '')); } catch { throw new Error('Некорректный адрес страницы.'); }
  if (url.username || url.password) throw new Error('Логин и пароль нельзя передавать внутри URL.');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '::1' || /^127\./.test(host);
  if (loopback) {
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Локальную страницу можно проверять только по HTTP или HTTPS.');
    return url;
  }
  if (url.protocol !== 'https:') throw new Error('Внешние страницы можно проверять только по HTTPS.');
  if (isPrivateAddress(host)) throw new Error('Адреса в локальной сети запрещены.');
  return url;
}

function normalizeHttpMethod(value) {
  const method = String(value || 'GET').trim().toUpperCase();
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error('Этот HTTP-метод не поддерживается.');
  return method;
}

function compactHistory(history, maxChars = 42_000) {
  const source = Array.isArray(history) ? history : [];
  const result = [];
  let remaining = Math.max(0, maxChars);
  for (let index = source.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const role = source[index]?.role === 'assistant' ? 'assistant' : 'user';
    const content = String(source[index]?.content || '');
    if (!content) continue;
    const clipped = content.slice(Math.max(0, content.length - Math.min(remaining, 14_000)));
    result.unshift({ role, content: clipped });
    remaining -= clipped.length;
  }
  return result;
}

function compactPrompt(prompt, maxChars = 72_000) {
  const text = String(prompt || '');
  if (text.length <= maxChars) return text;
  const headSize = Math.min(18_000, Math.floor(maxChars * 0.35));
  const tailSize = Math.max(0, maxChars - headSize - 74);
  return `${text.slice(0, headSize)}\n\n…часть большого вывода убрана приложением…\n\n${text.slice(-tailSize)}`;
}

async function runCommand(root, command, options = {}) {
  assertRoot(root);
  const blocked = commandIsBlocked(command);
  if (blocked) throw new Error(blocked);
  const timeoutMs = Math.min(Math.max(options.timeoutMs || 90_000, 1_000), 120_000);
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', String(command)], {
      cwd: root,
      windowsHide: true,
      env: { ...process.env, CI: '1', NO_COLOR: '1' }
    });
    let stdout = '';
    let stderr = '';
    let finished = false;
    const append = (current, chunk) => (current + chunk.toString('utf8')).slice(-MAX_OUTPUT);
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    child.on('error', reject);
    const timer = setTimeout(() => {
      if (finished) return;
      child.kill();
      reject(new Error('Команда остановлена по тайм-ауту.'));
    }, timeoutMs);
    child.on('close', code => {
      finished = true;
      clearTimeout(timer);
      resolve({ code: Number(code ?? -1), stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

module.exports = {
  MAX_FILE_BYTES,
  safeResolve,
  projectTree,
  listDirectory,
  readTextFile,
  readManyTextFiles,
  searchProject,
  projectIndex,
  previewEdit,
  previewWrite,
  writeTextFile,
  undoWrite,
  commandIsBlocked,
  isPrivateAddress,
  validateExternalUrl,
  validateBrowserUrl,
  normalizeHttpMethod,
  compactHistory,
  compactPrompt,
  runCommand
};
