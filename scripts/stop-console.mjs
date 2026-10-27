import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';

const root=path.resolve(import.meta.dirname,'..');
const normalize=s=>String(s||'').replaceAll('/','\\').toLowerCase();
const probe="$ErrorActionPreference='Stop';$result=@();foreach($port in @(8787,4175)){$listener=Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue;if($listener){$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$listener.OwningProcess);$result+=@{port=$port;pid=$p.ProcessId;name=$p.Name;command=$p.CommandLine}}};ConvertTo-Json -Compress -InputObject @($result)";
const owners=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',probe],{encoding:'utf8',windowsHide:true}));
for(const owner of owners){
  const entry=path.join(root,'server',owner.port===8787?'index.mjs':'runner.mjs');
  if(owner.name!=='node.exe'||!normalize(owner.command).includes(normalize(entry)))throw new Error(`端口 ${owner.port} 由其他程序使用，没有关闭它。`);
}
const dbPath=path.join(root,'data','console.sqlite');
const read=fs.existsSync(dbPath)?new DatabaseSync(dbPath,{readOnly:true}):null;
const rows=read?read.prepare("SELECT collection,id,value FROM records WHERE collection IN ('runs','sessions','workflows')").all().map(r=>({...r,item:JSON.parse(r.value)})):[];
read?.close();
const active=rows.filter(r=>['running','starting','queued','stopping','waiting'].includes(r.item.status));
const jobs=active.filter(r=>r.collection==='runs');
const terminals=active.filter(r=>r.collection==='sessions');
if(process.argv.includes('--check')){console.log(JSON.stringify({running:owners.length>0,jobs:jobs.length,terminals:terminals.length}));process.exit(0);}
if(!owners.length){console.log('控制台已经关闭。');process.exit(0);}
if(jobs.length||terminals.length){
  console.log(`还有 ${jobs.length} 个任务、${terminals.length} 个终端。关闭会停止这些工作。`);
  const input=readline.createInterface({input:process.stdin,output:process.stdout});
  const answer=await input.question('确定全部关闭吗？输入 Y 确认，其他输入取消：');input.close();
  if(answer.trim().toLowerCase()!=='y'){console.log('已取消，后台继续运行。');process.exit(0);}
}
// The API is stopped first; /T applies only to this console's own runner tree.
for(const owner of owners.sort((a,b)=>b.port-a.port))execFileSync('taskkill',['/PID',String(owner.pid),...(owner.port===4175?['/T']:[]),'/F'],{windowsHide:true,stdio:'ignore'});
if(fs.existsSync(dbPath)){
  const db=new DatabaseSync(dbPath);const timestamp=new Date().toISOString();
  for(const row of active){
    const status=row.collection==='sessions'?'closed':row.collection==='workflows'?'failed':'cancelled';
    db.prepare('UPDATE records SET value=? WHERE collection=? AND id=?').run(JSON.stringify({...row.item,status,finishedAt:timestamp,error:'用户手动关闭控制台'}),row.collection,row.id);
    if(row.collection==='runs'){
      const task=db.prepare("SELECT value FROM records WHERE collection='tasks' AND id=?").get(row.item.taskId);
      if(task)db.prepare("UPDATE records SET value=? WHERE collection='tasks' AND id=?").run(JSON.stringify({...JSON.parse(task.value),status:'cancelled'}),row.item.taskId);
    }
  }
  db.close();
}
console.log('控制台后台已关闭。文件与历史已保留，Codex 桌面应用不受影响。');
console.log('下次登录 Windows 仍会自动启动；永久关闭自启可在面板「设备 → 设置」操作。');
