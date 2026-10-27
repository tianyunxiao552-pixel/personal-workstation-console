import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {DatabaseSync} from 'node:sqlite';
const root=path.resolve(import.meta.dirname,'..');const data=path.join(root,'data');
const source=process.argv[2];if(!source){console.error('用法：node scripts/restore.mjs 备份.sqlite');process.exit(1);}
const isListening=port=>new Promise(resolve=>{const c=net.connect(port,'127.0.0.1');c.on('connect',()=>{c.destroy();resolve(true);});c.on('error',()=>resolve(false));});
if(await isListening(8787)||await isListening(4175))throw new Error('请先停止控制台和执行器，再恢复备份。');
const sourcePath=path.resolve(source);const input=await fs.readFile(sourcePath);if(input.subarray(0,16).toString()!=='SQLite format 3\0')throw new Error('文件不是有效的 SQLite 备份');
const check=new DatabaseSync(sourcePath,{readOnly:true});try{const state=check.prepare('PRAGMA quick_check').get();if(Object.values(state)[0]!=='ok')throw new Error('备份校验未通过');check.prepare('SELECT value FROM records WHERE collection=? AND id=?').get('settings','main');}finally{check.close();}
await fs.mkdir(data,{recursive:true});const saved=path.join(data,'before-restore-'+new Date().toISOString().replace(/[:.]/g,'-'));await fs.mkdir(saved);
for(const name of ['console.sqlite','console.sqlite-wal','console.sqlite-shm']){const old=path.join(data,name);try{await fs.rename(old,path.join(saved,name));}catch(e){if(e.code!=='ENOENT')throw e;}}
await fs.writeFile(path.join(data,'console.sqlite'),input);
console.log('备份已恢复。之前的数据保存在 '+saved+'。重新启动 start-console.cmd 即可。');
