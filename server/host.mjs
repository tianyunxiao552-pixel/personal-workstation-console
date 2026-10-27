/**
 * host.mjs - real host metrics, connection probing and sandboxed project file access
 * for the personal Windows workstation console.
 *
 * Node.js >= 24, native ESM, built-in modules only (no npm dependencies).
 *
 * Exports:
 *   collectHostMetrics()                                   -> host snapshot (never throws)
 *   connectionStatus()                                     -> tailscale / agents / docker (cached)
 *   listFiles(root, relative = '', options)                -> directory listing
 *   readText(root, relative)                               -> text file + content hash version
 *   writeText(root, relative, content, expectedVersion?)   -> write with optimistic concurrency
 *   makeDirectory(root, relative)                          -> create a directory
 *   fileInfo(root, relative)                               -> verified absolute path for downloads
 *
 * Every filesystem call is confined to the registered `root`:
 *   - relative paths only (no leading "/", no "C:\", no UNC),
 *   - ".." segments are rejected,
 *   - symlinks / junctions are resolved with realpath and must stay inside the root.
 *
 * Errors always carry `status` (HTTP-ish number), `code` (stable string) and `message`.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/* ------------------------------------------------------------------ */
/* constants                                                          */
/* ------------------------------------------------------------------ */

export const LIMITS = Object.freeze({
  /** Maximum size of a text file that readText/writeText will handle (bytes). */
  maxTextBytes: 2 * 1024 * 1024,
  /** Default page size for listFiles. */
  defaultPageSize: 200,
  /** Hard cap for listFiles page size. */
  maxPageSize: 1000,
  /** Maximum number of path segments accepted in a relative path. */
  maxPathDepth: 64,
});

const IS_WIN = process.platform === 'win32';

/** Non-blocking sampling window used when the CPU baseline is too fresh. */
const CPU_MIN_WINDOW_MS = 150;
/** Cache lifetimes for expensive probes (milliseconds). */
const CACHE_MS = Object.freeze({
  command: 30_000,
  disks: 20_000,
  disksFailure: 30_000,
  gpus: 10_000,
  gpusFailure: 60_000,
  connection: 10_000,
});
/** Per-probe spawn timeouts. */
const TIMEOUT_MS = Object.freeze({
  powershell: 6_000,
  nvidiaSmi: 5_000,
  tailscale: 4_000,
  df: 4_000,
});

const POWERSHELL_DISK_SCRIPT =
  'Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DriveType=3" | ' +
  'Select-Object DeviceID,Size,FreeSpace | ConvertTo-Json -Compress';

/* ------------------------------------------------------------------ */
/* error helpers                                                      */
/* ------------------------------------------------------------------ */

/**
 * Error with a stable `status` / `code` / `message` triple.
 * `message` never contains absolute filesystem paths.
 */
function fail(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function isAbort(error) {
  return typeof error?.status === 'number' && typeof error?.code === 'string';
}

function mapFsError(error, action) {
  if (isAbort(error)) return error;
  const code = error?.code;
  if (code === 'ENOENT') return fail(404, 'NOT_FOUND', `${action}: path does not exist`);
  if (code === 'ENOTDIR') return fail(400, 'NOT_A_DIRECTORY', `${action}: a path segment is not a directory`);
  if (code === 'EISDIR') return fail(400, 'E_IS_DIRECTORY', `${action}: path is a directory`);
  if (code === 'EACCES' || code === 'EPERM') return fail(403, 'PERMISSION_DENIED', `${action}: permission denied`);
  if (code === 'EBUSY' || code === 'EMFILE' || code === 'ENFILE' || code === 'ENOSPC') {
    return fail(503, 'IO_UNAVAILABLE', `${action}: filesystem is temporarily unavailable (${code})`);
  }
  if (code === 'ENAMETOOLONG') return fail(400, 'PATH_TOO_LONG', `${action}: path is too long`);
  if (code === 'ELOOP') return fail(400, 'PATH_UNRESOLVABLE', `${action}: too many symbolic link levels`);
  return fail(500, 'IO_ERROR', `${action} failed (${code || 'unknown error'})`);
}

/* ------------------------------------------------------------------ */
/* small utilities                                                    */
/* ------------------------------------------------------------------ */

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  const clamped = Math.min(100, Math.max(0, value));
  return Math.round(clamped * 10) / 10;
}

function round1(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : 0;
}

/** Run a command with hard argv (never a shell string) and a kill timeout. */
function runCommand(file, args, timeout) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        timeout,
        killSignal: 'SIGKILL',
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error?.code ?? 0,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
        });
      },
    );
  });
}

/**
 * TTL cache with in-flight de-duplication: UI polls never pile up spawns.
 * `ttlFor(value)` optionally overrides the TTL for a specific cached value
 * (used to back off longer after a failed hardware probe).
 */
function createTtlCache(defaultTtlMs, ttlFor) {
  let value;
  let expiresAt = 0;
  let inflight = null;
  return function cached(loader) {
    if (value !== undefined && Date.now() < expiresAt) return Promise.resolve(value);
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const loaded = await loader();
        value = loaded;
        const ttl = typeof ttlFor === 'function' ? ttlFor(loaded) : defaultTtlMs;
        expiresAt = Date.now() + (Number.isFinite(ttl) ? ttl : defaultTtlMs);
        return loaded;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };
}

/** Resolve a command name through PATH without spawning a process. */
const commandCache = new Map();

async function isUsableFile(candidate) {
  try {
    const stat = await fs.stat(candidate);
    return stat.isFile();
  } catch {
    return false;
  }
}

function pathDirectories() {
  const raw = process.env.PATH || '';
  return raw
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter((entry) => entry.length > 0);
}

function executableExtensions() {
  if (!IS_WIN) return [''];
  const raw = process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
  // Lower-case candidates: Windows lookup is case-insensitive and this keeps the
  // returned path close to the on-disk name for display.
  const exts = ['', ...raw.split(';').filter(Boolean).map((ext) => ext.toLowerCase())];
  return [...new Set(exts.map((ext) => (ext.startsWith('.') ? ext : `.${ext}`)))];
}

async function resolveCommand(name) {
  if (typeof name !== 'string' || name.length === 0) return null;
  const cached = commandCache.get(name);
  if (cached && Date.now() < cached.expiresAt) return cached.value;
  let resolved = null;
  if (name.includes('/') || name.includes('\\')) {
    const absolute = path.isAbsolute(name) ? name : null;
    if (absolute && (await isUsableFile(absolute))) resolved = absolute;
  } else {
    const extensions = executableExtensions();
    for (const dir of pathDirectories()) {
      for (const ext of extensions) {
        const candidate = path.join(dir, name + ext);
        if (await isUsableFile(candidate)) {
          resolved = candidate;
          break;
        }
      }
      if (resolved) break;
    }
  }
  commandCache.set(name, { value: resolved, expiresAt: Date.now() + CACHE_MS.command });
  return resolved;
}

function powershellCommand() {
  return resolveCommand('powershell').then((found) => {
    if (found) return found;
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const fallback = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return fallback;
  });
}

/* ------------------------------------------------------------------ */
/* host metrics                                                       */
/* ------------------------------------------------------------------ */

function snapshotCpu() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const times = cpu.times || {};
    idle += times.idle || 0;
    total += (times.user || 0) + (times.nice || 0) + (times.sys || 0) + (times.idle || 0) + (times.irq || 0);
  }
  return { idle, total, at: Date.now() };
}

/** Module-load baseline: the first call can diff against it instead of sleeping. */
let cpuBaseline = snapshotCpu();

async function sampleCpuPercent() {
  const previous = cpuBaseline;
  let current = snapshotCpu();
  const windowMs = current.at - previous.at;
  if (current.total - previous.total <= 0 || windowMs < CPU_MIN_WINDOW_MS) {
    // Short, non-blocking wait (timers/promises) - never a blocking sleep.
    await delay(CPU_MIN_WINDOW_MS);
    current = snapshotCpu();
  }
  cpuBaseline = current;
  const deltaTotal = current.total - previous.total;
  const deltaIdle = current.idle - previous.idle;
  if (!(deltaTotal > 0)) return 0;
  return clampPercent(((deltaTotal - deltaIdle) / deltaTotal) * 100);
}

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || /^\[?n\/a\]?$/i.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

async function readWindowsDisks() {
  const shell = await powershellCommand();
  const result = await runCommand(
    shell,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', POWERSHELL_DISK_SCRIPT],
    TIMEOUT_MS.powershell,
  );
  if (!result.ok || !result.stdout.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const disks = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const total = toNumber(row.Size);
    const free = toNumber(row.FreeSpace);
    const mount = typeof row.DeviceID === 'string' ? row.DeviceID : null;
    if (!mount || total === null || free === null || total <= 0) continue;
    const used = Math.max(0, total - free);
    disks.push({ mount, total, free, used });
  }
  return disks;
}

async function readPosixDisks() {
  const result = await runCommand('df', ['-P', '-k'], TIMEOUT_MS.df);
  if (!result.ok) return [];
  const disks = [];
  const lines = result.stdout.split(/\r?\n/);
  for (const line of lines) {
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 6) continue;
    if (!/^\d+$/.test(tokens[1])) continue; // header or wrapped line
    const total = Number(tokens[1]) * 1024;
    const free = Number(tokens[3]) * 1024;
    if (!Number.isFinite(total) || !Number.isFinite(free) || total <= 0) continue;
    const mount = tokens.slice(5).join(' ');
    disks.push({ mount, total, free, used: Math.max(0, total - free) });
  }
  return disks;
}

const disksCache = createTtlCache(CACHE_MS.disks, (snapshot) =>
  snapshot.ok ? CACHE_MS.disks : CACHE_MS.disksFailure,
);

async function readDisks() {
  try {
    const snapshot = await disksCache(async () => {
      try {
        const disks = IS_WIN ? await readWindowsDisks() : await readPosixDisks();
        return { ok: disks.length > 0, disks };
      } catch {
        return { ok: false, disks: [] };
      }
    });
    return snapshot.disks.map((disk) => ({ ...disk }));
  } catch {
    return [];
  }
}

async function readGpusUncached() {
  const binary = await resolveCommand('nvidia-smi');
  if (!binary) return [];
  const result = await runCommand(
    binary,
    [
      '--query-gpu=name,uuid,utilization.gpu,memory.used,memory.total,temperature.gpu',
      '--format=csv,noheader,nounits',
    ],
    TIMEOUT_MS.nvidiaSmi,
  );
  // Missing driver / no GPU / NVML init failure: report nothing instead of fake values.
  if (!result.ok || !result.stdout.trim()) return [];
  const gpus = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split(',').map((part) => part.trim());
    if (parts.length < 6) continue;
    const tail = parts.slice(-5);
    const name = parts.slice(0, -5).join(',').trim();
    if (!name) continue;
    gpus.push({
      name,
      uuid: tail[0] || null,
      utilization: toNumber(tail[1]),
      memoryUsed: toNumber(tail[2]),
      memoryTotal: toNumber(tail[3]),
      temperature: toNumber(tail[4]),
    });
  }
  return gpus;
}

const gpusCache = createTtlCache(CACHE_MS.gpus, (snapshot) =>
  snapshot.ok ? CACHE_MS.gpus : CACHE_MS.gpusFailure,
);

async function readGpus() {
  try {
    const snapshot = await gpusCache(async () => {
      try {
        const gpus = await readGpusUncached();
        return { ok: gpus.length > 0, gpus };
      } catch {
        return { ok: false, gpus: [] };
      }
    });
    return snapshot.gpus.map((gpu) => ({ ...gpu }));
  } catch {
    return [];
  }
}

/**
 * Collect real host metrics.
 * Hardware probes (disks / GPUs) degrade to `[]` when they cannot be read;
 * base collection (CPU, memory, uptime, identity) always succeeds.
 */
export async function collectHostMetrics() {
  const cpus = os.cpus();
  const cpuModel = cpus.length > 0 && cpus[0].model ? String(cpus[0].model).trim() : 'unknown';
  const total = os.totalmem();
  const free = os.freemem();
  const used = Math.max(0, total - free);

  const [cpuPercent, disks, gpus] = await Promise.all([sampleCpuPercent(), readDisks(), readGpus()]);

  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    cpuModel,
    cpuPercent,
    memory: {
      total,
      used,
      free,
      percent: clampPercent(total > 0 ? (used / total) * 100 : 0),
    },
    uptime: round1(os.uptime()),
    disks: disks.map((disk) => ({ ...disk })),
    gpus,
  };
}

/* ------------------------------------------------------------------ */
/* connection status                                                  */
/* ------------------------------------------------------------------ */

async function readTailscaleStatus(binary) {
  const empty = { installed: true, online: false, ip: null, hostname: null, backendState: null };
  const result = await runCommand(binary, ['status', '--json'], TIMEOUT_MS.tailscale);
  if (!result.ok || !result.stdout.trim()) return empty;
  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    return empty;
  }
  if (!data || typeof data !== 'object') return empty;
  const backendState = typeof data.BackendState === 'string' && data.BackendState ? data.BackendState : null;
  const self = data.Self && typeof data.Self === 'object' ? data.Self : {};
  const addresses = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs.filter((ip) => typeof ip === 'string') : [];
  const ip = addresses.find((entry) => entry.includes('.')) || addresses[0] || null;
  const hostname =
    (typeof self.HostName === 'string' && self.HostName) ||
    (typeof self.DNSName === 'string' && self.DNSName ? self.DNSName.replace(/\.$/, '') : null);
  const selfOnline = typeof self.Online === 'boolean' ? self.Online : true;
  return {
    installed: true,
    online: backendState === 'Running' && selfOnline,
    ip,
    hostname,
    backendState,
  };
}

/**
 * Only these fields are surfaced; no peers, keys, tokens, environment variables
 * or full CLI login output ever leave this function.
 */
async function loadConnectionStatus() {
  const [tailscaleBin, dockerBin] = await Promise.all([
    resolveCommand('tailscale'),
    resolveCommand('docker'),
  ]);

  let tailscale = { installed: false, online: false, ip: null, hostname: null, backendState: null };
  if (tailscaleBin) {
    try {
      tailscale = await readTailscaleStatus(tailscaleBin);
    } catch {
      tailscale = { installed: true, online: false, ip: null, hostname: null, backendState: null };
    }
  }

  return {
    tailscale,
    agents: [],
    docker: { installed: Boolean(dockerBin) },
  };
}

const connectionCache = createTtlCache(CACHE_MS.connection);

/** Probe local tooling. Cached (10s) so frequent UI polling never re-spawns CLI processes. */
export async function connectionStatus() {
  const value = await connectionCache(loadConnectionStatus);
  return structuredClone(value);
}

/* ------------------------------------------------------------------ */
/* sandboxed file access                                              */
/* ------------------------------------------------------------------ */

async function resolveRoot(root) {
  if (typeof root !== 'string' || root.trim().length === 0) {
    throw fail(400, 'INVALID_ROOT', 'root must be a non-empty absolute path string');
  }
  if (root.includes('\0')) throw fail(400, 'INVALID_ROOT', 'root must not contain NUL bytes');
  if (!path.isAbsolute(root)) throw fail(400, 'INVALID_ROOT', 'root must be an absolute path');
  let realRoot;
  try {
    realRoot = await fs.realpath(root);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw fail(404, 'ROOT_NOT_FOUND', 'root does not exist');
    }
    throw mapFsError(error, 'root');
  }
  let stat;
  try {
    stat = await fs.stat(realRoot);
  } catch (error) {
    throw mapFsError(error, 'root');
  }
  if (!stat.isDirectory()) throw fail(400, 'ROOT_NOT_DIRECTORY', 'root must be a directory');
  return realRoot;
}

/** Normalise a client-supplied relative path into safe segments (POSIX and Windows input). */
function normalizeRelative(relative) {
  if (relative === undefined || relative === null) relative = '';
  if (typeof relative !== 'string') throw fail(400, 'INVALID_PATH', 'relative path must be a string');
  if (relative.includes('\0')) throw fail(400, 'INVALID_PATH', 'relative path must not contain NUL bytes');
  const slashed = relative.replace(/\\/g, '/');
  if (slashed.startsWith('/')) {
    throw fail(400, 'INVALID_PATH', 'absolute paths are not allowed; pass a path relative to the root');
  }
  if (/^[A-Za-z]:/.test(slashed)) {
    throw fail(400, 'INVALID_PATH', 'absolute paths are not allowed; pass a path relative to the root');
  }
  const segments = [];
  for (const segment of slashed.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') throw fail(400, 'PATH_TRAVERSAL', 'path traversal ("..") is not allowed');
    segments.push(segment);
  }
  if (segments.length > LIMITS.maxPathDepth) {
    throw fail(400, 'PATH_TOO_DEEP', `relative path exceeds ${LIMITS.maxPathDepth} segments`);
  }
  return segments;
}

function isInside(realRoot, candidate) {
  const relative = path.relative(realRoot, candidate);
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

function joinInside(realRoot, segments) {
  const target = segments.length === 0 ? realRoot : path.join(realRoot, ...segments);
  if (!isInside(realRoot, target)) {
    throw fail(400, 'PATH_OUTSIDE_ROOT', 'resolved path escapes the registered root');
  }
  return target;
}

/**
 * Resolve symlinks/junctions for the target (or its nearest existing ancestor) and
 * make sure the real location is still inside the root.
 */
async function assertNoEscape(realRoot, target) {
  let probe = target;
  for (let depth = 0; depth <= LIMITS.maxPathDepth + 1; depth += 1) {
    try {
      const real = await fs.realpath(probe);
      if (!isInside(realRoot, real)) {
        throw fail(403, 'PATH_ESCAPE', 'path resolves outside the registered root (symlink escape blocked)');
      }
      return { exists: probe === target, real };
    } catch (error) {
      if (isAbort(error)) throw error;
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw mapFsError(error, 'path check');
      const parent = path.dirname(probe);
      if (parent === probe) throw fail(400, 'PATH_UNRESOLVABLE', 'path cannot be resolved');
      probe = parent;
    }
  }
  throw fail(400, 'PATH_UNRESOLVABLE', 'path cannot be resolved');
}

async function resolveTarget(root, relative) {
  const realRoot = await resolveRoot(root);
  const segments = normalizeRelative(relative);
  const target = joinInside(realRoot, segments);
  const { exists } = await assertNoEscape(realRoot, target);
  return { realRoot, segments, target, exists, relPath: segments.join('/') };
}

async function statOrNull(target) {
  try {
    return await fs.stat(target);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    if (error?.code === 'EACCES' || error?.code === 'EPERM') throw fail(403, 'PERMISSION_DENIED', 'permission denied');
    return null;
  }
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function compareEntries(a, b) {
  const aDir = a.isDirectory() ? 0 : 1;
  const bDir = b.isDirectory() ? 0 : 1;
  if (aDir !== bDir) return aDir - bDir;
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

function pageOptions(options) {
  const raw = options && typeof options === 'object' ? options : {};
  const limitRaw = Number(raw.limit ?? LIMITS.defaultPageSize);
  const offsetRaw = Number(raw.offset ?? 0);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(LIMITS.maxPageSize, Math.max(1, Math.trunc(limitRaw)))
    : LIMITS.defaultPageSize;
  const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.trunc(offsetRaw)) : 0;
  return { limit, offset };
}

/**
 * List a directory inside `root`.
 * Directories come first, then files, both sorted by name.
 * Only the requested page is stat()ed, so huge folders never block.
 * Entries whose symlink target escapes the root are omitted.
 *
 * @returns {{path: string, entries: Array<{name: string, path: string, type: 'directory'|'file', size: number, modifiedAt: string}>, total: number}}
 */
export async function listFiles(root, relative = '', options = {}) {
  const { realRoot, target, relPath } = await resolveTarget(root, relative);
  const { limit, offset } = pageOptions(options);

  let dirents;
  try {
    const stat = await fs.stat(target);
    if (!stat.isDirectory()) throw fail(400, 'NOT_A_DIRECTORY', 'listFiles: path is not a directory');
    dirents = await fs.readdir(target, { withFileTypes: true });
  } catch (error) {
    throw mapFsError(error, 'listFiles');
  }

  const sorted = dirents.slice().sort(compareEntries);
  const page = sorted.slice(offset, offset + limit);
  const built = await mapLimit(page, 8, async (dirent) => {
    const entryTarget = path.join(target, dirent.name);
    const entryPath = relPath ? `${relPath}/${dirent.name}` : dirent.name;
    try {
      let stat;
      if (dirent.isSymbolicLink()) {
        const real = await fs.realpath(entryTarget);
        // A link pointing outside the root is not disclosed at all.
        if (!isInside(realRoot, real)) return null;
        stat = await fs.stat(real);
      } else {
        stat = await fs.lstat(entryTarget);
      }
      const type = stat.isDirectory() ? 'directory' : 'file';
      return {
        name: dirent.name,
        path: entryPath,
        type,
        size: type === 'directory' ? 0 : stat.size,
        modifiedAt: stat.mtime.toISOString(),
      };
    } catch {
      // Entry vanished or is unreadable: skip it instead of failing the whole listing.
      return null;
    }
  });

  return {
    path: relPath,
    entries: built.filter((entry) => entry !== null),
    total: sorted.length,
  };
}

/**
 * Read a UTF-8 text file (max 2 MB).
 * @returns {{path: string, content: string, version: string, size: number}}
 */
export async function readText(root, relative) {
  const { target, relPath } = await resolveTarget(root, relative);
  let stat;
  try {
    stat = await fs.stat(target);
  } catch (error) {
    throw mapFsError(error, 'readText');
  }
  if (stat.isDirectory()) throw fail(400, 'E_IS_DIRECTORY', 'readText: path is a directory');
  if (!stat.isFile()) throw fail(400, 'NOT_A_FILE', 'readText: path is not a regular file');
  if (stat.size > LIMITS.maxTextBytes) {
    throw fail(413, 'TEXT_TOO_LARGE', `readText: file is ${stat.size} bytes, limit is ${LIMITS.maxTextBytes} bytes`);
  }
  let buffer;
  try {
    buffer = await fs.readFile(target);
  } catch (error) {
    throw mapFsError(error, 'readText');
  }
  if (buffer.length > LIMITS.maxTextBytes) {
    throw fail(413, 'TEXT_TOO_LARGE', `readText: file grew beyond the ${LIMITS.maxTextBytes} byte limit`);
  }
  if (buffer.includes(0)) {
    throw fail(415, 'NOT_TEXT', 'readText: file contains NUL bytes (binary file)');
  }
  return {
    path: relPath,
    content: buffer.toString('utf8'),
    version: sha256(buffer),
    size: buffer.length,
  };
}

/**
 * Write a UTF-8 text file (max 2 MB) inside the root.
 * When `expectedVersion` is given the write is optimistic: a changed or deleted
 * file raises an error with `status: 409`.
 * @returns {{path: string, version: string, size: number}}
 */
export async function writeText(root, relative, content, expectedVersion) {
  if (typeof content !== 'string') throw fail(400, 'INVALID_CONTENT', 'writeText: content must be a string');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > LIMITS.maxTextBytes) {
    throw fail(413, 'TEXT_TOO_LARGE', `writeText: content is ${bytes} bytes, limit is ${LIMITS.maxTextBytes} bytes`);
  }
  const { target, segments, relPath, exists } = await resolveTarget(root, relative);
  if (segments.length === 0) throw fail(400, 'INVALID_PATH', 'writeText: a file path inside the root is required');

  const parent = path.dirname(target);
  const parentStat = await statOrNull(parent);
  if (!parentStat) throw fail(404, 'PARENT_NOT_FOUND', 'writeText: parent directory does not exist');
  if (!parentStat.isDirectory()) throw fail(400, 'PARENT_NOT_A_DIRECTORY', 'writeText: parent path is not a directory');

  if (exists) {
    const existing = await statOrNull(target);
    if (existing?.isDirectory()) throw fail(400, 'E_IS_DIRECTORY', 'writeText: path is a directory');
  }

  if (expectedVersion !== undefined && expectedVersion !== null) {
    let current = null;
    if (exists) {
      try {
        const stat = await fs.stat(target);
        if (stat.size > LIMITS.maxTextBytes) {
          throw fail(409, 'VERSION_CONFLICT', 'writeText: file changed on disk (now too large to verify); reload before saving');
        }
        current = sha256(await fs.readFile(target));
      } catch (error) {
        if (isAbort(error)) throw error;
        throw mapFsError(error, 'writeText');
      }
    }
    if (current === null) {
      throw fail(409, 'VERSION_CONFLICT', 'writeText: file no longer exists; reload before saving');
    }
    if (current !== String(expectedVersion)) {
      throw fail(409, 'VERSION_CONFLICT', 'writeText: file changed on disk since it was loaded; reload before saving');
    }
  }

  try {
    await fs.writeFile(target, content, { encoding: 'utf8' });
  } catch (error) {
    throw mapFsError(error, 'writeText');
  }
  const stat = await statOrNull(target);
  return { path: relPath, version: sha256(Buffer.from(content, 'utf8')), size: stat ? stat.size : bytes };
}

/**
 * Create a directory inside the root (intermediate directories are created too).
 * @returns {{path: string}}
 */
export async function makeDirectory(root, relative) {
  const { target, segments, relPath } = await resolveTarget(root, relative);
  if (segments.length === 0) throw fail(400, 'INVALID_PATH', 'makeDirectory: a directory path is required');
  const existing = await statOrNull(target);
  if (existing) {
    if (existing.isDirectory()) return { path: relPath };
    throw fail(409, 'ALREADY_EXISTS_AS_FILE', 'makeDirectory: a file already exists at that path');
  }
  try {
    await fs.mkdir(target, { recursive: true });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const stat = await statOrNull(target);
      if (stat?.isDirectory()) return { path: relPath };
      throw fail(409, 'ALREADY_EXISTS_AS_FILE', 'makeDirectory: a file already exists at that path');
    }
    if (error?.code === 'ENOTDIR') {
      throw fail(409, 'ALREADY_EXISTS_AS_FILE', 'makeDirectory: a file already exists in the path');
    }
    throw mapFsError(error, 'makeDirectory');
  }
  return { path: relPath };
}

/**
 * Describe a regular file and return its verified real absolute path.
 * The returned `absolutePath` is already resolved (realpath) and guaranteed to be
 * inside the registered root, so it can be handed to fs.createReadStream for downloads.
 *
 * @returns {{path: string, absolutePath: string, name: string, type: 'file', size: number, modifiedAt: string}}
 */
export async function fileInfo(root, relative) {
  const { realRoot, target, relPath } = await resolveTarget(root, relative);
  let real;
  try {
    real = await fs.realpath(target);
  } catch (error) {
    throw mapFsError(error, 'fileInfo');
  }
  if (!isInside(realRoot, real)) {
    throw fail(403, 'PATH_ESCAPE', 'fileInfo: path resolves outside the registered root');
  }
  const stat = await statOrNull(real);
  if (!stat) throw fail(404, 'NOT_FOUND', 'fileInfo: path does not exist');
  if (stat.isDirectory()) throw fail(400, 'E_IS_DIRECTORY', 'fileInfo: path is a directory');
  if (!stat.isFile()) throw fail(400, 'NOT_A_FILE', 'fileInfo: path is not a regular file');
  return {
    path: relPath,
    absolutePath: real,
    name: path.basename(relative ? relPath : real),
    type: 'file',
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };
}
