import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createFileService, registerRoutes, MAX_FILE_BYTES } from '../dsh/files.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acw-test-'));
  const root = path.join(directory, 'project');
  await fs.mkdir(root);
  // directory is the exact mkdtemp-owned absolute path, never caller-controlled.
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const service = createFileService();
  const { project } = await service.open({ root });
  await fs.writeFile(path.join(root, 'file.txt'), 'hello\n', { mode: 0o640 });
  return { root, directory, service, projectId: project.id };
}
const rejectsStatus = (fn, status) => assert.rejects(fn, error => error.status === status);

test('opens explicit roots with opaque ids and isolated project sessions', async t => {
  const { service, root, projectId } = await fixture(t);
  const result = await service.open({ root });
  assert.equal(result.project.root, await fs.realpath(root));
  assert.equal(result.project.name, 'project');
  assert.notEqual(result.project.id, projectId);
  await rejectsStatus(() => createFileService().read({ projectId, path: 'file.txt' }), 404);
  await rejectsStatus(() => service.open({ root: '.' }), 400);
});

test('rejects traversal, absolute, null, Windows and malformed relative paths', async t => {
  const { service, projectId } = await fixture(t);
  for (const file of ['../file.txt', 'dir/../../file.txt', '/etc/passwd', 'file.txt\0', 'C:/file', 'dir\\file', './file.txt', 'dir//file']) {
    await rejectsStatus(() => service.read({ projectId, path: file }), 400);
    await rejectsStatus(() => service.tree({ projectId, path: file }), 400);
  }
});

test('rejects file and directory symlinks, both inside and outside root', async t => {
  const { service, projectId, root, directory } = await fixture(t);
  await fs.writeFile(path.join(directory, 'outside.txt'), 'outside');
  await fs.symlink(path.join(directory, 'outside.txt'), path.join(root, 'escape'));
  await fs.symlink(directory, path.join(root, 'escape-dir'));
  await fs.symlink(path.join(root, 'file.txt'), path.join(root, 'alias'));
  for (const file of ['escape', 'escape-dir/outside.txt', 'alias']) {
    await rejectsStatus(() => service.read({ projectId, path: file }), 403);
  }
  await rejectsStatus(() => service.tree({ projectId, path: 'escape-dir' }), 403);
  assert.deepEqual((await service.tree({ projectId })).entries.map(e => e.name), ['file.txt']);
});

test('rejects binary, invalid UTF-8, oversized and hard-linked files', async t => {
  const { service, projectId, root } = await fixture(t);
  for (const [name, bytes, status] of [
    ['binary', Buffer.from([97, 0, 98]), 415],
    ['invalid', Buffer.from([0xc3, 0x28]), 415],
    ['big', Buffer.alloc(MAX_FILE_BYTES + 1, 97), 413],
  ]) {
    await fs.writeFile(path.join(root, name), bytes);
    await rejectsStatus(() => service.read({ projectId, path: name }), status);
  }
  await fs.link(path.join(root, 'file.txt'), path.join(root, 'hard-link'));
  await rejectsStatus(() => service.read({ projectId, path: 'hard-link' }), 403);
});

test('save retains mode, returns SHA256 and never creates a missing file', async t => {
  const { service, projectId, root } = await fixture(t);
  const original = await service.read({ projectId, path: 'file.txt' });
  const saved = await service.save({ projectId, ...original, content: 'updated 中文\n' });
  assert.equal(saved.content, 'updated 中文\n');
  assert.equal(saved.revision, createHash('sha256').update(saved.content).digest('hex'));
  assert.equal((await fs.stat(path.join(root, 'file.txt'))).mode & 0o777, 0o640);
  assert.deepEqual(await service.read({ projectId, path: 'file.txt' }), saved);
  assert.deepEqual(await fs.readdir(root), ['file.txt']);
  await rejectsStatus(() => service.save({ projectId, path: 'missing', content: 'x', revision: saved.revision }), 404);
});

test('stale and concurrent saves conflict instead of overwriting', async t => {
  const { service, projectId, root } = await fixture(t);
  const original = await service.read({ projectId, path: 'file.txt' });
  const results = await Promise.allSettled(['first', 'second'].map(content => service.save({ projectId, ...original, content })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
  const latest = await service.read({ projectId, path: 'file.txt' });
  await fs.writeFile(path.join(root, 'file.txt'), 'external');
  await rejectsStatus(() => service.save({ projectId, ...latest, content: 'overwrite' }), 409);
  assert.equal(await fs.readFile(path.join(root, 'file.txt'), 'utf8'), 'external');
});

test('ordinary hidden paths work while credentials and .git are protected', async t => {
  const { service, projectId, root } = await fixture(t);
  await fs.mkdir(path.join(root, '.github'));
  await fs.mkdir(path.join(root, '.git'));
  await fs.writeFile(path.join(root, '.github', 'config'), 'safe');
  for (const name of ['.env', '.env.local', '.npmrc', 'credentials.json', 'private.key', '.gitignore']) {
    await fs.writeFile(path.join(root, name), 'data');
  }
  const names = (await service.tree({ projectId })).entries.map(e => e.name);
  assert.deepEqual(names, ['.github', '.gitignore', 'file.txt']);
  assert.equal((await service.read({ projectId, path: '.github/config' })).content, 'safe');
  for (const file of ['.env', '.env.local', '.git/config', '.npmrc', 'credentials.json', 'private.key']) {
    await rejectsStatus(() => service.read({ projectId, path: file }), 403);
    await rejectsStatus(() => service.save({ projectId, path: file, content: 'x', revision: '0'.repeat(64) }), 403);
  }
  const hidden = await service.read({ projectId, path: '.gitignore' });
  assert.equal((await service.save({ projectId, ...hidden, content: 'node_modules' })).content, 'node_modules');
});

test('validates save text, bounds and required revision', async t => {
  const { service, projectId } = await fixture(t);
  const original = await service.read({ projectId, path: 'file.txt' });
  await rejectsStatus(() => service.save({ projectId, ...original, content: 'a\0b' }), 415);
  await rejectsStatus(() => service.save({ projectId, ...original, content: 'a'.repeat(MAX_FILE_BYTES + 1) }), 413);
  await rejectsStatus(() => service.save({ projectId, ...original, content: '\ud800' }), 400);
  await rejectsStatus(() => service.save({ projectId, path: 'file.txt', content: 'x' }), 400);
});

test('git diff uses HEAD for only the requested literal filename', async t => {
  const { service, projectId, root } = await fixture(t);
  const exec = promisify(execFile);
  await exec('git', ['init', '-q', root]);
  await exec('git', ['-C', root, 'add', 'file.txt']);
  await exec('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial']);
  await fs.writeFile(path.join(root, 'file.txt'), 'changed\n');
  const result = await service.diff({ projectId, path: 'file.txt' });
  assert.match(result.diff, /-hello/);
  assert.match(result.diff, /\+changed/);
});

test('registers only five POST routes and returns JSON errors with statuses', async t => {
  const { service, projectId } = await fixture(t);
  const routes = [];
  registerRoutes({ connection: { fetch: { register: route => routes.push(route) } } }, service);
  assert.equal(routes.length, 5);
  for (const route of routes) {
    assert.deepEqual(route.methods, ['POST']);
    assert.equal(route.requestBody, 'buffered');
  }
  const read = routes.find(r => r.path.endsWith('/read'));
  const response = await read.fetch(new Request('http://localhost/read', { method: 'POST', body: JSON.stringify({ projectId, path: 'file.txt' }) }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).content, 'hello\n');
  const invalid = await read.fetch({ body: Buffer.from('{invalid') });
  assert.equal(invalid.status, 400);
  assert.equal(typeof (await invalid.json()).error, 'string');
  const missing = await read.fetch({ body: Buffer.from(JSON.stringify({ projectId: 'unknown', path: 'file.txt' })) });
  assert.equal(missing.status, 404);
  const traversal = await read.fetch({ body: { projectId, path: '../secret' } });
  assert.equal(traversal.status, 400);
});
