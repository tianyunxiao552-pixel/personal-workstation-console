import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';

// Uses the desktop app's bundled local App Tools transport. No CLI/model process.
// This is a version-specific desktop connector; never expose arbitrary tool calls.
const ROOT=path.resolve(import.meta.dirname,'..');
const fail=(message,status=503)=>Object.assign(new Error(message),{status});
const allowed=new Set(['list_threads','read_thread','send_message_to_thread']);
const MAX_FRAME=8*1024*1024;
export function desktopStatus(status){
  if(typeof status==='string')return status;
  if(status?.activeFlags?.includes('waitingOnApproval'))return 'waitingForApproval';
  if(status?.activeFlags?.includes('waitingOnUserInput'))return 'waitingForUserInput';
  return status?.type||'unknown';
}

export function pipeRequest(pipe,method,params,{timeout=15000}={}){
  return new Promise((resolve,reject)=>{
    const socket=net.createConnection(pipe);const requestId=`workstation-${randomUUID()}`;let buffer=Buffer.alloc(0),settled=false;
    const done=(err,value)=>{if(settled)return;settled=true;clearTimeout(timer);socket.destroy();err?reject(err):resolve(value);};
    const timer=setTimeout(()=>done(fail('Codex 桌面接口响应超时，请查看桌面应用是否仍在运行')),timeout);
    socket.once('connect',()=>{const payload=Buffer.from(JSON.stringify({id:requestId,jsonrpc:'2.0',method,params}));const header=Buffer.alloc(4);header.writeUInt32LE(payload.length);socket.write(Buffer.concat([header,payload]));});
    socket.on('data',chunk=>{
      buffer=Buffer.concat([buffer,chunk]);
      while(buffer.length>=4){
        const length=buffer.readUInt32LE(0);if(length>MAX_FRAME)return done(fail('Codex 桌面接口返回的数据过大'));
        if(buffer.length<length+4)return;
        try{const response=JSON.parse(buffer.subarray(4,4+length));buffer=buffer.subarray(4+length);if(response.id!==requestId)continue;if(response.error)done(fail(response.error.message,502));else done(null,response.result);return;}catch(e){return done(fail('无法解析 Codex 桌面接口响应'));}
      }
    });
    socket.on('error',()=>done(fail('未连接 Codex 桌面应用，请先在电脑打开它')));
    socket.on('close',()=>{if(!settled)done(fail('Codex 桌面连接已断开'));});
  });
}

export class DesktopConnector{
  constructor({pipe,contextThreadId,request=pipeRequest,discover}={}){this.pipe=pipe;this.contextThreadId=contextThreadId;this.request=request;this.discover=discover;this.catalog=null;this.listCache=null;}
  async connect(){
    if(this.catalog&&this.pipe)return;
    if(!this.contextThreadId){try{const c=JSON.parse(await fs.readFile(path.join(ROOT,'desktop-bridge.json'),'utf8'));this.contextThreadId=c.contextThreadId;}catch{}}
    if(!this.contextThreadId)throw fail('桌面会话连接尚未配置');
    const candidates=[...new Set([this.pipe,process.env.CODEX_APP_TOOLS_PIPE_PATH,...await(this.discover?.()||discoverPipes())].filter(Boolean))];
    for(const pipe of candidates){try{const result=await this.request(pipe,'tools/list',{threadStartKind:'all'},{timeout:4000});if(!result.tools?.some(t=>t.name==='read_thread'))continue;this.pipe=pipe;this.catalog=new Map(result.tools.map(t=>[t.name,t]));return;}catch{}}
    throw fail('未连接 Codex 桌面应用，请先在电脑打开它');
  }
  async call(tool,args){
    if(!allowed.has(tool))throw fail('此桌面操作不在面板支持范围内',400);
    await this.connect();const descriptor=this.catalog.get(tool);if(!descriptor)throw fail('当前桌面版本尚未提供这项会话操作');
    let result;
    try{result=await this.request(this.pipe,'tools/call',{
      namespace:descriptor.namespace,tool,arguments:args,
      // Bind connector activity to the actual owning project conversation.
      callerSource:'codex',threadId:this.contextThreadId,
      callId:`workstation-${randomUUID()}`,turnId:`workstation-${randomUUID()}`
    },{timeout:tool==='send_message_to_thread'?45000:20000});}
    catch(e){this.catalog=null;throw e;}
    const text=(result.contentItems||[]).filter(x=>x.type==='inputText').map(x=>x.text).join('\n');
    if(!result.success)throw fail(text||'Codex 桌面拒绝了该操作',400);
    try{return JSON.parse(text);}catch{return{message:text};}
  }
  async threads({fresh=false}={}){
    if(!fresh&&this.listCache&&Date.now()-this.listCache.at<5000)return this.listCache.value;
    const data=await this.call('list_threads',{limit:50});const all=[...(data.pinnedThreads||[]),...(data.threads||[])];
    const seen=new Set();const threads=all.filter(t=>t.kind==='codex'&&!seen.has(t.id)&&seen.add(t.id)).map(t=>({...t,status:desktopStatus(t.status)}));
    const value={connected:true,contextThreadId:this.contextThreadId,threads};this.listCache={at:Date.now(),value};return value;
  }
  async known(id,hostId){const data=await this.threads();const thread=data.threads.find(t=>t.id===id&&(!hostId||t.hostId===hostId));if(!thread)throw fail('请先从列表选择已有的 Codex 桌面会话',404);return thread;}
  async read(id,hostId,cursor){
    const known=await this.known(id,hostId);const data=await this.call('read_thread',{threadId:id,hostId:known.hostId,turnLimit:3,includeOutputs:false,maxOutputCharsPerItem:2000,...(cursor?{cursor}:{})});
    const thread={...known,...data.thread,status:data.thread?.status?desktopStatus(data.thread.status):known.status};
    return{thread,page:data.page,turns:(data.turns||[]).map(t=>({id:t.id,status:t.status,startedAt:t.startedAt,completedAt:t.completedAt,items:(t.items||[]).filter(i=>['userMessage','agentMessage','commandExecution','mcpToolCall','webSearch','fileChange','plan'].includes(i.type)).slice(-100).map(sanitizeItem)}))};
  }
  async send(id,{hostId,prompt}){
    if(typeof prompt!=='string'||!prompt.trim())throw fail('请先描述你想让 AI 完成什么',400);
    if(prompt.length>100000)throw fail('内容过长，请分成几条需求发送',400);
    const thread=await this.known(id,hostId);
    // The user chooses the target and submits the text in the panel. No model override.
    const result=await this.call('send_message_to_thread',{threadId:id,hostId:thread.hostId,prompt});
    this.listCache=null;return{ok:true,...result};
  }
}
export function sanitizeItem(i){
  if(i.type==='userMessage')return{id:i.id,type:i.type,text:(i.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n')};
  if(i.type==='agentMessage')return{id:i.id,type:i.type,text:i.text||'',phase:i.phase};
  if(i.type==='commandExecution')return{id:i.id,type:i.type,command:i.command,status:i.status,exitCode:i.exitCode};
  if(i.type==='mcpToolCall')return{id:i.id,type:i.type,tool:`${i.server||''} · ${i.tool||''}`,status:i.status};
  return{id:i.id,type:i.type,status:i.status,text:i.query||i.summary||i.text||''};
}
async function discoverPipes(){
  if(process.platform!=='win32')return[];
  return new Promise(resolve=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',"Get-ChildItem '\\\\.\\pipe\\' -ErrorAction SilentlyContinue | Where-Object {$_.Name -like 'codex-app-tools-*'} | Select-Object -ExpandProperty Name"],{windowsHide:true,timeout:5000},(err,out)=>resolve(err?[]:out.trim().split(/\r?\n/).filter(Boolean).map(n=>'\\\\.\\pipe\\'+n))));
}
