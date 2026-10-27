import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowClockwise, ArrowUp, ChatCircleDots, CheckCircle, CircleNotch, FolderOpen, Paperclip, TerminalWindow, WarningCircle, X } from '@phosphor-icons/react';
import { api } from './client';
import { KeyboardTextarea, useKeyboard } from './mobile';
import './desktop-chats.css';

interface DesktopThread { id:string; title:string; status:string; cwd?:string; hostId?:string; updatedAt?:number|string; summary?:string; }
interface DesktopItem { id:string; type:string; text?:string; phase?:string; command?:string; status?:string; tool?:string; }
interface DesktopTurn { id:string; status:string; items:DesktopItem[]; }
interface ThreadList { connected:boolean; contextThreadId?:string; threads:DesktopThread[]; }
interface ThreadDetail { thread:DesktopThread; turns:DesktopTurn[]; page?:{hasMore?:boolean}; }
interface UploadRecord { uploadId:string; offset:number; }
interface Attachment { path:string; threadId:string; }
export interface DesktopChatsProps { initialPrompt?:string; projectDirectory?:string; onToast:(message:string)=>void; compact?:boolean; }

const statuses:Record<string,string>={active:'正在工作',inProgress:'正在工作',running:'正在工作',waiting:'等你回复',waitingForApproval:'等待确认',waitingForUserInput:'等你回复',idle:'可以继续',completed:'已完成',notLoaded:'可以继续',interrupted:'已中断',error:'需要关注',failed:'需要关注'};
const working=(status:string)=>['active','inProgress','running'].includes(status);
const normalizePath=(value?:string)=>value?.replace(/\\/g,'/').replace(/\/$/,'').toLowerCase();
const keyOf=(thread?:DesktopThread|null)=>thread?`${thread.hostId||'local'}:${thread.id}`:'';
const draftKey=(thread?:DesktopThread|null)=>`wc-desktop-draft:v1:${keyOf(thread)}`;
function readStored<T>(key:string,fallback:T):T {try{const value=localStorage.getItem(key);return value?JSON.parse(value):fallback;}catch{return fallback;}}
function storeValue(key:string,value:unknown){try{localStorage.setItem(key,JSON.stringify(value));}catch{/* The open composer remains usable without browser storage. */}}
const errorMessage=(error:unknown)=>error instanceof Error?error.message:'暂时无法连接 Codex 桌面应用';
function chunkBase64(chunk:Blob){return new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]||'');reader.onerror=()=>reject(new Error('读取上传文件失败'));reader.readAsDataURL(chunk);});}

export function DesktopChats({initialPrompt='',projectDirectory,onToast,compact=false}:DesktopChatsProps){
  const keyboard=useKeyboard();
  const [threads,setThreads]=useState<DesktopThread[]>([]),[selected,setSelected]=useState<DesktopThread|null>(null);
  const [connected,setConnected]=useState(false),[loaded,setLoaded]=useState(false),[listError,setListError]=useState('');
  const [detail,setDetail]=useState<ThreadDetail|null>(null),[detailError,setDetailError]=useState(''),[reading,setReading]=useState(false);
  const [draft,setDraft]=useState(''),[sending,setSending]=useState(false),[refresh,setRefresh]=useState(0);
  const [upload,setUpload]=useState<{name:string;percent:number}|null>(null),[attachments,setAttachments]=useState<Attachment[]>([]);
  const input=useRef<HTMLInputElement>(null),alive=useRef(true),sendingRef=useRef(false),readInFlight=useRef(false),initialUsed=useRef(false);
  const selectedRef=useRef<DesktopThread|null>(null);selectedRef.current=selected;
  const onToastRef=useRef(onToast);onToastRef.current=onToast;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);

  useEffect(()=>{
    let disposed=false;let timer:ReturnType<typeof setTimeout>;
    const load=async()=>{
      try{
        const result=await api<ThreadList>('/desktop/threads');if(disposed)return;
        setThreads(result.threads);setConnected(result.connected);setListError('');setLoaded(true);
        setSelected(current=>{
          if(current)return result.threads.find(t=>keyOf(t)===keyOf(current))||current;
          const saved=readStored<{id:string;hostId?:string}|null>('wc-desktop-selected:v1',null);
          return result.threads.find(t=>saved&&t.id===saved.id&&(t.hostId||'local')===(saved.hostId||'local'))
            ||result.threads.find(t=>projectDirectory&&normalizePath(t.cwd)===normalizePath(projectDirectory))
            ||result.threads.find(t=>t.id===result.contextThreadId)||result.threads[0]||null;
        });
      }catch(error){if(!disposed){setConnected(false);setLoaded(true);setListError(errorMessage(error));}}
      finally{if(!disposed)timer=setTimeout(load,20000);}
    };
    void load();return()=>{disposed=true;clearTimeout(timer);};
  },[projectDirectory,refresh]);

  const selectedKey=keyOf(selected);
  useEffect(()=>{
    if(!selected)return;
    storeValue('wc-desktop-selected:v1',{id:selected.id,hostId:selected.hostId});
    const saved=readStored<string>(draftKey(selected),'');
    const next=!initialUsed.current&&initialPrompt?initialPrompt:saved;
    initialUsed.current=true;setDraft(next);storeValue(draftKey(selected),next);
    setDetail(null);setDetailError('');
  },[selectedKey,initialPrompt]);

  useEffect(()=>{
    if(!selected)return;
    let disposed=false;let timer:ReturnType<typeof setTimeout>;
    const thread=selected;
    const load=async()=>{
      if(readInFlight.current){if(!disposed)timer=setTimeout(load,500);return;}
      readInFlight.current=true;if(!disposed)setReading(true);
      try{
        const query=new URLSearchParams();if(thread.hostId)query.set('hostId',thread.hostId);
        const result=await api<ThreadDetail>(`/desktop/threads/${encodeURIComponent(thread.id)}?${query}`);
        if(!disposed){setDetail(result);setDetailError('');}
      }catch(error){if(!disposed)setDetailError(errorMessage(error));}
      finally{readInFlight.current=false;if(!disposed){setReading(false);timer=setTimeout(load,4000);}}
    };
    void load();return()=>{disposed=true;clearTimeout(timer);};
  },[selectedKey,refresh]);

  const activeThread=detail?.thread||selected;
  const items=useMemo(()=>detail?.turns.slice().reverse().flatMap(turn=>turn.items.map(item=>({...item,turnStatus:turn.status}))).slice(compact?-6:-90)||[],[detail,compact]);
  const files=attachments.filter(file=>file.threadId===selected?.id);
  const setText=(value:string)=>{setDraft(value);if(selected)storeValue(draftKey(selected),value);};
  const selectThread=(value:string)=>{keyboard.hide();setSelected(threads.find(thread=>keyOf(thread)===value)||null);};

  const send=async()=>{
    if(!selected||!draft.trim()||sendingRef.current||upload||!connected||detailError)return;
    sendingRef.current=true;setSending(true);keyboard.hide();
    const thread=selected;const text=draft.trim();
    const prompt=files.length?`${text}\n\n本次上传的文件位于当前 workspace：\n${files.map(file=>`- ${file.path}`).join('\n')}`:text;
    const sendKey=`wc-desktop-send:v1:${keyOf(thread)}`;const previous=readStored<{prompt:string;requestId:string}|null>(sendKey,null);
    const clientRequestId=previous?.prompt===prompt?previous.requestId:crypto.randomUUID();storeValue(sendKey,{prompt,requestId:clientRequestId});
    try{
      await api(`/desktop/threads/${encodeURIComponent(thread.id)}/message`,'POST',{prompt,hostId:thread.hostId,clientRequestId});
      try{localStorage.removeItem(sendKey);}catch{}storeValue(draftKey(thread),'');
      if(alive.current){setText('');setAttachments(current=>current.filter(file=>file.threadId!==thread.id));setRefresh(value=>value+1);onToastRef.current('已发送到原 Codex 会话');}
    }catch(error){if((error as {status?:number}).status===400){try{localStorage.removeItem(sendKey);}catch{}}if(alive.current)onToastRef.current(`${errorMessage(error)}；文字已保留，请查看会话确认发送结果`);}
    finally{sendingRef.current=false;if(alive.current)setSending(false);}
  };

  const uploadFile=async(file:File)=>{
    if(!selected||upload||sendingRef.current)return;
    const thread=selected;const key=`wc-desktop-upload:v1:${keyOf(thread)}:${file.name}:${file.size}:${file.lastModified}`;
    const record=readStored<UploadRecord>(key,{uploadId:crypto.randomUUID(),offset:0});
    const target=`uploads/${file.name}`;setUpload({name:file.name,percent:file.size?Math.round(record.offset/file.size*100):0});
    try{
      const workspace=await api<{projectId:string;directory:string}>(`/desktop/threads/${encodeURIComponent(thread.id)}/workspace`,'POST',{hostId:thread.hostId});
      let complete=false;
      while(!complete&&alive.current){
        const end=Math.min(file.size,record.offset+512*1024);const data=await chunkBase64(file.slice(record.offset,end));
        try{
          const result=await api<{offset:number;complete:boolean}>('/files/upload','POST',{projectId:workspace.projectId,path:target,uploadId:record.uploadId,offset:record.offset,data,final:end===file.size});
          record.offset=result.offset;complete=result.complete;
        }catch(error){const conflict=error as {status?:number;offset?:number};if(conflict.status===409&&typeof conflict.offset==='number'&&conflict.offset!==record.offset)record.offset=conflict.offset;else throw error;}
        storeValue(key,record);if(alive.current)setUpload({name:file.name,percent:file.size?Math.min(100,Math.round(record.offset/file.size*100)):100});
      }
      if(complete){try{localStorage.removeItem(key);}catch{}if(alive.current){setAttachments(current=>[...current.filter(entry=>!(entry.threadId===thread.id&&entry.path===target)),{threadId:thread.id,path:target}]);onToastRef.current('已上传到这段会话的 workspace');}}
    }catch(error){if(alive.current)onToastRef.current(`${errorMessage(error)}；重新选择同一文件可继续上传`);}
    finally{if(alive.current)setUpload(null);if(input.current)input.current.value='';}
  };

  return <section className={`desktop-chats ${compact?'desktop-chats-compact':''}`} aria-label="Codex 桌面会话">
    <div className="dc-heading"><div className="dc-avatar"><ChatCircleDots size={23}/></div><div className="dc-grow"><h3>接着电脑上的工作</h3><p>原会话 · 原模型 · 原 workspace</p></div><button type="button" className="dc-icon" aria-label="刷新桌面会话" disabled={sending||!!upload} onClick={()=>{keyboard.hide();setRefresh(value=>value+1);}}><ArrowClockwise size={19} className={reading?'dc-spin':''}/></button></div>
    <label className="dc-thread-label">正在使用的会话<select aria-label="选择 Codex 桌面会话" disabled={!threads.length||sending||!!upload} value={selectedKey} onChange={event=>selectThread(event.target.value)}>{!threads.length&&<option value="">{loaded?'暂无可用会话':'正在连接桌面应用…'}</option>}{threads.map(thread=><option key={keyOf(thread)} value={keyOf(thread)}>{thread.title||'未命名会话'}{working(thread.status)?' · 正在工作':''}</option>)}</select></label>
    {(listError||detailError)&&<div className="dc-error" role="status"><WarningCircle size={18}/><div><strong>暂时无法读取桌面会话</strong><p>{listError||detailError}</p><small>请保持电脑上的 Codex 桌面应用打开，稍后会自动重连。</small></div></div>}
    {loaded&&!threads.length&&!listError&&<div className="dc-empty"><ChatCircleDots size={30}/><h4>先在电脑打开一段 Codex 会话</h4><p>这里会显示已有会话，手机可以继续发消息。</p></div>}
    {selected&&<>
      <div className="dc-session-meta"><span className={`dc-status ${working(activeThread?.status||'')?'dc-working':''}`}><i/>{detailError||!connected?'连接暂不可用':statuses[activeThread?.status||'']||'状态待确认'}</span><span>{detailError?'保留上次读取内容':reading?'正在同步':'自动同步'}</span></div>
      {activeThread?.cwd&&<div className="dc-workspace"><FolderOpen size={16}/><span title={activeThread.cwd}>{activeThread.cwd}</span></div>}
      <div className="dc-timeline" aria-label="会话进度">
        {!detail&&!detailError&&<div className="dc-loading"><CircleNotch className="dc-spin" size={18}/>读取会话进度…</div>}
        {detail&&!items.length&&<div className="dc-empty"><p>这段会话还没有可显示的消息，直接说你想做什么。</p></div>}
        {detail?.page?.hasMore&&<p className="dc-history-note">显示最近的会话记录</p>}
        {items.map(item=>{
          if(item.type==='userMessage'||item.type==='agentMessage')return <article className={`dc-message ${item.type==='userMessage'?'dc-user':'dc-agent'} ${item.phase==='commentary'?'dc-commentary':''}`} key={item.id}><span className="dc-message-role">{item.type==='userMessage'?'你':item.phase==='commentary'?'Codex · 进度':'Codex'}</span><div>{item.text||'（这条消息没有文本内容）'}</div></article>;
          return <details className="dc-tool" key={item.id}><summary><TerminalWindow size={15}/><span>{item.tool||({commandExecution:'执行操作',mcpToolCall:'使用工具',fileChange:'修改文件',webSearch:'查找资料'} as Record<string,string>)[item.type]||'工作记录'}</span><small>{statuses[item.status||'']||item.status||''}</small></summary>{(item.command||item.text)&&<pre>{item.command||item.text}</pre>}</details>;
        })}
      </div>
      <form className="dc-composer" onSubmit={event=>{event.preventDefault();void send();}}>
        {files.length>0&&<div className="dc-attachments">{files.map(file=><span key={file.path}><CheckCircle size={14}/><span>{file.path}</span><button type="button" aria-label={`从本次消息移除 ${file.path}`} disabled={sending} onClick={()=>setAttachments(current=>current.filter(entry=>entry!==file))}><X size={12}/></button></span>)}</div>}
        <KeyboardTextarea aria-label="对 Codex 说你的需求" rows={compact?3:4} placeholder="直接说你想做什么，例如：接着刚才的工作继续，完成后告诉我结果…" value={draft} onChange={event=>setText(event.target.value)} onBlur={()=>keyboard.hide()} disabled={sending}/>
        {upload&&<div className="dc-upload-progress" role="status"><span>{upload.name}</span><b>{upload.percent}%</b><progress max={100} value={upload.percent}/></div>}
        <div className="dc-composer-actions"><input type="file" hidden ref={input} onChange={event=>{const file=event.target.files?.[0];if(file)void uploadFile(file);}}/><button type="button" className="dc-upload" disabled={!connected||sending||!!upload||!!detailError} onClick={()=>{keyboard.hide();input.current?.click();}}><Paperclip size={18}/><span>上传资料</span></button><button className="dc-send" type="submit" disabled={!draft.trim()||!connected||sending||!!upload||!!detailError}>{sending?<CircleNotch size={18} className="dc-spin"/>:<ArrowUp size={18}/>}<span>{sending?'发送中':'发送给 Codex'}</span></button></div>
      </form>
      <p className="dc-footnote">资料上传到这段会话的 workspace。直接说需求，Codex 会继续原来的工作。</p>
    </>}
  </section>;
}
