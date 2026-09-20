'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');

test('agent remembers prior user turns and treats permissive replies as approval to choose', () => {
  assert.match(app, /conversationMemory/);
  assert.match(app, /КОНТЕКСТ ПРЕДЫДУЩИХ СООБЩЕНИЙ/);
  assert.match(app, /permitsInitiative/);
  assert.match(app, /Не задавай больше вопросов/);
  assert.match(app, /повторно спрашивать запрещено/);
});

test('Pawetta avatar is shown in the model chip and assistant messages', () => {
  assert.match(html, /model-icon[^>]*><img src="pawetta\.svg"/);
  assert.match(app, /image\.src = 'pawetta\.svg'/);
  assert.match(css, /\.message-avatar img/);
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'renderer', 'pawetta.svg')));
});

test('desktop account, limits, task history and private activity log are wired', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(html, /id="accountDialog"/);
  assert.match(html, /Лимиты агента/);
  assert.match(html, /Журнал действий/);
  assert.match(app, /pawetta-agent-tasks-v2/);
  assert.match(app, /restoreTask/);
  assert.match(preload, /agent:account/);
  assert.match(preload, /agent:activity/);
  assert.match(main, /session\.defaultSession\.fetch/);
  assert.match(main, /activity\.jsonl/);
  assert.match(main, /promptChars/);
  assert.doesNotMatch(main, /prompt:\s*request\.prompt/);
});

test('desktop app supports quiet autostart, tray lifecycle and completion notifications', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /requestSingleInstanceLock/);
  assert.match(main, /--background/);
  assert.match(main, /setLoginItemSettings/);
  assert.match(main, /new Tray/);
  assert.match(main, /Notification\.isSupported/);
  assert.match(main, /powerSaveBlocker\.start/);
  assert.match(main, /if \(!START_HIDDEN\) createWindow\(\)/);
  assert.match(main, /pawetta-agent-latest\.json/);
  assert.match(html, /id="autoLaunchSetting"/);
  assert.match(html, /id="updateCard"/);
  assert.match(preload, /agent:set-preferences/);
  assert.match(preload, /agent:check-update/);
});

test('agent has project indexing, precise edits, verification and task checkpoints', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(app, /"type":"edit_file"/);
  assert.match(app, /Индексирую проект/);
  assert.match(app, /Проверяю результат перед завершением/);
  assert.match(app, /Откатить задачу/);
  assert.match(preload, /agent:preview-edit/);
  assert.match(preload, /agent:create-checkpoint/);
  assert.match(main, /projectIndexCache/);
  assert.match(main, /agent:rollback-checkpoint/);
});

test('every final agent answer shows the total client cost', () => {
  assert.match(app, /taskCostRub \+=/);
  assert.match(app, /Итого за задачу/);
  assert.match(app, /message-cost/);
  assert.match(css, /\.message-cost/);
});

test('computer and API tools require explicit approval and stay constrained', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(app, /"type":"http_request"/);
  assert.match(app, /"type":"launch_app"/);
  assert.match(app, /requestApproval\(action\)/);
  assert.match(preload, /agent:http-request/);
  assert.match(preload, /agent:clipboard-write/);
  assert.match(main, /validateExternalUrl/);
  assert.match(main, /applications = \{ notepad:/);
  assert.match(main, /readLimitedResponse/);
});
