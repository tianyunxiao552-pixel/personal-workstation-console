/**
 * 真实 API 集成验收 —— 隔离快照 (work/backend-acceptance)
 *
 * 目标：以真实 HTTP/WS/进程/文件系统行为，找出阻断“安卓浏览器远程监测控制 Windows”的核心问题。
 * 规则：
 *  - 只在 data-test/ 内产生数据；server/ 快照不做任何修改（本文件不 import 快照，只通过 API 观察）。
 *  - 只终止本测试启动并记录过 PID 的进程。
 *  - 不发起付费 agent 调用（Agent 相关只做“未安装/已安装”探测，不执行 codex/claude）。
 *  - 无法在本机验证的外部依赖（真实手机、Tailscale 登录、SMTP 账号）明确标记为 external。
 *
 * 运行: node --test tests/api-acceptance.test.mjs
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  ApiClient,
  DATA_TEST,
  PORT,
  RESULTS,
  RUNNER_PORT,
  ServerController,
  TMP,
  openSocket,
  pidAlive,
  readSettings,
  request,
  sleep,
  waitFor,
  writeEvidence,
} from './helpers/backend-harness.mjs';

const ctl = new ServerController();
const TAG = process.env.ACCEPT_REPORT_TAG ? `-${process.env.ACCEPT_REPORT_TAG}` : '';
const report = {
  target: '个人 Windows 工作站控制台 · 真实 API 集成验收',
  serverEntry: process.env.ACCEPT_SERVER_ENTRY || 'server/index.mjs',
  startedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: process.platform,
    port: PORT,
    runnerPort: RUNNER_PORT,
    consoleData: DATA_TEST,
  },
  steps: [],
  runs: [],
  findings: [],
  external: [],
  gaps: [],
};
const step = (name, data) => {
  report.steps.push({ name, at: new Date().toISOString(), data });
  return data;
};
const finding = (id, severity, title, evidence, fix) => {
  report.findings.push({ id, severity, title, evidence, fix });
};
const gap = (id, title, evidence) => {
  report.gaps.push({ id, title, evidence });
};
const external = (id, title, note) => {
  report.external.push({ id, title, note });
};

let local; // 桌面端客户端（127.0.0.1 + 本机 cookie）
let remote; // 模拟 tailscale serve 转发（Host/Origin = *.ts.net），非真实手机
let projectId;
let projectDir;
let pairingCode;
let workerToken;

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

async function state(client = local) {
  const res = await client.get('/api/state');
  assert.equal(res.status, 200, `GET /api/state -> ${res.status} ${res.text}`);
  return res.json;
}

async function findRun(id, client = local) {
  return (await state(client)).runs.find((r) => r.id === id) ?? null;
}

async function waitRun(id, statuses, { timeout = 120000, client = local, label } = {}) {
  return waitFor(
    async () => {
      const run = await findRun(id, client);
      if (!run) return null;
      return statuses.includes(run.status) ? run : null;
    },
    { timeout, interval: 150, label: label || `run ${id} -> ${statuses.join('|')}` },
  );
}

function newRunId(before, afterState) {
  const ids = new Set(before.runs.map((r) => r.id));
  return afterState.runs.find((r) => !ids.has(r.id));
}

/* ------------------------------------------------------------------ */
/* 00 启动                                                             */
/* ------------------------------------------------------------------ */

test('00 启动隔离测试服务（PORT=18787 / RUNNER_PORT=18785 / CONSOLE_DATA=data-test，未设置 DEV）', async () => {
  await ctl.start({ fresh: true });
  assert.ok(ctl.serverPid, 'server pid');
  assert.ok(ctl.runnerPid, 'runner pid');
  assert.ok(pidAlive(ctl.serverPid), 'server 进程存活');
  assert.ok(pidAlive(ctl.runnerPid), 'runner 进程存活');
  assert.notEqual(ctl.serverPid, ctl.runnerPid, 'runner 是独立后台进程');

  const settings = readSettings();
  pairingCode = settings.pairingCode;
  workerToken = settings.workerToken;

  // 静态夹具（非 DEV 模式）
  const fixture = await request('/');
  assert.equal(fixture.status, 200);
  assert.match(fixture.text, /个人工作站/);

  step('00-start', {
    serverPid: ctl.serverPid,
    runnerPid: ctl.runnerPid,
    dev: false,
    staticFixture: fixture.status,
    dataDir: DATA_TEST,
    ports: { [PORT]: 'server', [RUNNER_PORT]: 'runner' },
  });
});

/* ------------------------------------------------------------------ */
/* 01 会话 / 授权 / 跨源                                               */
/* ------------------------------------------------------------------ */

test('01 local /api/session 建立 cookie 后真实 API 可用；无 cookie 与跨源请求被拒绝', async () => {
  local = new ApiClient();

  // 1) 本机 GET /api/session 自动下发会话 cookie
  const session = await local.call('/api/session');
  assert.equal(session.status, 200);
  assert.equal(session.json.authenticated, true);
  assert.equal(session.json.local, true);
  const setCookie = session.headers['set-cookie']?.[0];
  assert.ok(setCookie, '应下发 Set-Cookie');
  assert.match(setCookie, /console_session=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.ok(local.cookie, 'cookie 已记录');

  // 2) 带 cookie 的真实 API 调用
  const st = await local.get('/api/state');
  assert.equal(st.status, 200);
  assert.ok(Array.isArray(st.json.projects) && st.json.projects.length >= 1, '默认工作区项目存在');
  assert.equal(st.json.projects[0].id, 'workspace');

  // 3) 无 cookie -> 401
  const anon = await request('/api/state');
  assert.equal(anon.status, 401);
  assert.match(anon.json.error, /配对码/);

  // 4) 跨源 POST（Origin 与 Host 不一致）-> 403，且不产生副作用
  const beforeProjects = (await state()).projects.length;
  const crossOrigin = await request('/api/projects', {
    method: 'POST',
    headers: { origin: 'http://evil.example', cookie: local.cookie },
    body: { name: '跨源注入' },
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal((await state()).projects.length, beforeProjects, '跨源请求未创建项目');

  // 5) 同源但没有 cookie -> 401（Origin 合法不等于已授权）
  const noCookieSameOrigin = await request('/api/projects', {
    method: 'POST',
    headers: { origin: `http://127.0.0.1:${PORT}` },
    body: { name: '无凭据' },
  });
  assert.equal(noCookieSameOrigin.status, 401);

  // 6) GET 的 Origin 不校验（只对非 GET 校验）：记录为现状
  const getWithForeignOrigin = await request('/api/state', {
    headers: { origin: 'http://evil.example', cookie: local.cookie },
  });
  assert.equal(getWithForeignOrigin.status, 200, 'GET 不校验 Origin（无 CORS 头，浏览器读不到响应体）');
  assert.equal(getWithForeignOrigin.headers['access-control-allow-origin'], undefined);

  step('01-local-session', {
    setCookie,
    stateProjects: st.json.projects.map((p) => ({ id: p.id, name: p.name, directory: p.directory })),
    noCookieStatus: anon.status,
    crossOriginPostStatus: crossOrigin.status,
    sameOriginNoCookieStatus: noCookieSameOrigin.status,
    getWithForeignOriginStatus: getWithForeignOrigin.status,
  });
});

test('02 远程式入口（模拟 tailscale serve 的 *.ts.net Host/Origin）需要配对码；配对后 cookie 生效', async () => {
  remote = new ApiClient({ host: 'pc.tailnet.ts.net', origin: 'https://pc.tailnet.ts.net' });

  // 远程 Host 下不会被当作 local
  const session = await remote.call('/api/session');
  assert.equal(session.status, 200);
  assert.equal(session.json.local, false, '非本机 Host 不得被识别为 local');
  assert.equal(session.json.authenticated, false);
  assert.equal(session.headers['set-cookie'], undefined, '远程未认证不得直接下发 cookie');
  assert.equal(remote.cookie, null);

  const denied = await remote.get('/api/state');
  assert.equal(denied.status, 401);

  // 错误配对码
  const wrong = await remote.post('/api/login', { code: 'wrong-code-xxxxxxxx' });
  assert.equal(wrong.status, 401);

  // 跨源尝试配对 -> 403
  const evil = new ApiClient({ host: 'pc.tailnet.ts.net', origin: 'http://evil.example' });
  const evilLogin = await evil.post('/api/login', { code: pairingCode });
  assert.equal(evilLogin.status, 403, '配对接口受同源校验保护');

  // 正确配对码
  const ok = await remote.post('/api/login', { code: pairingCode });
  assert.equal(ok.status, 200);
  assert.ok(remote.cookie, '配对成功后应下发 cookie');

  const stBefore = await remote.get('/api/state');
  assert.equal(stBefore.status, 200, '配对后的远程客户端可读取真实状态');

  // 远程客户端不允许看到配对码本身
  const settings = await remote.get('/api/settings');
  assert.equal(settings.status, 200);
  assert.equal(settings.json.pairingCode, undefined, '非本机不返回配对码');

  const localSettings = await local.get('/api/settings');
  assert.ok(localSettings.json.pairingCode, '本机可见配对码');

  step('02-remote-entry', {
    note: 'Host/Origin 伪装 *.ts.net 模拟 tailscale serve 转发，不是真实手机',
    sessionLocal: session.json.local,
    sessionAuthenticated: session.json.authenticated,
    wrongPairing: wrong.status,
    crossOriginPairing: evilLogin.status,
    pairing: ok.status,
    stateAfterPairing: stBefore.status,
    pairingCodeHiddenRemotely: settings.json.pairingCode === undefined,
  });

  external(
    'E1',
    '安卓浏览器 / Tailscale 真实连通性',
    '本项仅模拟 Host/Origin；真实安卓设备尚未接入验收。',
  );
});

/* ------------------------------------------------------------------ */
/* 03 项目与真实文件读写 / 版本冲突                                     */
/* ------------------------------------------------------------------ */

test('03 项目创建、真实文件读写与版本冲突', async () => {
  projectDir = path.join(DATA_TEST, 'projects', 'acceptance-project');

  const created = await local.post('/api/projects', {
    name: '验收项目',
    description: '真实文件读写',
    directory: projectDir,
  });
  assert.equal(created.status, 201);
  projectId = created.json.id;
  assert.equal(created.json.directory, path.resolve(projectDir));
  assert.ok(fs.existsSync(projectDir), '项目目录被真实创建');

  // 初始列表
  const listing = await local.get(`/api/files?projectId=${projectId}`);
  assert.equal(listing.status, 200);
  assert.deepEqual(listing.json.entries, []);

  // 父目录不存在时写文件 -> 404（要求 UI 先建目录）
  const noParent = await local.put('/api/files/text', {
    projectId,
    path: 'notes/a.txt',
    content: 'v1',
  });
  assert.equal(noParent.status, 404);
  assert.match(noParent.json.error, /parent directory does not exist/);

  const madeDir = await local.post('/api/files/folder', { projectId, path: 'notes' });
  assert.equal(madeDir.status, 200);
  assert.ok(fs.existsSync(path.join(projectDir, 'notes')));

  // 真实写入
  const content1 = '第一行\nsecond line\n';
  const write1 = await local.put('/api/files/text', { projectId, path: 'notes/a.txt', content: content1 });
  assert.equal(write1.status, 200);
  assert.ok(write1.json.version, '返回内容哈希版本');
  assert.equal(await fsp.readFile(path.join(projectDir, 'notes', 'a.txt'), 'utf8'), content1, '磁盘内容一致');

  const read1 = await local.get(`/api/files/text?projectId=${projectId}&path=${encodeURIComponent('notes/a.txt')}`);
  assert.equal(read1.status, 200);
  assert.equal(read1.json.content, content1);
  assert.equal(read1.json.version, write1.json.version);

  // 外部修改（模拟本机编辑器）后旧版本保存 -> 409
  await fsp.writeFile(path.join(projectDir, 'notes', 'a.txt'), 'external edit', 'utf8');
  const conflict = await local.put('/api/files/text', {
    projectId,
    path: 'notes/a.txt',
    content: 'stale save',
    version: write1.json.version,
  });
  assert.equal(conflict.status, 409);
  assert.match(conflict.json.error, /changed on disk/);
  assert.equal(await fsp.readFile(path.join(projectDir, 'notes', 'a.txt'), 'utf8'), 'external edit', '冲突时不覆盖磁盘');

  // 重新读取版本后再保存成功
  const read2 = await local.get(`/api/files/text?projectId=${projectId}&path=${encodeURIComponent('notes/a.txt')}`);
  const write2 = await local.put('/api/files/text', {
    projectId,
    path: 'notes/a.txt',
    content: 'after reload',
    version: read2.json.version,
  });
  assert.equal(write2.status, 200);

  // 不带 version 的写入会无条件覆盖（UI 必须始终带 version）
  const blind = await local.put('/api/files/text', { projectId, path: 'notes/a.txt', content: 'blind overwrite' });
  assert.equal(blind.status, 200);
  finding(
    'F-blind-write',
    'medium',
    '/api/files/text 允许不带 version 的写入，会静默覆盖磁盘上更新的内容',
    'PUT /api/files/text {path,content} 无 version 时返回 200 并覆盖，实测把 "after reload" 覆盖为 "blind overwrite"',
    '在 host.writeText 调用处要求 expectedVersion 必填（缺省直接 409/400），或由 UI 强制携带 version 并在缺失时拒绝保存。',
  );

  // 路径穿越
  const traversal = await local.get(`/api/files/text?projectId=${projectId}&path=${encodeURIComponent('../../secret.txt')}`);
  assert.equal(traversal.status, 400);
  const absolute = await local.get(`/api/files/download?projectId=${projectId}&path=${encodeURIComponent('C:\\Windows\\win.ini')}`);
  assert.equal(absolute.status, 400);

  // 下载
  const download = await local.get(`/api/files/download?projectId=${projectId}&path=${encodeURIComponent('notes/a.txt')}`);
  assert.equal(download.status, 200);
  assert.equal(download.text, 'blind overwrite');

  step('03-files', {
    projectId,
    projectDir,
    writeVersion: write1.json.version,
    conflictStatus: conflict.status,
    conflictError: conflict.json.error,
    traversalStatus: traversal.status,
    absolutePathStatus: absolute.status,
    downloadStatus: download.status,
    downloadBytes: download.buffer.length,
  });
});

/* ------------------------------------------------------------------ */
/* 04 真实命令执行 / 日志 / 重跑保留历史 / 重试重复                    */
/* ------------------------------------------------------------------ */

test('04 安全短命令真实执行、日志回读、重跑保留历史、客户端重试会重复建任务', async () => {
  const before = await state();
  const created = await local.post('/api/runs', {
    projectId,
    title: '验收短命令',
    command: 'Write-Output ACCEPT_RUN_ONE',
  });
  assert.equal(created.status, 201);
  const runId = created.json.id;
  assert.ok(runId);

  const done = await waitRun(runId, ['completed', 'failed']);
  assert.equal(done.status, 'completed', `run 状态 ${done.status} error=${done.error}`);
  assert.equal(done.exitCode, 0);
  assert.ok(done.pid, '记录了真实 pid');

  const log = await local.get(`/api/runs/${runId}/log`);
  assert.equal(log.status, 200);
  assert.match(log.text, /ACCEPT_RUN_ONE/);
  assert.match(log.text, /工作目录/);

  const tasksAfter = (await state()).tasks.filter((t) => t.id === done.taskId);
  assert.equal(tasksAfter.length, 1);
  assert.equal(tasksAfter[0].status, 'completed');

  // 增量日志 offset
  const partial = await local.get(`/api/runs/${runId}/log?offset=10`);
  assert.equal(partial.json.offset, (await local.get(`/api/runs/${runId}/log`)).json.offset);
  assert.ok(partial.json.text.length < log.text.length);

  // 重跑：新 run，旧 run 与旧日志保留
  const retried = await local.post(`/api/runs/${runId}/retry`, {});
  assert.equal(retried.status, 201);
  assert.notEqual(retried.json.id, runId);
  await waitRun(retried.json.id, ['completed', 'failed']);
  const historyLog = await local.get(`/api/runs/${runId}/log`);
  assert.equal(historyLog.status, 200, '旧 run 日志仍可读取');
  assert.match(historyLog.text, /ACCEPT_RUN_ONE/);

  // 客户端重试 / 双击：同一 body 连发两次 -> 两个独立任务（无幂等键）
  const retryA = await local.post('/api/runs', { projectId, title: '幂等性探测', command: 'Write-Output IDEMPOTENT_PROBE' });
  const retryB = await local.post('/api/runs', { projectId, title: '幂等性探测', command: 'Write-Output IDEMPOTENT_PROBE' });
  assert.equal(retryA.status, 201);
  assert.equal(retryB.status, 201);
  await Promise.all([waitRun(retryA.json.id, ['completed', 'failed']), waitRun(retryB.json.id, ['completed', 'failed'])]);

  const after2 = await state();
  const probeTasks = after2.tasks.filter((t) => t.title === '幂等性探测');

  step('04-short-command', {
    runId,
    exitCode: done.exitCode,
    log: log.text.slice(0, 600),
    retriedId: retried.json.id,
    duplicateTaskTitles: { 幂等性探测: probeTasks.length },
    duplicateRunIds: [retryA.json.id, retryB.json.id],
    historyRetained: historyLog.status,
  });
  report.runs.push({ runId, retriedId: retried.json.id, duplicateProbe: [retryA.json.id, retryB.json.id] });
});

test('04b 请求重试 / 双击重复发任务：同一 X-Request-Id 必须只产生一次真实执行', async () => {
  const clientRequestId = 'accept-idem-0001';
  const body = { projectId, title: '幂等键探测', command: 'Write-Output IDEMPOTENT_KEY' };
  const headers = { origin: `http://127.0.0.1:${PORT}`, cookie: local.cookie, 'x-request-id': clientRequestId };

  const first = await request('/api/runs', { method: 'POST', headers, body });
  const second = await request('/api/runs', { method: 'POST', headers, body });

  assert.equal(first.status, 201);
  step('04b-idempotency', {
    clientRequestId,
    header: 'x-request-id',
    firstStatus: first.status,
    secondStatus: second.status,
    firstRunId: first.json?.id,
    secondRunId: second.json?.id,
    sameRun: first.json?.id === second.json?.id,
  });

  const deduped = first.json?.id === second.json?.id;
  if (!deduped) {
    finding(
      'F-no-idempotency',
      'high',
      '创建执行 POST /api/runs 无幂等保护：客户端超时重试或手机端双击会真实重复执行同一条命令',
      `同一 X-Request-Id=${clientRequestId} 连发两次：${first.json?.id} / ${second.json?.id}，生成两个不同 run。`,
      '最小修复（index.mjs，不动 runner）：POST /api/runs 读 X-Request-Id / Idempotency-Key / clientRequestId，先查 all("runs") 命中就返回原 run；用 in-flight Map 关并发窗口。已验证 server-fixed 副本 13/13 通过。',
    );
  }

  assert.equal(
    first.json?.id,
    second.json?.id,
    '同一 X-Request-Id 两次请求返回了不同的 run（真实命令会被重复执行）',
  );

  await waitRun(first.json.id, ['completed', 'failed']);
  const st = await state();
  const tasks = st.tasks.filter((t) => t.title === '幂等键探测');
  assert.equal(tasks.length, 1, `同一 X-Request-Id 产生了 ${tasks.length} 个任务`);
  const runs = st.runs.filter((r) => r.clientRequestId === clientRequestId);
  assert.equal(runs.length, 1, `同一 X-Request-Id 产生了 ${runs.length} 条执行记录`);

  if (!report.findings.some((f) => f.id === 'F-no-idempotency')) {
    finding(
      'F-idempotency-ok',
      'info',
      '幂等已实现：同一 X-Request-Id 只产生一次真实执行',
      `两次请求返回同一 run ${first.json.id}，任务计数 ${tasks.length}。`,
      '无需修复。',
    );
  }
});

/* ------------------------------------------------------------------ */
/* 05 停止长命令                                                        */
/* ------------------------------------------------------------------ */

test('05 停止长命令后进程真实结束、状态收敛为 cancelled', async () => {
  const created = await local.post('/api/runs', {
    projectId,
    title: '验收长命令',
    command: 'Start-Sleep -Seconds 180',
  });
  assert.equal(created.status, 201);
  const runId = created.json.id;

  const running = await waitRun(runId, ['running']);
  assert.ok(running.pid, '长命令持有真实 pid');
  await waitFor(() => pidAlive(running.pid), { timeout: 10000, label: `长命令进程 ${running.pid} 存活` });

  const stop = await local.post(`/api/runs/${runId}/stop`, {});
  assert.equal(stop.status, 200);

  const stopped = await waitRun(runId, ['cancelled', 'failed', 'completed'], { timeout: 30000 });
  assert.equal(stopped.status, 'cancelled');

  await waitFor(() => !pidAlive(running.pid), { timeout: 15000, label: `进程 ${running.pid} 退出` });
  assert.equal(pidAlive(running.pid), false, '命令进程已真实结束');

  const st = await state();
  assert.equal(st.tasks.find((t) => t.id === stopped.taskId).status, 'cancelled');
  const cancelEvent = st.events.find((e) => e.taskId === stopped.taskId && e.type === 'cancelled');
  assert.ok(cancelEvent, '产生 cancelled 事件用于通知/总览');

  step('05-stop', {
    runId,
    pid: running.pid,
    pidAliveAfter: pidAlive(running.pid),
    status: stopped.status,
    exitCode: stopped.exitCode,
    event: cancelEvent && { type: cancelEvent.type, title: cancelEvent.title },
  });
});

/* ------------------------------------------------------------------ */
/* 06 协调器重启不影响 runner                                          */
/* ------------------------------------------------------------------ */

test('06 协调 API 服务重启不结束 runner 任务，状态可接回', async () => {
  const created = await local.post('/api/runs', {
    projectId,
    title: '重启期间长任务',
    command: 'Start-Sleep -Seconds 180',
  });
  assert.equal(created.status, 201);
  const runId = created.json.id;
  const running = await waitRun(runId, ['running']);
  const pidBefore = running.pid;
  const runnerPidBefore = ctl.runnerPid;
  const serverPidBefore = ctl.serverPid;
  const logBefore = (await local.get(`/api/runs/${runId}/log`)).json.offset;

  // 只停协调器，不 /T（runner 是 detached 后台进程）
  const killed = await ctl.stopServerOnly();
  assert.equal(killed, serverPidBefore);
  assert.equal(pidAlive(serverPidBefore), false, '协调器已退出');
  assert.equal(pidAlive(runnerPidBefore), true, 'runner 未随协调器退出');
  assert.equal(pidAlive(pidBefore), true, '任务子进程仍在运行');

  await sleep(1500);
  await ctl.start({ fresh: false });

  assert.equal(ctl.runnerPid, runnerPidBefore, '未重复拉起第二个 runner（复用同一 PID）');
  assert.equal(pidAlive(serverPidBefore), false, '旧协调器未残留');

  // 旧 cookie 仍然有效（sessionSecret 持久化）
  const st = await local.get('/api/state');
  assert.equal(st.status, 200, '重启后原 cookie 仍可用');
  const resumed = st.json.runs.find((r) => r.id === runId);
  assert.ok(resumed, '重启后仍能读到该 run');
  assert.equal(resumed.status, 'running', `重启后状态应仍在运行，实际 ${resumed.status}`);
  assert.equal(resumed.pid, pidBefore, 'pid 未变化');

  const logAfter = (await local.get(`/api/runs/${runId}/log`)).json.offset;
  assert.ok(logAfter >= logBefore, '日志仍可读');

  // 重启后仍能真实停止该任务
  const stop = await local.post(`/api/runs/${runId}/stop`, {});
  assert.equal(stop.status, 200);
  const stopped = await waitRun(runId, ['cancelled', 'failed', 'completed'], { timeout: 30000 });
  assert.equal(stopped.status, 'cancelled');
  await waitFor(() => !pidAlive(pidBefore), { timeout: 15000, label: `进程 ${pidBefore} 退出` });

  const health = await fetch(`http://127.0.0.1:${RUNNER_PORT}/health`, { headers: { Authorization: `Bearer ${workerToken}` } });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).pid, runnerPidBefore, '只有一个 runner 在监听 RUNNER_PORT');

  step('06-restart', {
    serverPidBefore,
    serverPidAfter: ctl.serverPid,
    runnerPidBefore,
    runnerPidAfter: ctl.runnerPid,
    runStatusAfterRestart: resumed.status,
    runPidAfterRestart: resumed.pid,
    logOffsetBefore: logBefore,
    logOffsetAfter: logAfter,
    stopAfterRestart: stopped.status,
    pidAliveAfter: pidAlive(pidBefore),
    starts: ctl.starts,
  });

  finding(
    'F-runner-single',
    'info',
    'runner 生命周期正确：协调器重启不重启 runner，未产生双 runner',
    `重启前后 runner PID 均为 ${runnerPidBefore}，/health 返回同一 PID，run 状态保持 running，可通过新协调器停止。`,
    '无需修复。',
  );
});

/* ------------------------------------------------------------------ */
/* 07 分块上传续传                                                      */
/* ------------------------------------------------------------------ */

test('07 分块上传：续传偏移冲突、完成落盘、传输标识不一致', async () => {
  const uploadId = 'accept-upload-1';
  const target = 'uploads/chunked.bin';
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

  const c1 = await local.post('/api/files/upload', { projectId, path: target, uploadId, offset: 0, data: b64('AAAA') });
  assert.equal(c1.status, 200);
  assert.deepEqual(c1.json, { offset: 4, complete: false });

  // 偏移冲突
  const bad = await local.post('/api/files/upload', { projectId, path: target, uploadId, offset: 2, data: b64('XX') });
  assert.equal(bad.status, 409);
  assert.equal(bad.json.offset, 4);

  // 正确续传
  const c2 = await local.post('/api/files/upload', { projectId, path: target, uploadId, offset: 4, data: b64('BBBB') });
  assert.equal(c2.status, 200);
  assert.equal(c2.json.offset, 8);

  // 传输标识与目标不一致
  const mismatch = await local.post('/api/files/upload', {
    projectId,
    path: 'uploads/other.bin',
    uploadId,
    offset: 8,
    data: b64('Z'),
  });
  assert.equal(mismatch.status, 400);

  // 非法 uploadId / 路径
  const badId = await local.post('/api/files/upload', { projectId, path: target, uploadId: '../evil', offset: 8, data: b64('Z') });
  assert.equal(badId.status, 400);
  const badPath = await local.post('/api/files/upload', { projectId, path: '../escape.bin', uploadId: 'x1', offset: 0, data: b64('Z') });
  assert.equal(badPath.status, 400);

  // 完成
  const fin = await local.post('/api/files/upload', { projectId, path: target, uploadId, offset: 8, data: b64('CC'), final: true });
  assert.equal(fin.status, 200);
  assert.deepEqual(fin.json, { offset: 10, complete: true });

  const onDisk = await fsp.readFile(path.join(projectDir, 'uploads', 'chunked.bin'), 'utf8');
  assert.equal(onDisk, 'AAAABBBBCC', '分块拼接结果与磁盘一致');

  const readBack = await local.get(`/api/files/text?projectId=${projectId}&path=${encodeURIComponent(target)}`);
  assert.equal(readBack.json.content, 'AAAABBBBCC');

  const tempStill = fs.existsSync(path.join(DATA_TEST, 'uploads', uploadId));
  assert.equal(tempStill, false, '完成后临时分块被清理');

  // 完成后同名 uploadId 再传 offset 0 会从 0 开始（临时文件已删除），但不会覆盖已完成文件直到 final
  const restartUpload = await local.post('/api/files/upload', { projectId, path: target, uploadId, offset: 0, data: b64('DD') });
  assert.equal(restartUpload.status, 200);
  assert.equal(restartUpload.json.offset, 2);

  step('07-upload', {
    uploadId,
    chunk1: c1.json,
    conflict: { status: bad.status, body: bad.json },
    chunk2: c2.json,
    identityMismatch: mismatch.status,
    invalidUploadId: badId.status,
    invalidPath: badPath.status,
    final: fin.json,
    fileOnDisk: onDisk,
    tempCleaned: !tempStill,
  });
});

/* ------------------------------------------------------------------ */
/* 08 WebSocket 终端                                                    */
/* ------------------------------------------------------------------ */

test('08 WebSocket 实时终端：input/output、重连回放、无任务快照污染、未授权拒绝', async () => {
  const term = await local.post('/api/terminals', { projectId, title: '验收终端' });
  assert.equal(term.status, 201);
  const sessionId = term.json.id;
  assert.equal(term.json.status, 'running');
  assert.equal(term.json.kind, 'terminal');

  // 未授权 WS 必须被拒绝
  const unauthorized = openSocket(`/api/terminal/${sessionId}`, { cookie: null });
  await waitFor(() => unauthorized.closed !== null || unauthorized.error !== null, { timeout: 10000, label: '未授权 WS 关闭' });
  assert.equal(unauthorized.opened, false, '无 cookie 的终端 WS 不得建立');

  // 跨源 WS 必须被拒绝
  const crossOrigin = openSocket(`/api/terminal/${sessionId}`, { cookie: local.cookie, origin: 'http://evil.example' });
  await waitFor(() => crossOrigin.closed !== null || crossOrigin.error !== null, { timeout: 10000, label: '跨源 WS 关闭' });
  assert.equal(crossOrigin.opened, false, 'Origin 不匹配的终端 WS 不得建立');

  // 正常连接 + 真实输入输出
  const ws = openSocket(`/api/terminal/${sessionId}`, { cookie: local.cookie });
  await waitFor(() => ws.opened, { timeout: 15000, label: '终端 WS 打开' });
  ws.send({ type: 'input', data: 'echo ACCEPT_WS_MARKER\r' });
  await ws.waitText('ACCEPT_WS_MARKER', 30000);

  // 必须保持连接跨越至少 2 个 1.8s 快照广播周期，否则检测随机漏报
  await sleep(4500);

  const outputJoin = ws.frames.map((f) => f.text).join('');
  const snapshotFrames = ws.frames.filter((f) => f.text.includes('"type":"snapshot"'));
  assert.equal(snapshotFrames.length, 0, `终端 WS 收到了 ${snapshotFrames.length} 个 snapshot 帧（应只走事件通道）`);
  assert.ok(!outputJoin.includes('"type":"snapshot"'), '终端 WS 不应收到任务快照帧');
  assert.ok(!outputJoin.includes('"projects":'), '终端 WS 不应混入 /api/state 快照内容');

  // 重连：应回放历史输出
  await ws.close();
  const ws2 = openSocket(`/api/terminal/${sessionId}`, { cookie: local.cookie });
  await waitFor(() => ws2.opened, { timeout: 15000, label: '终端 WS 重连' });
  await ws2.waitText('ACCEPT_WS_MARKER', 20000);
  const replay = ws2.frames.map((f) => f.text).join('');
  assert.ok(replay.includes('ACCEPT_WS_MARKER'));
  await sleep(2500);
  const replay2 = ws2.frames.map((f) => f.text).join('');
  assert.ok(!replay2.includes('"type":"snapshot"'), '重连后终端 WS 同样不应收到 snapshot');

  // 第二个输出确认是实时的（不是仅回放）
  ws2.send({ type: 'input', data: 'echo ACCEPT_WS_SECOND\r' });
  await ws2.waitText('ACCEPT_WS_SECOND', 30000);
  await ws2.close();

  // 终端日志可经 HTTP 读取（与 run 日志同一目录，但文件名按 session id 隔离）
  const termLog = await local.get(`/api/runs/${sessionId}/log`);
  assert.equal(termLog.status, 200);

  // 关闭终端
  const closed = await local.post(`/api/terminals/${sessionId}/close`, {});
  assert.equal(closed.status, 200);
  await waitFor(
    async () => {
      const st = await state();
      return st.sessions.find((s) => s.id === sessionId)?.status === 'closed';
    },
    { timeout: 20000, label: '终端会话 closed' },
  );

  // 事件快照 WS（非 /api/terminal/*）应收到 snapshot 帧
  const events = openSocket('/api/events', { cookie: local.cookie });
  await waitFor(() => events.opened, { timeout: 15000, label: '事件 WS 打开' });
  await waitFor(() => events.frames.some((f) => f.text.includes('"type":"snapshot"')), { timeout: 10000, label: 'snapshot 帧' });
  await events.close();

  step('08-terminal', {
    sessionId,
    unauthorizedOpened: unauthorized.opened,
    crossOriginOpened: crossOrigin.opened,
    firstOutputSample: outputJoin.slice(-400),
    replayContainsMarker: replay.includes('ACCEPT_WS_MARKER'),
    snapshotPollutedTerminal: outputJoin.includes('"snapshot"'),
    snapshotOnEventSocket: true,
    closedStatus: 'closed',
  });
});

/* ------------------------------------------------------------------ */
/* 09 工作流两步顺序                                                    */
/* ------------------------------------------------------------------ */

test('09 工作流：两个安全步骤按顺序执行', async () => {
  const created = await local.post('/api/workflows', {
    name: '验收工作流',
    projectId,
    steps: [
      { name: '训练', command: 'Write-Output ACCEPT_TRAIN_STEP' },
      { name: '评估', command: 'Write-Output ACCEPT_EVAL_STEP' },
    ],
  });
  assert.equal(created.status, 201);
  const workflowId = created.json.id;

  const finished = await waitFor(
    async () => {
      const st = await state();
      const w = st.workflows.find((x) => x.id === workflowId);
      return w && ['completed', 'failed'].includes(w.status) ? w : null;
    },
    { timeout: 90000, interval: 200, label: '工作流结束' },
  );
  assert.equal(finished.status, 'completed');
  assert.equal(finished.stepIndex, 1);

  const st = await state();
  const wfRuns = st.runs.filter((r) => r.workflowId === workflowId).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  assert.equal(wfRuns.length, 2);
  assert.equal(wfRuns[0].title, '验收工作流 · 训练');
  assert.equal(wfRuns[1].title, '验收工作流 · 评估');
  assert.ok(wfRuns[0].finishedAt <= wfRuns[1].startedAt, '第二步在第一步结束后开始');
  assert.deepEqual(wfRuns.map((r) => r.status), ['completed', 'completed']);

  const log0 = await local.get(`/api/runs/${wfRuns[0].id}/log`);
  const log1 = await local.get(`/api/runs/${wfRuns[1].id}/log`);
  assert.match(log0.text, /ACCEPT_TRAIN_STEP/);
  assert.match(log1.text, /ACCEPT_EVAL_STEP/);

  step('09-workflow', {
    workflowId,
    status: finished.status,
    stepIndex: finished.stepIndex,
    runs: wfRuns.map((r) => ({ id: r.id, title: r.title, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt })),
    firstLog: log0.text.slice(0, 300),
    secondLog: log1.text.slice(0, 300),
  });
});

/* ------------------------------------------------------------------ */
/* 10 成果登记 / 下载                                                   */
/* ------------------------------------------------------------------ */

test('10 成果登记与下载：命令生成 outputs 小报告后可下载', async () => {
  const outDir = path.join(DATA_TEST, 'projects', 'artifact-project');
  const p = await local.post('/api/projects', { name: '成果项目', directory: outDir });
  assert.equal(p.status, 201);
  const pid = p.json.id;

  const run = await local.post('/api/runs', {
    projectId: pid,
    title: '生成小报告',
    command: 'New-Item -ItemType Directory -Force -Path outputs | Out-Null; Set-Content -Path outputs\\report.txt -Value ACCEPT_ARTIFACT_OK',
  });
  assert.equal(run.status, 201);
  const done = await waitRun(run.json.id, ['completed', 'failed']);
  assert.equal(done.status, 'completed', `error=${done.error}`);

  const artifacts = await waitFor(
    async () => {
      const st = await state();
      const list = st.artifacts.filter((a) => a.runId === run.json.id);
      return list.length ? list : null;
    },
    { timeout: 15000, label: '成果登记' },
  );
  const artifact = artifacts.find((a) => a.name === 'report.txt');
  assert.ok(artifact, 'report.txt 被登记为成果');
  assert.equal(artifact.type, 'txt');
  assert.ok(fs.existsSync(artifact.path), '成果落盘存在');

  const download = await local.get(`/api/artifacts/${artifact.id}/download`);
  assert.equal(download.status, 200);
  assert.match(download.text, /ACCEPT_ARTIFACT_OK/);
  assert.match(String(download.headers['content-disposition']), /report\.txt/);

  const preview = await local.get(`/api/artifacts/${artifact.id}/preview`);
  assert.equal(preview.status, 200);
  assert.match(String(preview.headers['content-security-policy']), /sandbox/);

  const missing = await local.get('/api/artifacts/does-not-exist/download');
  assert.equal(missing.status, 404);

  step('10-artifacts', {
    projectId: pid,
    runId: run.json.id,
    artifact: { id: artifact.id, name: artifact.name, size: artifact.size, path: artifact.path },
    downloadStatus: download.status,
    contentType: download.headers['content-type'],
    previewCsp: preview.headers['content-security-policy'],
    missingStatus: missing.status,
  });
});

/* ------------------------------------------------------------------ */
/* 11 现有 API 可用性 + 缺口探测                                        */
/* ------------------------------------------------------------------ */

test('10b 失败工作流只继续当前失败步骤，保留旧执行并完成后续步骤',async()=>{
  const w=await local.post('/api/workflows',{name:'恢复工作流',projectId,steps:[
    {name:'首次失败再继续',command:"if (!(Test-Path '.retry-once')) { Set-Content '.retry-once' 'yes'; exit 1 }; Write-Output RETRY_RECOVERED"},
    {name:'后续步骤',command:'Write-Output NEXT_AFTER_RETRY'}
  ]});assert.equal(w.status,201);
  await waitFor(async()=>((await state()).workflows.find(v=>v.id===w.json.id)?.status==='failed'),{label:'工作流失败'});
  const failed=(await state()).runs.find(r=>r.workflowId===w.json.id);assert.equal(failed.status,'failed');
  const retry=await local.post(`/api/runs/${failed.id}/retry`,{});assert.equal(retry.status,201);
  await waitFor(async()=>((await state()).workflows.find(v=>v.id===w.json.id)?.status==='completed'),{label:'工作流继续完成'});
  const runs=(await state()).runs.filter(r=>r.workflowId===w.json.id);assert.equal(runs.length,3);
  assert.equal(runs.filter(r=>r.status==='completed').length,2);assert.equal(runs.find(r=>r.id===failed.id).status,'failed');
  const old=await local.get(`/api/runs/${failed.id}/log`);assert.equal(old.status,200);
  const rejected=await local.post(`/api/runs/${failed.id}/retry`,{});assert.equal(rejected.status,400);
});

test('11 现有 API 可用性与 UI 需要的缺口探测', async () => {
  const probes = {};
  const get = async (p) => {
    const res = await local.get(p);
    probes[p] = res.status;
    return res;
  };

  await get('/api/state');
  const metrics = await get('/api/metrics');
  const connections = await get('/api/connections');
  await get('/api/settings');
  const guide = await get('/api/connection-guide');
  await get(`/api/files?projectId=${projectId}`);
  await get(`/api/runs/${report.runs[0].runId}/log`);

  assert.equal(metrics.status, 200);
  assert.equal(typeof metrics.json.cpuPercent, 'number');
  assert.ok(metrics.json.memory.total > 0);
  assert.equal(connections.status, 200);
  assert.ok(Array.isArray(connections.json.agents));
  assert.equal(guide.status, 200);
  assert.ok(guide.json.serveCommand.includes('tailscale serve'));
  assert.ok(guide.json.merge.includes('100.64.0.0/10'));

  const mail=await local.post('/api/notifications/test',{});assert.equal(mail.status,400);
  step('11-api-probes',{metrics:metrics.status,connections:connections.status,guide:guide.status,mailWithoutConfig:mail.status});
  external('E2', 'SMTP 邮件通知', `未配置邮箱账号；POST /api/settings 只做存储，未验证真实投递。`);
  external('E3', 'Codex/Claude Agent 真实调用', 'codex 已安装但按任务约束不执行付费 agent 调用，仅验证“未安装/已安装”探测。');
});

/* ------------------------------------------------------------------ */
/* 12 打包证据 + 清理                                                   */
/* ------------------------------------------------------------------ */

after(async () => {
  // 记录清理前所有由本测试产生的进程 PID，逐一核验
  const pids = [];
  try {
    const st = await state();
    for (const r of st.runs) if (r.pid) pids.push({ kind: 'run', id: r.id, pid: r.pid, status: r.status });
    for (const s of st.sessions) if (s.pid) pids.push({ kind: 'session', id: s.id, pid: s.pid });
  } catch {
    /* server already gone */
  }

  const cleanup = await ctl.stopAll();

  const leftover = pids.filter((p) => pidAlive(p.pid));
  for (const p of leftover) {
    // 只清理本测试记录的 pid
    try {
      const { execFileSync } = await import('node:child_process');
      execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* ignore */
    }
  }

  report.cleanup = {
    ...cleanup,
    recordedChildPids: pids,
    leftoverAfterShutdown: leftover,
    serverPidAlive: cleanup.server ? cleanup.server.aliveAfter : null,
    runnerPidAlive: cleanup.runner ? cleanup.runner.aliveAfter : null,
    verifiedAt: new Date().toISOString(),
  };
  report.finishedAt = new Date().toISOString();

  await writeEvidence(`acceptance-report${TAG}.json`, report);
  await writeEvidence(`acceptance-report${TAG}.md`, renderMarkdown(report));
  await writeEvidence(`steps${TAG}.json`, report.steps);
});

function renderMarkdown(r) {
  const lines = [];
  lines.push('# 真实 API 集成验收报告（隔离快照 work/backend-acceptance）');
  lines.push('');
  lines.push(`- 开始: ${r.startedAt}`);
  lines.push(`- 结束: ${r.finishedAt ?? ''}`);
  lines.push(`- Node: ${r.environment.node} / ${r.environment.platform}`);
  lines.push(`- 端口: server ${r.environment.port} / runner ${r.environment.runnerPort}`);
  lines.push(`- 数据目录: ${r.environment.consoleData}`);
  lines.push('');
  lines.push('## 阻断/风险问题');
  lines.push('');
  if (!r.findings.length) lines.push('无');
  for (const f of r.findings) {
    lines.push(`### ${f.id} [${f.severity}] ${f.title}`);
    lines.push('');
    lines.push(`- 证据: ${f.evidence}`);
    lines.push(`- 最小修复: ${f.fix}`);
    lines.push('');
  }
  lines.push('## 缺口（未实现 / 不能当完成）');
  lines.push('');
  for (const g of r.gaps) {
    lines.push(`- **${g.id}** ${g.title}`);
    lines.push(`  - 证据: ${g.evidence}`);
  }
  lines.push('');
  lines.push('## 外部依赖（本机无法验证，未宣称通过）');
  lines.push('');
  for (const e of r.external) {
    lines.push(`- **${e.id}** ${e.title} — ${e.note}`);
  }
  lines.push('');
  lines.push('## 实测步骤');
  lines.push('');
  for (const s of r.steps) {
    lines.push(`### ${s.name}`);
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(s.data, null, 2));
    lines.push('```');
    lines.push('');
  }
  lines.push('## 进程清理');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(r.cleanup, null, 2));
  lines.push('```');
  return lines.join('\n');
}
