'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = require('../src/agent-core');

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pawetta-agent-'));
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'app.js'), 'const answer = 42;\nconsole.log(answer);\n', 'utf8');
  await fs.writeFile(path.join(root, 'README.md'), '# Demo\n', 'utf8');
  return root;
}

test('safeResolve keeps access inside project', async () => {
  const root = await fixture();
  assert.equal(core.safeResolve(root, 'src/app.js'), path.join(root, 'src', 'app.js'));
  assert.throws(() => core.safeResolve(root, '../secret.txt'), /за пределами/);
  await fs.rm(root, { recursive: true, force: true });
});

test('tree, read and search work on text files', async () => {
  const root = await fixture();
  const tree = await core.projectTree(root);
  assert.deepEqual(tree.files, ['src/app.js', 'README.md']);
  const file = await core.readTextFile(root, 'src/app.js');
  assert.match(file.content, /answer = 42/);
  const search = await core.searchProject(root, 'console.log');
  assert.equal(search.results[0].path, 'src/app.js');
  assert.equal(search.results[0].line, 2);
  await fs.rm(root, { recursive: true, force: true });
});

test('project index exposes languages, symbols and project instructions', async () => {
  const root = await fixture();
  const index = await core.projectIndex(root);
  assert.equal(index.languages.JavaScript, 1);
  assert.match(index.text, /src\/app\.js/);
  assert.match(index.text, /README\.md/);
  await fs.rm(root, { recursive: true, force: true });
});

test('point edits require an exact unique fragment', async () => {
  const root = await fixture();
  const edit = await core.previewEdit(root, 'src/app.js', 'answer = 42', 'answer = 43');
  assert.match(edit.content, /answer = 43/);
  await assert.rejects(() => core.previewEdit(root, 'src/app.js', 'missing', 'value'), /не найден/);
  await fs.rm(root, { recursive: true, force: true });
});

test('directory listing and parallel reads stay inside project', async () => {
  const root = await fixture();
  const listing = await core.listDirectory(root, '.');
  assert.deepEqual(listing.entries, [
    { name: 'src', type: 'directory' },
    { name: 'README.md', type: 'file' }
  ]);
  const files = await core.readManyTextFiles(root, ['README.md', 'src/app.js', '../nope']);
  assert.equal(files[0].ok, true);
  assert.equal(files[1].ok, true);
  assert.equal(files[2].ok, false);
  await fs.rm(root, { recursive: true, force: true });
});

test('preview and write keep a backup', async () => {
  const root = await fixture();
  const backup = await fs.mkdtemp(path.join(os.tmpdir(), 'pawetta-backup-'));
  const preview = await core.previewWrite(root, 'src/app.js', 'const answer = 43;\n');
  assert.equal(preview.changed, true);
  const result = await core.writeTextFile(root, 'src/app.js', 'const answer = 43;\n', backup);
  assert.equal(result.changed, true);
  assert.equal(await fs.readFile(path.join(backup, 'src', 'app.js'), 'utf8'), 'const answer = 42;\nconsole.log(answer);\n');
  await core.undoWrite(root, result);
  assert.equal(await fs.readFile(path.join(root, 'src', 'app.js'), 'utf8'), 'const answer = 42;\nconsole.log(answer);\n');
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(backup, { recursive: true, force: true });
});

test('dangerous commands are blocked', () => {
  assert.match(core.commandIsBlocked('Remove-Item C:\\Temp -Recurse'), /заблокирована/);
  assert.match(core.commandIsBlocked('shutdown /s'), /заблокирована/);
  assert.equal(core.commandIsBlocked('npm test'), '');
});

test('external API URLs require public HTTPS addresses', () => {
  assert.equal(core.validateExternalUrl('https://api.example.com/v1').hostname, 'api.example.com');
  assert.throws(() => core.validateExternalUrl('http://api.example.com'), /HTTPS/);
  assert.throws(() => core.validateExternalUrl('https://127.0.0.1/admin'), /локальной сети/);
  assert.throws(() => core.validateExternalUrl('https://user:pass@example.com'), /Логин и пароль/);
  assert.equal(core.normalizeHttpMethod('post'), 'POST');
  assert.throws(() => core.normalizeHttpMethod('TRACE'), /не поддерживается/);
});

test('history compaction keeps newest context inside request budget', () => {
  const history = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user', content: `${index}:` + 'x'.repeat(10_000)
  }));
  const compacted = core.compactHistory(history, 25_000);
  assert.ok(compacted.reduce((sum, item) => sum + item.content.length, 0) <= 25_000);
  assert.match(compacted.at(-1).content, /^11:/);
});

test('prompt compaction preserves protocol start and newest tool output', () => {
  const prompt = `PROTOCOL:${'a'.repeat(40_000)}LATEST:${'z'.repeat(40_000)}`;
  const compacted = core.compactPrompt(prompt, 30_000);
  assert.ok(compacted.length <= 30_000);
  assert.match(compacted, /^PROTOCOL:/);
  assert.match(compacted, /z{100}$/);
  assert.match(compacted, /часть большого вывода убрана/);
});
