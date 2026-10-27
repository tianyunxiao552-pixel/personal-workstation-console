import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { WebSocketServer } from 'ws';
import * as pty from 'node-pty';
import { DATA, all, get, put, update, id, now, settings, event, ACTIVE } from './store.mjs';

const PORT = Number(process.env.RUNNER_PORT || 4175);
const children = new Map(); const terminals = new Map(); const clients = new Map();
const logs = path.join(DATA,'logs'); fs.mkdirSync(logs,{recursive:true});
const token = settings().workerToken;
const json = (res,status,value) => { res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value)); };
const logPath = rid => path.join(logs, `${rid}.log`);
function append(rid, text) { fs.appendFileSync(logPath(rid), text); }
function output(rid, text) {
  append(rid,text);
  const run = get('runs',rid); if (!run) return;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('@console:')) {
      try { const metric=JSON.parse(line.slice(9)); const rows=[...(run.metrics||[]), {...metric,time:now()}].slice(-2000); run.metrics=rows; if (metric.epoch!=null&&metric.total) run.progress=Math.round(metric.epoch/metric.total*100); } catch {}
    }

  }
  put('runs',run);
}
function collectArtifacts(run) {
  const project = get('projects',run.projectId); if (!project) return;
  const folder = path.join(project.directory,'outputs');
  if (!fs.existsSync(folder)) return;
  for (const name of fs.readdirSync(folder)) {
    const source=path.join(folder,name);const stat=fs.statSync(source);if(!stat.isFile()||stat.mtimeMs<new Date(run.startedAt).getTime()-1000)continue;
    const aid=id();const dest=path.join(DATA,'artifacts',aid,name);fs.mkdirSync(path.dirname(dest),{recursive:true});
    const saved=stat.size<=20*1024*1024; if(saved)fs.copyFileSync(source,dest);
    put('artifacts',{id:aid,name,projectId:run.projectId,runId:run.id,taskId:run.taskId,path:saved?dest:source,size:stat.size,archived:saved,createdAt:now(),type:path.extname(name).slice(1)});
  }
}
function finish(rid, code, error) {
  const run=get('runs',rid);if(!run)return;children.delete(rid);
  const status=run.status==='stopping'?'cancelled':(code===0&&!error?'completed':'failed');
  const result=update('runs',rid,{status,exitCode:code,finishedAt:now(),error:error||null,progress:status==='completed'?100:run.progress});
  update('tasks',run.taskId,{status});
  if(status==='completed') collectArtifacts(result);
  event(status,status==='completed'?`${run.title} 已完成`:status==='cancelled'?`${run.title} 已停止`:`${run.title} 执行失败`,error||`退出码 ${code}`,run.taskId);
  if(run.workflowId) advanceWorkflow(run.workflowId,status);
  pump();
}
function launch(run) {
  update('runs',run.id,{status:'starting',startedAt:now()});update('tasks',run.taskId,{status:'running'});
  let binary,args;
  if(run.executable) { binary=run.executable;args=run.args||[]; }
  else { binary=process.platform==='win32'?'powershell.exe':'/bin/sh';args=process.platform==='win32'?['-NoProfile','-NonInteractive','-Command',run.command]:['-lc',run.command]; }
  append(run.id,`[${now()}] ${run.title}\n工作目录: ${run.cwd}\n${run.agent?`Agent: ${run.agent}`:run.command||[binary,...args].join(' ')}\n\n`);
  try {
    const child=spawn(binary,args,{cwd:run.cwd,windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8',...run.env},stdio:['pipe','pipe','pipe']});
    children.set(run.id,child);update('runs',run.id,{status:'running',pid:child.pid});
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    let buffer='';child.stdout.on('data',chunk=>{buffer+=chunk;const split=buffer.lastIndexOf('\n');if(split>=0){output(run.id,buffer.slice(0,split+1));buffer=buffer.slice(split+1);}});
    child.stderr.on('data',chunk=>append(run.id,chunk));
    child.once('error',err=>finish(run.id,null,err.message));
    child.once('close',code=>{if(buffer)output(run.id,buffer);if(children.has(run.id))finish(run.id,code,null);});
    child.stdin.end();
  }catch(err){finish(run.id,null,err.message);}
}
function pump(){const available=Math.max(0,settings().maxConcurrent-children.size);all('runs').filter(r=>r.status==='queued').sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).slice(0,available).forEach(launch);}
function advanceWorkflow(wid,status){
  const w=get('workflows',wid);if(!w||w.status!=='running')return;
  if(status!=='completed'){update('workflows',wid,{status:'failed'});return;}
  const next=w.stepIndex+1;if(next>=w.steps.length){update('workflows',wid,{status:'completed',finishedAt:now()});return;}
  update('workflows',wid,{stepIndex:next});enqueue({...w.steps[next],projectId:w.projectId,workflowId:wid,cwd:w.cwd,title:`${w.name} · ${w.steps[next].name}`});
}
function enqueue(spec){
  if(spec.agent)throw new Error('请在 Codex 桌面会话中继续，面板不再启动 CLI Agent');
  if(spec.clientRequestId){const known=all('runs').find(r=>r.clientRequestId===spec.clientRequestId);if(known)return known;}
  const tid=spec.taskId||id();const rid=id();const project=get('projects',spec.projectId||'workspace');
  if(!project)throw new Error('项目不存在');
  const cwd=spec.cwd||project.directory;if(!fs.existsSync(cwd))throw new Error('工作目录不存在');
  if(!get('tasks',tid))put('tasks',{id:tid,title:spec.title||'新任务',projectId:project.id,kind:spec.agent?'agent':(spec.kind||'command'),createdAt:now(),status:'queued'});
  const r={...spec,id:rid,taskId:tid,title:spec.title||'新任务',projectId:project.id,cwd,status:'queued',createdAt:now(),metrics:[],progress:null};
  put('runs',r);update('tasks',tid,{status:'queued',latestRunId:rid});pump();return get('runs',rid);
}
function terminal(spec){
  if(spec.clientRequestId){const known=all('sessions').find(r=>r.clientRequestId===spec.clientRequestId);if(known)return known;}
  const project=get('projects',spec.projectId||'workspace');const sid=id();
  const shell=spec.shell||(process.platform==='win32'?'powershell.exe':'/bin/bash');
  const proc=pty.spawn(shell,process.platform==='win32'?['-NoLogo']:[],{name:'xterm-256color',cols:80,rows:24,cwd:project.directory,env:{...process.env,TERM:'xterm-256color'},useConpty:true});
  terminals.set(sid,proc);clients.set(sid,new Set());
  put('sessions',{id:sid,clientRequestId:spec.clientRequestId,projectId:project.id,title:spec.title||'项目终端',status:'running',createdAt:now(),kind:'terminal'});
  proc.onData(data=>{append(sid,data);for(const ws of clients.get(sid)||[])if(ws.readyState===1)ws.send(data);});
  proc.onExit(({exitCode})=>{update('sessions',sid,{status:'closed',exitCode});terminals.delete(sid);for(const ws of clients.get(sid)||[])ws.close();clients.delete(sid);});
  return get('sessions',sid);
}
const server=http.createServer(async(req,res)=>{
  if(req.headers.authorization!==`Bearer ${token}`)return json(res,401,{error:'unauthorized'});
  try{
    if(req.url==='/health')return json(res,200,{ok:true,pid:process.pid});
    let raw='';for await(const chunk of req)raw+=chunk;if(raw.length>4e6)return json(res,413,{error:'请求过大'});const body=raw?JSON.parse(raw):{};
    if(req.method==='POST'&&req.url==='/runs')return json(res,201,enqueue(body));
    if(req.method==='POST'&&req.url==='/terminals')return json(res,201,terminal(body));
    const stop=req.url.match(/^\/runs\/([\w-]+)\/stop$/);
    if(stop){const r=get('runs',stop[1]);if(!r)return json(res,404,{error:'任务不存在'});if(r.status==='queued'){update('runs',r.id,{status:'cancelled',finishedAt:now()});update('tasks',r.taskId,{status:'cancelled'});}else if(children.has(r.id)){update('runs',r.id,{status:'stopping'});if(process.platform==='win32')execFile('taskkill',['/PID',String(children.get(r.id).pid),'/T','/F'],{windowsHide:true},()=>{});else children.get(r.id).kill('SIGTERM');}return json(res,200,get('runs',r.id));}
    const close=req.url.match(/^\/terminals\/([\w-]+)\/close$/);if(close){terminals.get(close[1])?.kill();return json(res,200,{ok:true});}
    if(req.url==='/workflows'&&req.method==='POST'){if(body.clientRequestId){const known=all('workflows').find(w=>w.clientRequestId===body.clientRequestId);if(known)return json(res,200,known);}const p=get('projects',body.projectId||'workspace');if(!p)throw new Error('项目不存在');if(!body.steps?.length)throw new Error('需要至少一个步骤');const w=put('workflows',{id:id(),clientRequestId:body.clientRequestId,name:body.name,projectId:p.id,cwd:p.directory,steps:body.steps,stepIndex:0,status:'running',createdAt:now()});enqueue({...body.steps[0],projectId:p.id,workflowId:w.id,title:`${w.name} · ${body.steps[0].name}`});return json(res,201,w);}
    json(res,404,{error:'不存在的接口'});
  }catch(err){json(res,400,{error:err.message});}
});
const wss=new WebSocketServer({noServer:true});
server.on('upgrade',(req,socket,head)=>{if(req.headers.authorization!==`Bearer ${token}`){socket.destroy();return;}const sid=req.url.split('/').pop();if(!terminals.has(sid)){socket.destroy();return;}wss.handleUpgrade(req,socket,head,ws=>{clients.get(sid).add(ws);if(fs.existsSync(logPath(sid)))ws.send(fs.readFileSync(logPath(sid),'utf8').slice(-200000));ws.on('message',data=>{try{const m=JSON.parse(data);if(m.type==='resize')terminals.get(sid)?.resize(Math.min(240,Math.max(20,m.cols)),Math.min(100,Math.max(5,m.rows)));else if(m.type==='input')terminals.get(sid)?.write(String(m.data));}catch{}});ws.on('close',()=>clients.get(sid)?.delete(ws));});});
for(const s of all('sessions').filter(s=>s.status==='running'))update('sessions',s.id,{status:'interrupted'});
for(const r of all('runs').filter(r=>['running','starting','stopping'].includes(r.status)))update('runs',r.id,{status:'unknown'});
server.listen(PORT,'127.0.0.1',()=>{console.log(`Runner listening on ${PORT}`);pump();});
