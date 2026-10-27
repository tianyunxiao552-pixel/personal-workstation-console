import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = path.resolve(process.env.CONSOLE_DATA || path.join(ROOT, 'data'));
fs.mkdirSync(DATA, { recursive: true });
export const db = new DatabaseSync(path.join(DATA, 'console.sqlite'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(collection,id));');
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export function get(c, key) { const r = db.prepare('SELECT value FROM records WHERE collection=? AND id=?').get(c, key); return r ? JSON.parse(r.value) : null; }
export function all(c) { return db.prepare('SELECT value FROM records WHERE collection=?').all(c).map(r => JSON.parse(r.value)); }
export function put(c, r) { db.prepare('INSERT INTO records VALUES (?,?,?) ON CONFLICT(collection,id) DO UPDATE SET value=excluded.value').run(c, r.id, JSON.stringify(r)); return r; }
export function remove(c, key) { db.prepare('DELETE FROM records WHERE collection=? AND id=?').run(c, key); }
export function update(c, key, patch) { const prev = get(c, key); if (!prev) throw Object.assign(new Error('记录不存在'), { status: 404 }); return put(c, { ...prev, ...patch, updatedAt: now() }); }
export function event(type, title, detail = '', taskId = null) { return put('events', { id: id(), type, title, detail, taskId, createdAt: now(), read: false }); }
export function settings() { return get('settings', 'main'); }
if (!settings()) put('settings', { id: 'main', workerToken: randomBytes(32).toString('hex'), pairingCode: randomBytes(12).toString('base64url'), sessionSecret: randomBytes(32).toString('hex'), maxConcurrent: 2, email: null });
if (!all('projects').length) {
  const directory = path.join(DATA, 'workspace'); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'README.md'), '# 我的控制台工作区\n\n这里是你的真实本机目录。可以上传文件、运行命令，或连接已有项目。\n');
  put('projects', { id: 'workspace', name: '控制台工作区', description: '真实本机目录 · 可直接运行任务', directory, color: 'blue', createdAt: now(), archived: false });
}
export const ACTIVE = new Set(['queued', 'starting', 'running', 'stopping']);
export function snapshot() {
  return { projects: all('projects'), tasks: all('tasks').sort((a,b)=>b.createdAt.localeCompare(a.createdAt)), runs: all('runs').sort((a,b)=>b.createdAt.localeCompare(a.createdAt)), sessions: all('sessions'), artifacts: all('artifacts').sort((a,b)=>b.createdAt.localeCompare(a.createdAt)), services: all('services'), workflows: all('workflows'), events: all('events').sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,200) };
}
