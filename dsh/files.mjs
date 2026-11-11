import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const MAX_FILE_BYTES = 1024 * 1024;
const MAX_ENTRIES = 2000;
const runFile = promisify(execFile);
export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new ApiError(status, message); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
const protectedPart = part => /^\.git$/i.test(part) || /^\.env(?:\.|$)/i.test(part)
  || /^(?:\.ssh|\.aws|\.gnupg|\.azure|\.kube|\.docker|\.config|\.npmrc|\.netrc|\.pypirc|credentials(?:\..*)?|secrets?(?:\..*)?|id_rsa|id_ed25519)$/i.test(part)
  || /\.(?:pem|key|p12|pfx)$/i.test(part);
function validatePath(value, allowEmpty = false) {
  if (typeof value !== 'string' || value.includes('\0') || value.includes('\\') || path.posix.isAbsolute(value)
    || /^[A-Za-z]:/.test(value) || (!value && !allowEmpty)) fail(400, 'Invalid relative path');
  const parts = value ? value.split('/') : [];
  if (parts.some(p => !p || p === '.' || p === '..')) fail(400, 'Invalid relative path');
  if (parts.some(protectedPart)) fail(403, 'Protected path');
  return parts;
}
function decode(bytes) {
  if (bytes.length > MAX_FILE_BYTES) fail(413, 'File exceeds 1 MiB');
  if (bytes.some(b => b === 0 || (b < 32 && b !== 9 && b !== 10 && b !== 13))) fail(415, 'Binary files are not supported');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail(415, 'File must be valid UTF-8 text'); }
}
function contentBytes(content) {
  if (typeof content !== 'string') fail(400, 'content must be a string');
  const bytes = Buffer.from(content, 'utf8');
  if (decode(bytes) !== content) fail(400, 'content must be valid UTF-8 text');
  return bytes;
}
function normalizeError(error) {
  if (error instanceof ApiError) return error;
  if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return new ApiError(404, 'Path not found');
  if (error.code === 'EACCES' || error.code === 'EPERM' || error.code === 'ELOOP') return new ApiError(403, 'Path access denied');
  return new ApiError(500, 'File operation failed');
}

export function createFileService() {
  const projects = new Map();
  const locks = new Map();
  function project(id) {
    if (typeof id !== 'string' || !projects.has(id)) fail(404, 'Unknown project');
    return projects.get(id);
  }
  async function resolve(project, relative, allowEmpty = false) {
    const parts = validatePath(relative, allowEmpty);
    // Reject symlinks, including in-root aliases, to keep one lock per real file.
    if (await fs.realpath(project.root) !== project.root) fail(403, 'Project root changed');
    let current = project.root;
    for (const part of parts) {
      current = path.join(current, part);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) fail(403, 'Symbolic links are not supported');
      if (!inside(project.root, await fs.realpath(current))) fail(403, 'Path escapes project');
    }
    return current;
  }
  async function readResolved(project, relative) {
    const file = await resolve(project, relative);
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const stat = await handle.stat();
      const verified = await fs.stat(await resolve(project, relative));
      if (verified.dev !== stat.dev || verified.ino !== stat.ino) fail(409, 'File changed during access');
      if (!stat.isFile()) fail(400, 'Path is not a regular file');
      if (stat.nlink > 1) fail(403, 'Hard-linked files are not supported');
      if (stat.size > MAX_FILE_BYTES) fail(413, 'File exceeds 1 MiB');
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
        if (!bytesRead) break;
        size += bytesRead;
      }
      const bytes = buffer.subarray(0, size);
      return { path: relative, content: decode(bytes), revision: hash(bytes), mode: stat.mode & 0o777, file };
    } finally { await handle.close(); }
  }
  async function locked(key, fn) {
    const previous = locks.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(fn);
    locks.set(key, current);
    try { return await current; }
    finally { if (locks.get(key) === current) locks.delete(key); }
  }
  const publicRead = ({ path, content, revision }) => ({ path, content, revision });
  const operations = {
    async open({ root }) {
      if (typeof root !== 'string' || !root || root.includes('\0') || !path.isAbsolute(root)) fail(400, 'root must be an absolute directory path');
      const real = await fs.realpath(root);
      if (!(await fs.stat(real)).isDirectory()) fail(400, 'root must be a directory');
      const id = randomUUID();
      const result = { id, root: real, name: path.basename(real) || real };
      projects.set(id, result);
      return { project: { ...result } };
    },
    async tree({ projectId, path: relative = '' }) {
      const selected = project(projectId);
      const directory = await resolve(selected, relative, true);
      if (!(await fs.stat(directory)).isDirectory()) fail(400, 'Path is not a directory');
      const entries = [];
      let truncated = false;
      const dir = await fs.opendir(directory);
      for await (const item of dir) {
        if (protectedPart(item.name) || item.isSymbolicLink() || (!item.isDirectory() && !item.isFile())) continue;
        if (entries.length === MAX_ENTRIES) { truncated = true; break; }
        entries.push({ name: item.name, path: relative ? `${relative}/${item.name}` : item.name, type: item.isDirectory() ? 'directory' : 'file' });
      }
      entries.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1);
      return { entries, truncated };
    },
    async read({ projectId, path: relative }) {
      return publicRead(await readResolved(project(projectId), relative));
    },
    async save({ projectId, path: relative, content, revision }) {
      const selected = project(projectId);
      validatePath(relative);
      const bytes = contentBytes(content);
      if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) fail(400, 'A SHA-256 revision is required');
      return locked(path.join(selected.root, ...relative.split('/')), async () => {
        const original = await readResolved(selected, relative);
        if (original.revision !== revision) fail(409, 'File changed; reload before saving');
        const temporary = path.join(path.dirname(original.file), `.acw-${randomUUID()}.tmp`);
        let handle;
        try {
          handle = await fs.open(temporary, 'wx', original.mode);
          await handle.writeFile(bytes);
          await handle.chmod(original.mode);
          await handle.sync();
          await handle.close(); handle = undefined;
          // Recheck immediately before commit; serializes this service's saves and catches external edits.
          if ((await readResolved(selected, relative)).revision !== revision) fail(409, 'File changed; reload before saving');
          await fs.rename(temporary, original.file);
          return { path: relative, content, revision: hash(bytes) };
        } finally {
          if (handle) await handle.close();
          await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
        }
      });
    },
    async diff({ projectId, path: relative }) {
      const selected = project(projectId);
      await readResolved(selected, relative);
      try {
        const { stdout } = await runFile('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'diff.external=', 'diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', `:(literal)${relative}`], {
          cwd: selected.root, timeout: 5000, maxBuffer: MAX_FILE_BYTES, encoding: 'utf8',
          env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
        });
        return { diff: stdout };
      } catch (error) {
        fail(error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 413 : 422, 'Git diff unavailable or exceeded its limit');
      }
    },
  };
  return Object.fromEntries(Object.entries(operations).map(([name, fn]) => [name, async (input = {}) => {
    try {
      if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'Expected JSON object');
      return await fn(input);
    } catch (error) { throw normalizeError(error); }
  }]));
}

export async function parseRequest(request) {
  try {
    const body = request.body;
    if (Buffer.isBuffer(body) || body instanceof Uint8Array || typeof body === 'string') {
      if (Buffer.byteLength(body) > 8 * MAX_FILE_BYTES) fail(413, 'Request body too large');
      return JSON.parse(Buffer.isBuffer(body) || body instanceof Uint8Array ? new TextDecoder('utf-8', { fatal: true }).decode(body) : body);
    }
    if (typeof request.arrayBuffer === 'function') {
      const buffer = await request.arrayBuffer();
      if (buffer.byteLength > 8 * MAX_FILE_BYTES) fail(413, 'Request body too large');
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
    }
    // Some host adapters expose the buffered, already parsed JSON value.
    if (body && typeof body === 'object' && typeof body.getReader !== 'function') return body;
    fail(400, 'Expected JSON request body');
  } catch (error) {
    if (error instanceof ApiError) throw error;
    fail(400, 'Invalid JSON request body');
  }
}

export function registerRoutes(ctx, service = createFileService()) {
  for (const operation of ['open', 'tree', 'read', 'save', 'diff']) {
    ctx.connection.fetch.register({
      path: `/api/ai-coding-workbench/${operation}`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        try {
          const result = await service[operation](await parseRequest(request));
          return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
        } catch (error) {
          const safe = normalizeError(error);
          return Response.json({ error: safe.message }, { status: safe.status, headers: { 'Cache-Control': 'no-store' } });
        }
      },
    });
  }
  return service;
}
