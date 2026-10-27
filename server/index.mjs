import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn,execFile } from 'node:child_process';
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import httpProxy from 'http-proxy';
import nodemailer from 'nodemailer';
import { ROOT, DATA, db, all, get, put, update, remove, id, now, settings, snapshot, event } from './store.mjs';
import * as host from './host.mjs';
import {DesktopConnector} from './desktop.mjs';
const desktop=new DesktopConnector();

const PORT=Number(process.env.PORT||8787); const RUNNER_PORT=Number(process.env.RUNNER_PORT||4175);
const app=express();app.disable('x-powered-by');app.use(express.json({limit:'3mb'}));
const server=http.createServer(app); const realtime=new WebSocketServer({noServer:true}); const eventClients=new Set();
const proxy=httpProxy.createProxyServer({target:'http://127.0.0.1:4173',ws:true});
proxy.on('error',(_err,_req,res)=>{if(res?.writeHead){res.writeHead(503,{'Content-Type':'text/plain;charset=utf-8'});res.end('开发预览正在启动，请刷新页面。');}});
const sign=s=>createHmac('sha256',settings().sessionSecret).update(s).digest('hex');
function local(req){return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host||'')&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);}
function authenticated(req){const value=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('console_session='))?.slice(16);if(!value)return false;const [expires,sig]=value.split('.');return Number(expires)>Date.now()&&sig===sign(expires);}
function cookie(res){const exp=String(Date.now()+30*86400000);res.setHeader('Set-Cookie',`console_session=${exp}.${sign(exp)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`);}
function error(message,status=400){return Object.assign(new Error(message),{status});}
function originOkay(req){if(!req.headers.origin)return local(req);try{return new URL(req.headers.origin).host===req.headers.host;}catch{return false;}}
app.use('/api',(req,res,next)=>{if(req.method!=='GET'&&!originOkay(req))return res.status(403).json({error:'请求来源不匹配，请从控制台入口操作'});next();});
app.get('/api/session',(req,res)=>{if(local(req))cookie(res);res.json({authenticated:local(req)||authenticated(req),local:local(req),name:'个人工作站',version:'1.0.0'});});
app.post('/api/login',(req,res)=>{const expected=Buffer.from(settings().pairingCode);const received=Buffer.from(String(req.body.code||''));if(expected.length!==received.length||!timingSafeEqual(expected,received))return res.status(401).json({error:'配对码不正确'});cookie(res);res.json({ok:true});});
app.use('/api',(req,res,next)=>authenticated(req)?next():res.status(401).json({error:'请使用本机设置中的配对码连接'}));

async function runner(route,body){const response=await fetch(`http://127.0.0.1:${RUNNER_PORT}${route}`,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',Authorization:`Bearer ${settings().workerToken}`},body:body?JSON.stringify(body):undefined});const data=await response.json();if(!response.ok)throw error(data.error||'执行器请求失败',response.status);return data;}
async function ensureRunner(){try{await runner('/health');return;}catch{}
  const output=fs.openSync(path.join(DATA,'runner.log'),'a');
  const child=spawn(process.execPath,['server/runner.mjs'],{cwd:ROOT,detached:true,windowsHide:true,stdio:['ignore',output,output],env:{...process.env,CONSOLE_DATA:DATA}});child.unref();fs.closeSync(output);
  for(let n=0;n<30;n++){await new Promise(r=>setTimeout(r,200));try{await runner('/health');return;}catch{}}
  throw new Error('执行器启动失败，请查看 data/runner.log');
}
const asyncRoute=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
function startup(action){return new Promise((resolve,reject)=>{execFile('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(ROOT,'scripts/autostart.ps1'),'-Action',action],{windowsHide:true,timeout:15000},(err,out)=>{if(err)return reject(error('自动启动设置失败：'+err.message));try{resolve(JSON.parse(out));}catch{reject(error('无法读取自动启动状态'));}});});}
app.get('/api/autostart',asyncRoute(async(_req,res)=>res.json(process.platform==='win32'?await startup('Status'):{enabled:false,supported:false})));
app.post('/api/autostart',asyncRoute(async(req,res)=>{if(process.platform!=='win32')throw error('该入口适用于 Windows');res.json(await startup(req.body.enabled?'Enable':'Disable'));}));
app.get('/api/state',(_req,res)=>res.json(snapshot()));
app.get('/api/metrics',asyncRoute(async(_req,res)=>res.json(await host.collectHostMetrics())));
app.get('/api/connections',asyncRoute(async(_req,res)=>{const base=await host.connectionStatus();let status;try{const data=await desktop.threads();status={connected:true,threads:data.threads.length};}catch(e){status={connected:false,error:e.message};}res.json({...base,desktop:status});}));
app.get('/api/desktop/threads',asyncRoute(async(req,res)=>res.json(await desktop.threads({fresh:req.query.refresh==='1'}))));
app.get('/api/desktop/threads/:id',asyncRoute(async(req,res)=>res.json(await desktop.read(req.params.id,req.query.hostId,req.query.cursor))));
app.post('/api/desktop/threads/:id/workspace',asyncRoute(async(req,res)=>{
  const thread=await desktop.known(req.params.id,req.body.hostId);
  if(thread.hostId&&thread.hostId!=='local')throw error('这个会话在另一台主机上，请在对应主机上传文件');
  if(!thread.cwd)throw error('这段会话没有可用的 workspace');
  const directory=path.resolve(thread.cwd);const info=await fsp.stat(directory);if(!info.isDirectory())throw error('workspace 目录不可用');
  const same=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
  let project=all('projects').find(p=>same(p.directory,directory));
  if(!project)project=put('projects',{id:id(),name:thread.title,description:'Codex 桌面会话工作区',directory,color:'blue',createdAt:now(),archived:false});
  put('desktopBindings',{id:thread.id,projectId:project.id,directory,hostId:thread.hostId,updatedAt:now()});res.json({projectId:project.id,directory});
}));
const desktopSends=new Map();
app.post('/api/desktop/threads/:id/message',asyncRoute(async(req,res)=>{
  const requestId=String(req.body.clientRequestId||req.headers['x-request-id']||id());const key=req.params.id+':'+requestId;
  const known=get('desktopMessages',key);if(known?.status==='accepted')return res.json(known.result);
  if(known?.status==='rejected')throw error(known.error,400);
  if(desktopSends.has(key))return res.json(await desktopSends.get(key));
  if(known)throw error('这次发送的结果未确认，请先查看桌面会话是否收到，避免重复发送',409);
  if(typeof req.body.prompt!=='string'||!req.body.prompt.trim())throw error('请先描述你想让 AI 完成什么');
  put('desktopMessages',{id:key,threadId:req.params.id,status:'sending',createdAt:now()});
  const operation=desktop.send(req.params.id,req.body).then(result=>{update('desktopMessages',key,{status:'accepted',result});return result;}).catch(e=>{update('desktopMessages',key,{status:e.status===400?'rejected':'uncertain',error:e.message});throw e;}).finally(()=>desktopSends.delete(key));
  desktopSends.set(key,operation);res.json(await operation);
}));
app.get('/api/settings',(req,res)=>{const s=settings();res.json({maxConcurrent:s.maxConcurrent,email:s.email?{host:s.email.host,port:s.email.port,user:s.email.user,to:s.email.to,secure:s.email.secure}:null,pairingCode:local(req)?s.pairingCode:undefined,local:local(req)});});
app.post('/api/settings',(req,res)=>{const s=settings();if(req.body.maxConcurrent!=null)s.maxConcurrent=Math.max(1,Math.min(16,Number(req.body.maxConcurrent)||2));if(req.body.email){const v=req.body.email;s.email={host:v.host,port:Number(v.port)||465,secure:v.secure!==false,user:v.user,password:v.password||s.email?.password,to:v.to};}put('settings',s);res.json({ok:true});});
app.post('/api/notifications/read',(_req,res)=>{for(const e of all('events').filter(e=>!e.read))update('events',e.id,{read:true});res.json({ok:true});});
app.post('/api/notifications/test',asyncRoute(async(_req,res)=>{await sendMail('控制台连接测试','邮件通知渠道工作正常。');res.json({ok:true});}));
app.post('/api/projects',asyncRoute(async(req,res)=>{const directory=path.resolve(req.body.directory||path.join(DATA,'projects',id()));await fsp.mkdir(directory,{recursive:true});const p=put('projects',{id:id(),name:String(req.body.name||'新项目'),description:String(req.body.description||''),directory,color:req.body.color||'blue',createdAt:now(),archived:false});res.status(201).json(p);}));
app.patch('/api/projects/:id',asyncRoute(async(req,res)=>{const patch={};for(const k of ['name','description','archived'])if(req.body[k]!=null)patch[k]=req.body[k];res.json(update('projects',req.params.id,patch));}));
const inflight=new Map();
app.post('/api/runs',asyncRoute(async(req,res)=>{const spec=req.body;
  if(!spec.command&&!spec.agent&&!spec.executable)throw error('请填写命令或选择 Agent');
  const key=String(spec.clientRequestId||req.headers['x-request-id']||req.headers['idempotency-key']||'').trim();
  if(key){const known=all('runs').find(r=>r.clientRequestId===key);if(known)return res.status(200).json(known);const pending=inflight.get(key);if(pending)return res.status(200).json(await pending);}
  if(spec.agent)throw error('请从 Codex 桌面会话发送需求，面板不再启动 CLI Agent');
  if(!key)return res.status(201).json(await runner('/runs',spec));
  const task=(async()=>{const known=all('runs').find(r=>r.clientRequestId===key);if(known)return known;return runner('/runs',{...spec,clientRequestId:key});})();
  inflight.set(key,task);
  try{res.status(201).json(await task);}finally{inflight.delete(key);}
}));
app.post('/api/runs/:id/stop',asyncRoute(async(req,res)=>res.json(await runner(`/runs/${req.params.id}/stop`,{}))));
app.post('/api/runs/:id/retry',asyncRoute(async(req,res)=>{const prev=get('runs',req.params.id);if(!prev)throw error('原执行不存在',404);if(prev.agent)throw error('请打开原有 Codex 桌面会话继续工作');const spec={title:prev.title,projectId:prev.projectId,taskId:prev.taskId,cwd:prev.cwd,command:req.body.command??prev.command,agent:prev.agent,agentCommand:prev.agentCommand,prompt:req.body.prompt??prev.prompt,resumeId:prev.externalSessionId,executable:prev.executable,args:prev.args,kind:prev.kind,previousRunId:prev.id,clientRequestId:req.headers['x-request-id'],...(prev.workflowId?{workflowId:prev.workflowId}:{} )};if(prev.workflowId){const w=get('workflows',prev.workflowId);const latest=all('runs').filter(r=>r.workflowId===prev.workflowId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];if(w?.status==='failed'&&latest?.id===prev.id)update('workflows',w.id,{status:'running'});else throw error('只能继续失败的工作流');}res.status(201).json(await runner('/runs',spec));}));
app.get('/api/runs/:id/log',asyncRoute(async(req,res)=>{const r=get('runs',req.params.id)||get('sessions',req.params.id);if(!r)throw error('记录不存在',404);const file=path.join(DATA,'logs',`${req.params.id}.log`);const text=fs.existsSync(file)?await fsp.readFile(file,'utf8'):'';const offset=Math.max(0,Number(req.query.offset)||0);res.json({text:text.slice(offset),offset:text.length});}));
app.patch('/api/tasks/:id',(req,res)=>{const patch={};if(req.body.projectId){if(!get('projects',req.body.projectId))throw error('项目不存在');patch.projectId=req.body.projectId;for(const r of all('runs').filter(r=>r.taskId===req.params.id))update('runs',r.id,{projectId:patch.projectId});for(const a of all('artifacts').filter(a=>a.taskId===req.params.id))update('artifacts',a.id,{projectId:patch.projectId});}if(req.body.archived!=null)patch.archived=req.body.archived;res.json(update('tasks',req.params.id,patch));});
app.post('/api/terminals',asyncRoute(async(req,res)=>res.status(201).json(await runner('/terminals',{...req.body,clientRequestId:req.headers['x-request-id']}))));
app.post('/api/terminals/:id/close',asyncRoute(async(req,res)=>res.json(await runner(`/terminals/${req.params.id}/close`,{}))));
app.post('/api/workflows',asyncRoute(async(req,res)=>res.status(201).json(await runner('/workflows',{...req.body,clientRequestId:req.headers['x-request-id']}))));
app.get('/api/files',asyncRoute(async(req,res)=>{const p=get('projects',String(req.query.projectId));if(!p)throw error('项目不存在',404);res.json(await host.listFiles(p.directory,String(req.query.path||'')));}));
app.get('/api/files/text',asyncRoute(async(req,res)=>{const p=get('projects',String(req.query.projectId));if(!p)throw error('项目不存在',404);res.json(await host.readText(p.directory,String(req.query.path)));}));
app.put('/api/files/text',asyncRoute(async(req,res)=>{const p=get('projects',req.body.projectId);if(!p)throw error('项目不存在',404);res.json(await host.writeText(p.directory,req.body.path,req.body.content,req.body.version));}));
app.post('/api/files/folder',asyncRoute(async(req,res)=>{const p=get('projects',req.body.projectId);if(!p)throw error('项目不存在',404);await host.makeDirectory(p.directory,req.body.path);res.json({ok:true});}));
app.get('/api/files/download',asyncRoute(async(req,res)=>{const p=get('projects',String(req.query.projectId));if(!p)throw error('项目不存在',404);const info=await host.fileInfo(p.directory,String(req.query.path));res.download(info.absolutePath||info.path);}));
app.post('/api/files/upload',asyncRoute(async(req,res)=>{
  const p=get('projects',req.body.projectId);if(!p)throw error('项目不存在',404);
  const relative=String(req.body.path||'');if(!relative||path.isAbsolute(relative)||relative.split(/[\\/]/).includes('..'))throw error('文件路径无效');
  const uploadId=String(req.body.uploadId||'');if(!/^[\w-]+$/.test(uploadId))throw error('传输标识无效');
  const folder=path.join(DATA,'uploads');await fsp.mkdir(folder,{recursive:true});const temp=path.join(folder,uploadId);
  const metaFile=temp+'.json';const meta={projectId:p.id,path:relative};if(fs.existsSync(metaFile)&&JSON.stringify(JSON.parse(await fsp.readFile(metaFile,'utf8')))!==JSON.stringify(meta))throw error('传输对象不一致');
  await fsp.writeFile(metaFile,JSON.stringify(meta));const offset=fs.existsSync(temp)?(await fsp.stat(temp)).size:0;
  if(Number(req.body.offset)!==offset)return res.status(409).json({error:'请从已接收位置续传',offset});
  const chunk=Buffer.from(req.body.data||'','base64');await fsp.appendFile(temp,chunk);const next=offset+chunk.length;
  if(req.body.final){const parent=path.dirname(relative);if(parent!=='.')await host.makeDirectory(p.directory,parent);const candidate=path.resolve(p.directory,relative);const realRoot=await fsp.realpath(p.directory);const realParent=await fsp.realpath(path.dirname(candidate));if(!realParent.startsWith(realRoot+path.sep)&&realParent!==realRoot)throw error('路径越界',403);if(fs.existsSync(candidate)){const stat=await fsp.lstat(candidate);if(stat.isSymbolicLink())throw error('不允许覆盖符号链接',403);}await fsp.copyFile(temp,candidate);await fsp.unlink(temp);await fsp.unlink(metaFile);}
  res.json({offset:next,complete:!!req.body.final});
}));
app.get('/api/artifacts/:id/download',asyncRoute(async(req,res)=>{const a=get('artifacts',req.params.id);if(!a)throw error('成果不存在',404);if(!fs.existsSync(a.path))throw error('原文件已移动或不可用',410);res.download(a.path,a.name);}));
app.get('/api/artifacts/:id/preview',asyncRoute(async(req,res)=>{const a=get('artifacts',req.params.id);if(!a)throw error('成果不存在',404);if(!fs.existsSync(a.path))throw error('文件不可用',410);res.setHeader('Content-Security-Policy',"sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'");res.sendFile(a.path);}));
app.post('/api/services',(req,res)=>{if(req.body.url&&!/^https?:\/\//.test(req.body.url))throw error('服务地址需要 http:// 或 https://');res.status(201).json(put('services',{id:id(),name:req.body.name,url:req.body.url,projectId:req.body.projectId||'workspace',command:req.body.command||'',createdAt:now()}));});
// A localhost service needs its own tailnet endpoint when opened from a phone.
function tailscale(args){return new Promise((resolve,reject)=>{const binary=process.platform==='win32'?path.join(process.env.ProgramFiles||'C:/Program Files','Tailscale','tailscale.exe'):'tailscale';execFile(binary,args,{windowsHide:true,timeout:20000},(err,out)=>err?reject(error('私网入口创建失败：'+(err.stderr||err.message))):resolve(out));});}
app.post('/api/services/:id/access',asyncRoute(async(req,res)=>{
  const s=get('services',req.params.id);if(!s?.url)throw error('请先填写服务地址');
  const target=new URL(s.url);if(!['localhost','127.0.0.1','[::1]'].includes(target.hostname))return res.json({url:s.url});
  const status=JSON.parse(await tailscale(['status','--json']));const name=status.Self?.DNSName?.replace(/\.$/,'');
  if(status.BackendState!=='Running'||!name)throw error('请先连接 Tailscale');
  const used=all('services').map(v=>v.servePort).filter(Boolean);let port=s.servePort||8443;while(!s.servePort&&used.includes(port))port++;
  await tailscale(['serve','--bg',`--https=${port}`,s.url]);const url=`https://${name}:${port}/`;
  update('services',s.id,{servePort:port,mobileUrl:url});res.json({url});
}));
app.post('/api/services/:id/start',asyncRoute(async(req,res)=>{const s=get('services',req.params.id);if(!s)throw error('服务不存在',404);if(!s.command)throw error('此服务仅提供访问入口');const r=await runner('/runs',{title:`服务 · ${s.name}`,projectId:s.projectId,command:s.command,kind:'service'});res.json(update('services',s.id,{runId:r.id}));}));
app.post('/api/services/:id/stop',asyncRoute(async(req,res)=>{const s=get('services',req.params.id);if(!s?.runId)throw error('服务未由控制台启动');res.json(await runner(`/runs/${s.runId}/stop`,{}));}));
app.get('/api/services/:id/health',asyncRoute(async(req,res)=>{const s=get('services',req.params.id);if(!s?.url)throw error('没有服务地址');try{const r=await fetch(s.url,{signal:AbortSignal.timeout(4000)});res.json({online:r.ok,status:r.status});}catch(err){res.json({online:false,error:err.message});}}));
app.get('/api/backup',asyncRoute(async(_req,res)=>{const filename=`backup-${Date.now()}.sqlite`;const target=path.join(DATA,filename);db.exec(`VACUUM INTO '${target.replaceAll("'","''")}'`);res.download(target,filename,()=>{fs.unlink(target,()=>{});});}));
app.get('/api/connection-guide',asyncRoute(async(_req,res)=>res.json({tailscale:await host.connectionStatus(),serveCommand:'tailscale serve --bg http://127.0.0.1:8787',merge:'tun:\n  route-exclude-address:\n    - 100.64.0.0/10\n    - fd7a:115c:a1e0::/48\ndns:\n  fake-ip-filter:\n    - "+.ts.net"\n  nameserver-policy:\n    "+.ts.net": "100.100.100.100"',note:'合并到现有增强配置，保留原有设置。结合实际网卡与生效路由验证。'})));

async function sendMail(subject,text){const cfg=settings().email;if(!cfg?.host||!cfg?.to)throw error('请先配置邮件通知');const transport=nodemailer.createTransport({host:cfg.host,port:cfg.port,secure:cfg.secure,auth:{user:cfg.user,pass:cfg.password}});await transport.sendMail({from:cfg.user,to:cfg.to,subject:`[个人工作站] ${subject}`,text});}
const sent=new Set(all('events').map(e=>e.id));setInterval(async()=>{for(const e of all('events').filter(e=>!sent.has(e.id))){sent.add(e.id);if(settings().email&&['completed','failed'].includes(e.type))try{await sendMail(e.title,e.detail);update('events',e.id,{delivery:'accepted'});}catch(err){update('events',e.id,{delivery:'failed',deliveryError:err.message});}}},5000).unref();
setInterval(()=>{if(eventClients.size){const data=JSON.stringify({type:'snapshot',data:snapshot()});for(const ws of eventClients)if(ws.readyState===1)ws.send(data);}},1800).unref();
server.on('upgrade',(req,socket,head)=>{
  if(req.url.startsWith('/api/')){
    if(!authenticated(req)||!originOkay(req)){socket.destroy();return;}
    const terminalMatch=req.url.match(/^\/api\/terminal\/([\w-]+)$/);
    realtime.handleUpgrade(req,socket,head,ws=>{
      if(terminalMatch){const backend=new WebSocket(`ws://127.0.0.1:${RUNNER_PORT}/terminal/${terminalMatch[1]}`,{headers:{Authorization:`Bearer ${settings().workerToken}`}});backend.on('message',data=>{if(ws.readyState===1)ws.send(data.toString());});ws.on('message',data=>{if(backend.readyState===1)backend.send(data.toString());});backend.on('error',()=>ws.close());backend.on('close',()=>ws.close());ws.on('close',()=>backend.close());}
      else {eventClients.add(ws);ws.on('close',()=>eventClients.delete(ws));ws.send(JSON.stringify({type:'snapshot',data:snapshot()}));}
    });
  }else if(process.env.DEV==='1')proxy.ws(req,socket,head);else socket.destroy();
});
app.use('/app',express.static(path.join(ROOT,'dist/native'),{index:false}));
app.get('/app/{*path}',(_req,res)=>res.sendFile(path.join(ROOT,'dist/native/app.html')));
if(process.env.DEV==='1')app.use((req,res)=>proxy.web(req,res));else{app.use(express.static(path.join(ROOT,'dist/client')));app.get('/{*path}',(_req,res)=>res.sendFile(path.join(ROOT,'dist/client/index.html')));}
app.use((err,_req,res,_next)=>{console.error(err.message);res.status(err.status||500).json({error:err.message||'请求失败'});});
await ensureRunner();
server.listen(PORT,'127.0.0.1',()=>console.log(`个人工作站已启动 http://127.0.0.1:${PORT}`));
