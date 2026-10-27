import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {ApiClient,ServerController,DATA_TEST} from './helpers/backend-harness.mjs';

const ctl=new ServerController();const client=new ApiClient();let writes=0,pipeServer;const sockets=new Set();
const endpoint=process.platform==='win32'?`\\\\.\\pipe\\desktop-api-test-${randomUUID()}`:`/tmp/desktop-api-test-${randomUUID()}.sock`;
const directory=path.join(DATA_TEST,'desktop-workspace');
test('Desktop API forwards only to the existing desktop thread, with authenticated replay-safe sends and workspace uploads',async()=>{
  pipeServer=net.createServer(socket=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));let buffer=Buffer.alloc(0);
    socket.on('data',chunk=>{
      buffer=Buffer.concat([buffer,chunk]);if(buffer.length<4||buffer.length<4+buffer.readUInt32LE(0))return;
      const message=JSON.parse(buffer.subarray(4));const p=message.params;let result;
      if(message.method==='tools/list')result={tools:['list_threads','read_thread','send_message_to_thread'].map(name=>({name,namespace:'codex_app'}))};
      else{
        let data;
        if(p.tool==='list_threads')data={threads:[{id:'existing-desktop',kind:'codex',hostId:'local',title:'桌面已有会话',cwd:directory,status:'active'}]};
        if(p.tool==='read_thread')data={thread:{id:'existing-desktop',status:{type:'active',activeFlags:[]},cwd:directory},turns:[{id:'original-turn',status:'inProgress',items:[{id:'progress',type:'agentMessage',phase:'commentary',text:'正在继续原来的工作'}]}]};
        if(p.tool==='send_message_to_thread'){
          writes++;assert.equal(p.arguments.threadId,'existing-desktop');assert.equal(p.arguments.model,undefined);assert.equal(p.arguments.thinking,undefined);
          if(p.arguments.prompt==='denied'){result={success:false,contentItems:[{type:'inputText',text:'Desktop approval denied'}]};}
          else data={threadId:'existing-desktop',accepted:true};
        }
        result??={success:true,contentItems:[{type:'inputText',text:JSON.stringify(data)}]};
      }
      const body=Buffer.from(JSON.stringify({id:message.id,jsonrpc:'2.0',result}));const header=Buffer.alloc(4);header.writeUInt32LE(body.length);socket.write(Buffer.concat([header,body]));
    });
  });
  await new Promise(resolve=>pipeServer.listen(endpoint,resolve));ctl.extraEnv={CODEX_APP_TOOLS_PIPE_PATH:endpoint};await ctl.start({fresh:true});await fs.mkdir(directory,{recursive:true});
  const anon=new ApiClient();assert.equal((await anon.get('/api/desktop/threads')).status,401);
  await client.get('/api/session');const list=await client.get('/api/desktop/threads');assert.equal(list.status,200);assert.equal(list.json.threads[0].id,'existing-desktop');
  const detail=await client.get('/api/desktop/threads/existing-desktop');assert.equal(detail.json.thread.status,'active');assert.equal(detail.json.turns[0].id,'original-turn');assert.match(detail.json.turns[0].items[0].text,/原来的工作/);
  const body={prompt:'继续原会话并整理 workspace',hostId:'local'};const options={headers:{'x-request-id':'same-panel-send'}};
  const [a,b]=await Promise.all([client.post('/api/desktop/threads/existing-desktop/message',body,options),client.post('/api/desktop/threads/existing-desktop/message',body,options)]);
  assert.equal(a.status,200);assert.equal(b.status,200);assert.equal(writes,1);
  await ctl.stopServerOnly();await ctl.start();assert.equal((await client.post('/api/desktop/threads/existing-desktop/message',body,options)).status,200);assert.equal(writes,1,'重载面板后同一请求不会重复发给桌面');
  const denied=await client.post('/api/desktop/threads/existing-desktop/message',{prompt:'denied'},{headers:{'x-request-id':'denied-send'}});assert.equal(denied.status,400);
  const duplicate=await client.post('/api/desktop/threads/existing-desktop/message',{prompt:'denied'},{headers:{'x-request-id':'denied-send'}});assert.equal(duplicate.status,400);assert.equal(writes,2,'桌面拒绝后不会偷偷重发');
  const workspace=await client.post('/api/desktop/threads/existing-desktop/workspace',{});assert.equal(workspace.status,200);assert.equal(workspace.json.directory,directory);
  const uploaded=await client.post('/api/files/upload',{projectId:workspace.json.projectId,path:'uploads/notes.txt',uploadId:'desktop-upload',offset:0,data:Buffer.from('这份资料给原会话使用').toString('base64'),final:true});assert.equal(uploaded.status,200);
  assert.equal(await fs.readFile(path.join(directory,'uploads','notes.txt'),'utf8'),'这份资料给原会话使用');
  const cli=await client.post('/api/runs',{agent:'codex',prompt:'do not run'});assert.equal(cli.status,400);
});
after(async()=>{await ctl.stopAll();for(const socket of sockets)socket.destroy();if(pipeServer)await new Promise(resolve=>pipeServer.close(resolve));});
