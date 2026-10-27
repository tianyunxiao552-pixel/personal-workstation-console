/**
 * harness.mjs — isolated acceptance harness for the workstation console backend snapshot.
 *
 * Everything here operates ONLY inside work/backend-acceptance:
 *   - DATA  : <here>/data-test          (CONSOLE_DATA for the spawned server)
 *   - tmp   : <here>/tmp                (server logs, pid bookkeeping)
 *   - results: <here>/results           (captured evidence)
 *
 * Process discipline: every process this harness starts is recorded by PID and
 * verified with tasklist before/after termination. Nothing else is touched.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';

export const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DATA_TEST = path.join(HERE, 'data-test');
export const TMP = path.join(HERE, 'tmp');
export const RESULTS = path.join(HERE, 'results');
export const PORT = 18787;
export const RUNNER_PORT = 18785;
export const BASE = `http://127.0.0.1:${PORT}`;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeout = 20000, interval = 100, label = 'condition' } = {}) {
  const started = Date.now();
  let lastError = null;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() - started > timeout) {
      throw new Error(`timeout waiting for ${label}${lastError ? ` (last error: ${lastError.message})` : ''}`);
    }
    await sleep(interval);
  }
}

/* ---------------- process helpers ---------------- */

export function pidAlive(pid) {
  if (!pid) return false;
  const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8' });
  return new RegExp(`"${pid}"`).test(out);
}

export function killPid(pid, { tree = false } = {}) {
  if (!pid) return;
  const args = ['/PID', String(pid), '/F'];
  if (tree) args.push('/T');
  try {
    execFileSync('taskkill', args, { stdio: 'ignore' });
  } catch {
    /* already gone */
  }
}

/* ---------------- raw HTTP client with cookie jar ---------------- */

/**
 * Minimal HTTP client (node:http) so we can control the Host header, the Origin
 * header and cookies exactly — fetch() forbids Host/Origin manipulation and
 * hides Set-Cookie on some paths.
 */
export function request(pathname, { method = 'GET', headers = {}, body = null, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8');
    // Node's HTTP/1.1 server rejects requests without Host (bare "400 Bad Request").
    const finalHeaders = { host: `127.0.0.1:${PORT}`, ...headers };
    if (payload && !finalHeaders['content-type']) finalHeaders['content-type'] = 'application/json';
    if (payload && !finalHeaders['content-length']) finalHeaders['content-length'] = String(payload.length);
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: pathname, method, headers: finalHeaders, setHost: false },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const text = buffer.toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, buffer, text, json });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('request timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

export class ApiClient {
  constructor({ host = `127.0.0.1:${PORT}`, origin = `http://127.0.0.1:${PORT}`, cookie = null, sendOrigin = true } = {}) {
    this.host = host;
    this.origin = origin;
    this.cookie = cookie;
    this.sendOrigin = sendOrigin;
    this.calls = [];
  }

  async call(pathname, { method = 'GET', body = null, headers = {}, withCookie = true, withOrigin } = {}) {
    const finalHeaders = { host: this.host, ...headers };
    const useOrigin = withOrigin === undefined ? this.sendOrigin && method !== 'GET' : withOrigin;
    if (useOrigin && !('origin' in finalHeaders)) finalHeaders.origin = this.origin;
    if (withCookie && this.cookie) finalHeaders.cookie = this.cookie;
    const res = await request(pathname, { method, headers: finalHeaders, body });
    const setCookie = res.headers['set-cookie'];
    if (setCookie?.length) {
      const raw = setCookie[0].split(';')[0];
      this.cookie = raw;
      this.lastSetCookie = setCookie[0];
    }
    this.calls.push({ method, pathname, status: res.status });
    return res;
  }

  get(p, opts) {
    return this.call(p, { ...opts, method: 'GET' });
  }
  post(p, body, opts) {
    return this.call(p, { ...opts, method: 'POST', body });
  }
  put(p, body, opts) {
    return this.call(p, { ...opts, method: 'PUT', body });
  }
  patch(p, body, opts) {
    return this.call(p, { ...opts, method: 'PATCH', body });
  }
}

/* ---------------- sqlite (read-only inspection of the isolated test db) ---------------- */

export function readSettings() {
  const file = path.join(DATA_TEST, 'console.sqlite');
  const db = new DatabaseSync(file);
  try {
    const row = db.prepare("SELECT value FROM records WHERE collection='settings' AND id='main'").get();
    return JSON.parse(row.value);
  } finally {
    db.close();
  }
}

/* ---------------- server lifecycle ---------------- */

export class ServerController {
  constructor() {
    this.child = null;
    this.serverPid = null;
    this.runnerPid = null;
    this.starts = [];
  }

  async resetData() {
    await fsp.rm(DATA_TEST, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await fsp.mkdir(DATA_TEST, { recursive: true });
    await fsp.mkdir(TMP, { recursive: true });
    await fsp.mkdir(RESULTS, { recursive: true });
  }

  /** Refuse to start when something outside this harness already owns the ports. */
  async preflight() {
    const serverBusy = await waitFor(async () => !(await this.portBusy(PORT)), {
      timeout: 8000,
      interval: 150,
      label: `端口 ${PORT} 释放`,
    }).then(() => false).catch(() => true);
    if (serverBusy) throw new Error(`端口 ${PORT} 已被占用，请先释放，避免连接到非本次测试启动的进程`);

    // RUNNER_PORT may legitimately still be served by the runner this harness started
    // earlier (that is exactly what the coordinator-restart test verifies).
    if (await this.portBusy(RUNNER_PORT)) {
      const pid = await this.healthPid().catch(() => null);
      if (!pid || pid !== this.runnerPid) {
        throw new Error(`端口 ${RUNNER_PORT} 被非本次测试的进程占用 (pid=${pid})`);
      }
    }
  }

  async healthPid() {
    const token = readSettings().workerToken;
    const res = await fetch(`http://127.0.0.1:${RUNNER_PORT}/health`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return (await res.json()).pid;
  }

  async portBusy(port) {
    return new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.setTimeout(500);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      socket.once('error', () => resolve(false));
    });
  }

  async start({ fresh = false } = {}) {
    await this.preflight();
    if (fresh) await this.resetData();
    const logFile = path.join(TMP, 'server.log');
    const fd = fs.openSync(logFile, 'a');
    fs.writeSync(fd, `\n===== start ${new Date().toISOString()} =====\n`);
    const env = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      SystemDrive: process.env.SystemDrive,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      PATHEXT: process.env.PATHEXT,
      USERPROFILE: process.env.USERPROFILE,
      APPDATA: process.env.APPDATA,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      COMSPEC: process.env.COMSPEC,
      NUMBER_OF_PROCESSORS: process.env.NUMBER_OF_PROCESSORS,
      PORT: String(PORT),
      RUNNER_PORT: String(RUNNER_PORT),
      CONSOLE_DATA: DATA_TEST,
      ...(this.extraEnv || {}),
    };
    // Never set DEV: the fixture dist/client/index.html must be served statically.
    const entry = process.env.ACCEPT_SERVER_ENTRY || 'server/index.mjs';
    const child = spawn(process.execPath, [entry], {
      cwd: HERE,
      env,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    });
    fs.closeSync(fd);
    this.child = child;
    this.serverPid = child.pid;
    this.starts.push({ at: new Date().toISOString(), pid: child.pid });
    child.once('exit', () => {
      if (this.serverPid === child.pid) this.serverPid = null;
    });
    await waitFor(
      async () => {
        const res = await request('/api/session', { headers: { host: `127.0.0.1:${PORT}` } });
        return res.status === 200;
      },
      { timeout: 40000, label: 'server /api/session' },
    );
    await this.discoverRunnerPid();
    return this;
  }

  /** The runner is a detached background process seeded by server/index.mjs. */
  async discoverRunnerPid() {
    const token = readSettings().workerToken;
    const res = await fetch(`http://127.0.0.1:${RUNNER_PORT}/health`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json();
    this.runnerPid = body.pid;
    return this.runnerPid;
  }

  /** Stop ONLY the coordinator (server/index.mjs). Never /T: the runner must survive. */
  async stopServerOnly() {
    const pid = this.serverPid;
    killPid(pid, { tree: false });
    await waitFor(() => !pidAlive(pid), { timeout: 15000, label: `server pid ${pid} exit` });
    this.serverPid = null;
    return pid;
  }

  async stopAll() {
    const report = { server: null, runner: null, leftovers: [] };
    if (this.serverPid) {
      const pid = this.serverPid;
      killPid(pid, { tree: false });
      await waitFor(() => !pidAlive(pid), { timeout: 15000, label: `server pid ${pid} exit` }).catch(() => {});
      report.server = { pid, aliveAfter: pidAlive(pid) };
      this.serverPid = null;
    }
    if (this.runnerPid) {
      const pid = this.runnerPid;
      killPid(pid, { tree: true });
      await waitFor(() => !pidAlive(pid), { timeout: 15000, label: `runner pid ${pid} exit` }).catch(() => {});
      report.runner = { pid, aliveAfter: pidAlive(pid) };
      this.runnerPid = null;
    }
    return report;
  }
}

/* ---------------- websocket helpers ---------------- */

export function openSocket(pathname, { cookie = null, origin = `http://127.0.0.1:${PORT}` } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (origin) headers.Origin = origin;
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}${pathname}`, { headers });
  const frames = [];
  const state = { ws, frames, closed: null, opened: false, error: null };
  ws.on('open', () => {
    state.opened = true;
  });
  ws.on('message', (data) => frames.push({ at: Date.now(), text: data.toString() }));
  ws.on('close', (code, reason) => {
    state.closed = { code, reason: reason?.toString?.() ?? '' };
  });
  ws.on('error', (err) => {
    state.error = err.message;
  });
  state.waitText = (needle, timeout = 20000) =>
    waitFor(() => frames.some((f) => f.text.includes(needle)), { timeout, interval: 80, label: `ws text ${needle}` });
  state.send = (obj) => {
    if (ws.readyState === 1) ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
  };
  state.close = () =>
    new Promise((resolve) => {
      if (ws.readyState === 3) return resolve();
      ws.once('close', () => resolve());
      ws.close();
      setTimeout(resolve, 4000);
    });
  return state;
}

/* ---------------- misc ---------------- */

export function shellJson(value) {
  return JSON.stringify(value);
}

export async function writeEvidence(name, data) {
  await fsp.mkdir(RESULTS, { recursive: true });
  await fsp.writeFile(path.join(RESULTS, name), typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}
