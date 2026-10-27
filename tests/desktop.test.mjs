import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {DesktopConnector,pipeRequest,desktopStatus,sanitizeItem} from '../server/desktop.mjs';

function fixture(){
  const calls=[];const tools=['list_threads','read_thread','send_message_to_thread'].map(name=>({name,namespace:'codex_app'}));
  const request=async(pipe,method,params)=>{
    calls.push({pipe,method,params});if(method==='tools/list')return{tools};
    let data;if(params.tool==='list_threads')data={pinnedThreads:[{id:'existing',hostId:'local',kind:'codex',title:'已有桌面会话',cwd:'D:/test',status:'active'}],threads:[{id:'existing',kind:'codex'},{id:'cloud',kind:'chatgpt'}]};
    if(params.tool==='read_thread')data={thread:{id:'existing',status:{type:'active',activeFlags:['waitingOnApproval']}},turns:[{id:'turn-existing',status:'inProgress',items:[{id:'user',type:'userMessage',content:[{type:'text',text:'继续完成原来的工作'}]},{id:'tool',type:'mcpToolCall',server:'filesystem',tool:'read',arguments:{secret:'never-forward'}},{id:'reasoning',type:'reasoning',content:['not-visible']},{id:'reply',type:'agentMessage',text:'正在处理',phase:'commentary'}]}]};
    if(params.tool==='send_message_to_thread')data={threadId:'existing',message:'sent'};
    return{success:true,contentItems:[{type:'inputText',text:JSON.stringify(data)}]};
  };
  return{client:new DesktopConnector({pipe:'fixture',contextThreadId:'real-owning-context',request,discover:async()=>[]}),calls};
}
test('Lists existing desktop threads, preserving identity and removing duplicate/cloud entries',async()=>{
  const {client}=fixture();const result=await client.threads();assert.deepEqual(result.threads.map(t=>t.id),['existing']);assert.equal(result.contextThreadId,'real-owning-context');
});
test('Reads current turn progress and user/agent text without hidden reasoning or tool arguments',async()=>{
  const {client,calls}=fixture();const result=await client.read('existing','local');assert.equal(result.thread.status,'waitingForApproval');assert.equal(result.turns[0].id,'turn-existing');assert.equal(result.turns[0].items[0].text,'继续完成原来的工作');assert.ok(!JSON.stringify(result).includes('never-forward'));assert.ok(!JSON.stringify(result).includes('not-visible'));assert.equal(calls.at(-1).params.arguments.includeOutputs,false);
});
test('Natural language is appended to the selected desktop thread without CLI or model override',async()=>{
  const {client,calls}=fixture();assert.equal((await client.send('existing',{prompt:'整理 workspace 里的报告',hostId:'local'})).ok,true);
  const call=calls.at(-1);assert.equal(call.params.tool,'send_message_to_thread');assert.deepEqual(call.params.arguments,{threadId:'existing',hostId:'local',prompt:'整理 workspace 里的报告'});assert.equal(call.params.threadId,'real-owning-context');
});
test('Rejects unknown targets, empty prompts, and tools outside the narrow allowlist',async()=>{
  const {client}=fixture();await assert.rejects(()=>client.send('unknown',{prompt:'continue'}),/从列表选择/);await assert.rejects(()=>client.send('existing',{prompt:' '}),/描述/);await assert.rejects(()=>client.call('delete_thread',{}),/支持范围/);
});
test('Desktop tool denial propagates, without bypass or automatic resending',async()=>{
  const {client}=fixture();await client.threads();let writes=0;const original=client.request;client.request=async(...args)=>{if(args[2]?.tool==='send_message_to_thread'){writes++;return{success:false,contentItems:[{type:'inputText',text:'Desktop approval required'}]};}return original(...args);};await assert.rejects(()=>client.send('existing',{prompt:'continue'}),/approval required/);assert.equal(writes,1);
});
test('Waiting states retain actual desktop semantics',()=>{
  assert.equal(desktopStatus({type:'active',activeFlags:['waitingOnUserInput']}),'waitingForUserInput');assert.equal(desktopStatus('notLoaded'),'notLoaded');assert.equal(sanitizeItem({type:'commandExecution',command:'python train.py',status:'inProgress',output:'private output'}).output,undefined);
});
test('Native framing handles split headers and payloads',async()=>{
  const endpoint=process.platform==='win32'?`\\\\.\\pipe\\workstation-test-${randomUUID()}`:`/tmp/workstation-test-${randomUUID()}.sock`;
  const server=net.createServer(socket=>socket.once('data',input=>{const request=JSON.parse(input.subarray(4));const data=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{ok:true}}));const header=Buffer.alloc(4);header.writeUInt32LE(data.length);socket.write(header.subarray(0,2));setImmediate(()=>socket.end(Buffer.concat([header.subarray(2),data])));}));
  await new Promise(resolve=>server.listen(endpoint,resolve));try{assert.deepEqual(await pipeRequest(endpoint,'tools/list',{}, {timeout:1000}),{ok:true});}finally{await new Promise(resolve=>server.close(resolve));}
});
