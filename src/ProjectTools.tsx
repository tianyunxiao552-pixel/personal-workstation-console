import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowClockwise, ArrowLeft, ArrowRight, CheckCircle, Code, DownloadSimple, FileText, Folder, FolderPlus, Plus, Robot, TerminalWindow, UploadSimple, WarningCircle } from '@phosphor-icons/react';
import { api, bytes, type Project, type ConsoleState, type Session } from './client';
import { BottomSheet, KeyboardInput, KeyboardTextarea, useKeyboard } from './mobile';
import './project-tools.css';
import {DesktopChats} from './DesktopChats';

export interface ProjectToolsProps {project:Project;state:ConsoleState;demo:boolean;onRefresh:()=>void;onToast:(message:string)=>void;onRun:(runId:string)=>void;initialTab?:'files'|'agent'|'terminal'|'artifacts'}
type Tab = NonNullable<ProjectToolsProps['initialTab']>;
interface FileEntry {name:string;path:string;type:'directory'|'file';size:number;modifiedAt:string}
interface TextFile {content:string;version:string;path:string;size:number}
const tabs = [{id:'files',label:'文件',icon:Folder},{id:'agent',label:'Agent',icon:Robot},{id:'terminal',label:'终端',icon:TerminalWindow},{id:'artifacts',label:'成果',icon:CheckCircle}] as const;
const date = (value:string) => new Date(value).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
const errorMessage = (error:unknown) => error instanceof Error ? error.message : '操作失败，请重试';
const childPath = (parent:string,name:string) => [parent,name].filter(Boolean).join('/');
const fileUrl = (projectId:string,path:string) => `/api/files/download?${new URLSearchParams({projectId,path})}`;
const sampleFiles:FileEntry[] = [
  {name:'src',path:'src',type:'directory',size:0,modifiedAt:'2026-10-25T09:00:00+08:00'},
  {name:'outputs',path:'outputs',type:'directory',size:0,modifiedAt:'2026-10-25T09:00:00+08:00'},
  {name:'README.md',path:'README.md',type:'file',size:1240,modifiedAt:'2026-10-25T09:00:00+08:00'},
  {name:'train.py',path:'train.py',type:'file',size:4680,modifiedAt:'2026-10-25T09:00:00+08:00'},
];

export default function ProjectTools({project,state,demo,onRefresh,onToast,onRun,initialTab='files'}:ProjectToolsProps) {
  const keyboard = useKeyboard();
  const [tab,setTab] = useState<Tab>(initialTab);
  const [path,setPath] = useState('');
  const [entries,setEntries] = useState<FileEntry[]>([]);
  const [filesLoading,setFilesLoading] = useState(false);
  const [fileError,setFileError] = useState('');
  const [reloadFiles,setReloadFiles] = useState(0);
  const [editor,setEditor] = useState<TextFile|null>(null);
  const [editorLoading,setEditorLoading] = useState(false);
  const [content,setContent] = useState('');
  const [saving,setSaving] = useState(false);
  const [conflict,setConflict] = useState(false);
  const [folderOpen,setFolderOpen] = useState(false);
  const [folderName,setFolderName] = useState('');
  const [creatingFolder,setCreatingFolder] = useState(false);
  const [upload,setUpload] = useState<{name:string;percent:number}|null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const uploadAlive = useRef(true);
  const [localSessions,setLocalSessions] = useState<Session[]>([]);
  const [sessionId,setSessionId] = useState<string|null>(null);
  const [creatingTerminal,setCreatingTerminal] = useState(false);
  const [terminalError,setTerminalError] = useState('');
  const [terminalStatus,setTerminalStatus] = useState<'idle'|'connecting'|'connected'|'disconnected'>('idle');
  const [reconnect,setReconnect] = useState(0);
  const [terminalInput,setTerminalInput] = useState('');
  const terminalEl = useRef<HTMLDivElement>(null);
  const socket = useRef<WebSocket|null>(null);
  const [closing,setClosing] = useState(false);
  const notice = () => onToast('切换到我的电脑后使用');

  useEffect(() => {
    setPath('');setEditor(null);setFolderOpen(false);setLocalSessions([]);setSessionId(null);setTerminalError('');
  },[project.id,demo]);
  useEffect(() => {keyboard.hide();setTab(initialTab);},[initialTab]);
  useEffect(() => {uploadAlive.current=true;return () => {uploadAlive.current=false;};},[]);
  useEffect(() => {
    let alive=true;
    setFileError('');
    if(demo){setEntries(path ? [{name:'example.txt',path:childPath(path,'example.txt'),type:'file',size:640,modifiedAt:'2026-10-25T09:00:00+08:00'}] : sampleFiles);setFilesLoading(false);return;}
    setFilesLoading(true);
    api<{entries:FileEntry[]}>(`/files?${new URLSearchParams({projectId:project.id,path})}`).then(result => {if(alive)setEntries(result.entries);}).catch(error => {if(alive){setEntries([]);setFileError(errorMessage(error));}}).finally(()=>{if(alive)setFilesLoading(false);});
    return () => {alive=false;};
  },[project.id,demo,path,reloadFiles]);
  const sessions=useMemo(()=>{
    const all=[...state.sessions.filter(item=>item.projectId===project.id),...localSessions.filter(item=>!state.sessions.some(session=>session.id===item.id))];
    return all.filter(item=>item.status!=='closed');
  },[state.sessions,project.id,localSessions]);

  useEffect(() => {
    if(tab!=='terminal'||demo||!sessionId||!terminalEl.current){setTerminalStatus('idle');return;}
    let disposed=false;
    let terminal:import('@xterm/xterm').Terminal|undefined;
    let observer:ResizeObserver|undefined;
    let ws:WebSocket|undefined;
    setTerminalError('');setTerminalStatus('connecting');
    const connect=async()=>{
      try{
        const [{Terminal},{FitAddon}]=await Promise.all([import('@xterm/xterm'),import('@xterm/addon-fit'),import('@xterm/xterm/css/xterm.css')]);
        if(disposed||!terminalEl.current)return;
        terminal=new Terminal({disableStdin:true,cursorBlink:false,convertEol:false,fontSize:12,fontFamily:'Consolas, monospace',theme:{background:'#101d36',foreground:'#dfe9ff',cursor:'#83a7ff'},scrollback:2000});
        const fit=new FitAddon();terminal.loadAddon(fit);terminal.open(terminalEl.current);fit.fit();
        ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/api/terminal/${encodeURIComponent(sessionId)}`);socket.current=ws;
        ws.onopen=()=>{if(disposed)return;setTerminalStatus('connected');fit.fit();ws?.send(JSON.stringify({type:'resize',cols:terminal!.cols,rows:terminal!.rows}));};
        ws.onmessage=event=>{if(!disposed)terminal?.write(typeof event.data==='string'?event.data:'');};
        ws.onerror=()=>{if(!disposed)setTerminalError('终端连接失败，请检查电脑端终端服务');};
        ws.onclose=()=>{if(!disposed){setTerminalStatus('disconnected');if(socket.current===ws)socket.current=null;}};
        observer=new ResizeObserver(()=>{if(disposed)return;fit.fit();if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'resize',cols:terminal!.cols,rows:terminal!.rows}));});
        observer.observe(terminalEl.current);
      }catch(error){if(!disposed){setTerminalStatus('disconnected');setTerminalError(errorMessage(error));}}
    };
    void connect();
    return ()=>{disposed=true;observer?.disconnect();if(ws){ws.onclose=null;ws.onmessage=null;ws.onerror=null;ws.onopen=null;ws.close();}if(socket.current===ws)socket.current=null;terminal?.dispose();};
  },[tab,demo,sessionId,reconnect]);

  const openFile=async(entry:FileEntry)=>{
    keyboard.hide();setConflict(false);
    if(entry.type==='directory'){setPath(entry.path);return;}
    if(demo){setEditor({path:entry.path,content:'# 示例项目\n\n这里是项目说明与文件内容。\n切换到我的电脑后，可编辑并保存电脑上的真实文件。',version:'demo',size:entry.size});setContent('# 示例项目\n\n这里是项目说明与文件内容。\n切换到我的电脑后，可编辑并保存电脑上的真实文件。');return;}
    setEditorLoading(true);setConflict(false);
    try{const result=await api<TextFile>(`/files/text?${new URLSearchParams({projectId:project.id,path:entry.path})}`);setEditor(result);setContent(result.content);}catch(error){onToast(errorMessage(error));}finally{setEditorLoading(false);}
  };
  const saveFile=async()=>{
    if(demo){notice();return;}if(!editor||saving)return;
    setSaving(true);
    try{const result=await api<TextFile>('/files/text','PUT',{projectId:project.id,path:editor.path,content,version:editor.version});setEditor({...editor,...result,content});setConflict(false);onToast('文件已保存');setReloadFiles(value=>value+1);}catch(error){if((error as {status?:number}).status===409){setConflict(true);onToast('文件在电脑端有更新，已保留你的编辑');}else onToast(errorMessage(error));}finally{setSaving(false);}
  };
  const createFolder=async()=>{
    if(demo){notice();return;}if(!folderName.trim()||creatingFolder)return;
    setCreatingFolder(true);
    try{await api('/files/folder','POST',{projectId:project.id,path:childPath(path,folderName.trim())});keyboard.hide();setFolderOpen(false);setFolderName('');setReloadFiles(value=>value+1);onToast('文件夹已创建');}catch(error){onToast(errorMessage(error));}finally{setCreatingFolder(false);}
  };
  const uploadFile=async(file:File)=>{
    if(demo){notice();return;}if(upload)return;
    const key=`ptools-upload:${project.id}:${path}:${file.name}:${file.size}:${file.lastModified}`;
    let record:{uploadId:string;offset:number}={uploadId:crypto.randomUUID(),offset:0};
    try{const saved=localStorage.getItem(key);if(saved)record=JSON.parse(saved);}catch{/* An unavailable local store does not prevent uploading. */}
    setUpload({name:file.name,percent:file.size?Math.round(record.offset/file.size*100):0});
    const target=childPath(path,file.name);
    try{
      let completed=false;
      while(!completed&&uploadAlive.current){
        const end=Math.min(file.size,record.offset+512*1024);
        const chunk=file.slice(record.offset,end);
        const data=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]||'');reader.onerror=()=>reject(new Error('读取文件失败'));reader.readAsDataURL(chunk);});
        try{
          const result=await api<{offset:number;complete:boolean}>('/files/upload','POST',{projectId:project.id,path:target,uploadId:record.uploadId,offset:record.offset,data,final:end===file.size});
          record.offset=result.offset;completed=result.complete;
          if(!completed&&result.offset===end&&end===file.size)throw new Error('上传尚未完成，请重新选择此文件续传');
        }catch(error){
          const conflictError=error as {status?:number;offset?:number};
          if(conflictError.status===409&&typeof conflictError.offset==='number'&&conflictError.offset!==record.offset){record.offset=conflictError.offset;}else throw error;
        }
        try{localStorage.setItem(key,JSON.stringify(record));}catch{/* Progress remains valid in this open page. */}
        if(uploadAlive.current)setUpload({name:file.name,percent:file.size?Math.min(100,Math.round(record.offset/file.size*100)):100});
      }
      if(completed){try{localStorage.removeItem(key);}catch{}if(uploadAlive.current){setReloadFiles(value=>value+1);onToast('上传完成');}}
    }catch(error){if(uploadAlive.current)onToast(`${errorMessage(error)}；重新选择同一文件可续传`);}finally{if(uploadAlive.current)setUpload(null);if(uploadInput.current)uploadInput.current.value='';}
  };
  const createTerminal=async()=>{
    if(demo){notice();return;}if(creatingTerminal)return;setCreatingTerminal(true);setTerminalError('');
    try{const session=await api<Session>('/terminals','POST',{projectId:project.id});setLocalSessions(current=>[...current,session]);setSessionId(session.id);onRefresh();}catch(error){setTerminalError(errorMessage(error));}finally{setCreatingTerminal(false);}
  };
  const sendTerminal=(data:string)=>{
    if(demo){notice();return;}if(socket.current?.readyState!==WebSocket.OPEN){onToast('终端已断开，请先重连');return;}socket.current.send(JSON.stringify({type:'input',data}));
  };
  const closeTerminal=async()=>{
    if(demo){notice();return;}if(!sessionId||closing)return;setClosing(true);
    try{await api(`/terminals/${encodeURIComponent(sessionId)}/close`,'POST',{});setLocalSessions(current=>current.filter(item=>item.id!==sessionId));setSessionId(null);onRefresh();}catch(error){onToast(errorMessage(error));}finally{setClosing(false);}
  };
  const renderFiles=()=> <>
    <div className="ptools-section-heading"><div><h3>项目文件</h3><p>直接查看与编辑电脑上的文件</p></div><div className="ptools-actions"><button aria-label="新建文件夹" onClick={()=>{if(demo){notice();return;}setFolderName('');setFolderOpen(true);}}><FolderPlus size={20}/></button><button aria-label="上传文件" disabled={!!upload} onClick={()=>demo?notice():uploadInput.current?.click()}><UploadSimple size={20}/></button><button aria-label="刷新文件" onClick={()=>setReloadFiles(value=>value+1)}><ArrowClockwise size={18}/></button></div></div>
    <input ref={uploadInput} type="file" hidden onChange={event=>{const file=event.target.files?.[0];if(file)void uploadFile(file);}}/>
    <div className="ptools-breadcrumb"><button onClick={()=>setPath('')}>{project.name}</button>{path.split('/').filter(Boolean).map((name,index,array)=><span key={index}><span className="ptools-slash">/</span><button onClick={()=>setPath(array.slice(0,index+1).join('/'))}>{name}</button></span>)}</div>
    {upload&&<div className="ptools-upload"><div><UploadSimple size={16}/><span>{upload.name}</span><b>{upload.percent}%</b></div><progress value={upload.percent} max={100}/><p>保持此页面打开。中断后重选同一文件可续传。</p></div>}
    {fileError&&<div className="ptools-error"><WarningCircle size={18}/><span>{fileError}</span><button onClick={()=>setReloadFiles(value=>value+1)}>重试</button></div>}
    {path&&<button className="ptools-file-row ptools-parent" onClick={()=>setPath(path.split('/').slice(0,-1).join('/'))}><ArrowLeft size={20}/><span>返回上一级</span></button>}
    {filesLoading?<div className="ptools-empty">正在读取文件…</div>:entries.length? <div className="ptools-file-list">{entries.map(entry=><div className="ptools-file-row" key={entry.path}><button className="ptools-file-main" onClick={()=>void openFile(entry)} disabled={editorLoading}><span className={`ptools-file-icon ${entry.type==='directory'?'ptools-folder':''}`}>{entry.type==='directory'?<Folder size={23} weight="fill"/>:<FileText size={22}/>}</span><span className="ptools-file-info"><strong>{entry.name}</strong><small>{entry.type==='directory'?'文件夹':bytes(entry.size)}<span>·</span>{date(entry.modifiedAt)}</small></span></button>{entry.type==='file'?<button className="ptools-icon" aria-label={`下载 ${entry.name}`} onClick={()=>demo?notice():window.open(fileUrl(project.id,entry.path),'_blank','noopener,noreferrer')}><DownloadSimple size={19}/></button>:<ArrowRight size={17} className="ptools-muted"/>}</div>)}</div>:!fileError&&<div className="ptools-empty"><Folder size={34}/><h4>文件夹还是空的</h4><p>上传文件或创建一个文件夹开始工作。</p></div>}
  </>;
  const renderAgent=()=>demo?<div className="ptools-empty"><Robot size={36}/><h4>Codex 桌面会话</h4><p>切换到我的电脑，就能选择原有会话、查看进度并继续发需求。</p></div>:<DesktopChats projectDirectory={project.directory} onToast={onToast}/>;
  const renderTerminal=()=> <>
    <div className="ptools-section-heading"><div><h3>项目终端</h3><p>连接电脑上的真实交互会话</p></div><button className="ptools-small-button" disabled={creatingTerminal} onClick={()=>void createTerminal()}><Plus size={16}/>{creatingTerminal?'创建中':'新建'}</button></div>
    {sessions.length>0&&<div className="ptools-session-list">{sessions.map(session=><button key={session.id} className={sessionId===session.id?'ptools-selected':''} onClick={()=>{keyboard.hide();setSessionId(session.id);}}><TerminalWindow size={15}/>{session.title||'终端'}<span className="ptools-session-dot"/></button>)}</div>}
    {terminalError&&<div className="ptools-error"><WarningCircle size={18}/><span>{terminalError}</span></div>}
    {demo?<div className="ptools-terminal-demo"><div><span>示例终端 · 只读</span><span>DEMO</span></div><pre><span>$ pwd</span>{'\n~/projects/research-lab\n\n'}<span>$ python train.py --epochs 50</span>{'\n[示例输出] Epoch 50/50  loss: 0.024\n[示例输出] 结果保存到 outputs/\n\n'}<span>这里展示终端样式，未运行真实命令。</span></pre></div>:sessionId?<><div className="ptools-terminal-top"><span><i className={terminalStatus==='connected'?'ptools-connected':''}/>{terminalStatus==='connected'?'已连接':terminalStatus==='connecting'?'连接中':'已断开'}</span><div><button onClick={()=>setReconnect(value=>value+1)} aria-label="重连终端"><ArrowClockwise size={16}/></button><button disabled={closing} onClick={()=>void closeTerminal()}>{closing?'关闭中':'关闭会话'}</button></div></div><div ref={terminalEl} className="ptools-terminal"/><div className="ptools-terminal-keys">{[{label:'Ctrl C',data:'\x03'},{label:'Tab',data:'\t'},{label:'↑',data:'\x1b[A'},{label:'↓',data:'\x1b[B'},{label:'Esc',data:'\x1b'},{label:'Ctrl D',data:'\x04'}].map(key=><button key={key.label} onClick={()=>sendTerminal(key.data)}>{key.label}</button>)}</div><form className="ptools-terminal-input" onSubmit={event=>{event.preventDefault();sendTerminal(`${terminalInput}\r`);setTerminalInput('');}}><span>❯</span><KeyboardInput onBlur={()=>keyboard.hide()} aria-label="终端命令" autoCapitalize="off" autoCorrect="off" spellCheck={false} value={terminalInput} onChange={event=>setTerminalInput(event.target.value)} placeholder="输入命令并回车"/><button aria-label="发送到终端" type="submit"><ArrowRight size={20}/></button></form></>:<div className="ptools-empty"><TerminalWindow size={37}/><h4>继续电脑上的工作</h4><p>选择已有终端，或创建一个新会话。<br/>连接断开后可重新连接同一会话。</p><button className="ptools-primary" disabled={creatingTerminal} onClick={()=>void createTerminal()}><Plus size={17}/>新建终端</button></div>}
    {demo&&<button className="ptools-small-button ptools-demo-terminal-button" onClick={notice}>连接我的电脑 <ArrowRight size={16}/></button>}
  </>;
  const renderArtifacts=()=>{
    const artifacts=state.artifacts.filter(item=>item.projectId===project.id&&!item.archived);
    return <><div className="ptools-section-heading"><div><h3>项目成果</h3><p>运行产出的文件，随时预览和下载</p></div><span className="ptools-count">{artifacts.length}</span></div>{artifacts.length?<div className="ptools-artifacts">{artifacts.map(item=><article key={item.id}><span className="ptools-artifact-icon"><FileText size={25}/></span><div><h4>{item.name}</h4><p>{item.type.toUpperCase()} <span>·</span> {bytes(item.size)} <span>·</span> {date(item.createdAt)}</p><button className="ptools-artifact-source" onClick={()=>demo?notice():onRun(item.runId)}>来源：{state.runs.find(run=>run.id===item.runId)?.title||'运行记录'} <ArrowRight size={12}/></button><div className="ptools-artifact-actions"><button onClick={()=>demo?notice():window.open(`/api/artifacts/${encodeURIComponent(item.id)}/preview`,'_blank','noopener,noreferrer')}>预览 <ArrowRight size={14}/></button><button onClick={()=>demo?notice():window.open(`/api/artifacts/${encodeURIComponent(item.id)}/download`,'_blank','noopener,noreferrer')}><DownloadSimple size={15}/>下载</button></div></div></article>)}</div>:demo?<div className="ptools-artifacts"><article><span className="ptools-artifact-icon"><FileText size={25}/></span><div><h4>experiment-summary.pdf</h4><p>PDF · 246 KB · 示例成果</p><p>来源：训练结果分析（示例）</p><div className="ptools-artifact-actions"><button onClick={notice}>预览 <ArrowRight size={14}/></button><button onClick={notice}><DownloadSimple size={15}/>下载</button></div></div></article></div>:<div className="ptools-empty"><CheckCircle size={37}/><h4>成果会出现在这里</h4><p>运行任务后，收集生成的报告、图片和文件。</p></div>}</>;
  };
  return <div className="ptools">
    <nav className="ptools-tabs" aria-label="项目工具">{tabs.map(item=><button key={item.id} aria-current={tab===item.id?'page':undefined} className={tab===item.id?'ptools-active':''} onClick={()=>{keyboard.hide();setTab(item.id);}}><item.icon size={19} weight={tab===item.id?'fill':'regular'}/>{item.label}</button>)}</nav>
    {demo&&<div className="ptools-demo"><span>示例内容</span>连接我的电脑后，可操作真实项目</div>}
    <div className="ptools-body">{tab==='files'?renderFiles():tab==='agent'?renderAgent():tab==='terminal'?renderTerminal():renderArtifacts()}</div>
    <BottomSheet open={!!editor} onOpenChange={open=>{if(!open){keyboard.hide();setEditor(null);setConflict(false);}}} title={editor?.path.split('/').pop()||'编辑文件'} description={demo?'示例内容 · 连接电脑后可保存':'文本编辑 · 保存时检查文件版本'} snap={0.88}><div className="ptools ptools-editor">{conflict&&<div className="ptools-error"><WarningCircle size={18}/><span>电脑上的文件已更新。你的编辑已保留，可先复制内容；重新读取会放弃当前编辑。</span></div>}<KeyboardTextarea onBlur={()=>keyboard.hide()} aria-label="文件内容" className="ptools-code-editor" value={content} onChange={event=>setContent(event.target.value)} spellCheck={false}/><div className="ptools-editor-footer"><button className="ptools-small-button" onClick={()=>{keyboard.hide();setEditor(null);setConflict(false);}}>关闭</button>{conflict&&<button className="ptools-small-button" onClick={()=>{if(editor)void openFile({name:'',path:editor.path,type:'file',size:editor.size,modifiedAt:''});}}>重新读取</button>}<button className="ptools-primary" disabled={saving||conflict} onClick={()=>void saveFile()}>{saving?'保存中':'保存文件'}</button></div></div></BottomSheet>
    <BottomSheet open={folderOpen} onOpenChange={open=>{if(!open)keyboard.hide();setFolderOpen(open);}} title="新建文件夹" description={`创建位置：${path||'项目根目录'}`} snap={0.48}><div className="ptools ptools-folder-form"><label htmlFor="ptools-folder-name">文件夹名称</label><KeyboardInput onBlur={()=>keyboard.hide()} id="ptools-folder-name" placeholder="例如 datasets" value={folderName} onChange={event=>setFolderName(event.target.value)} onKeyDown={event=>{if(event.key==='Enter')void createFolder();}}/><button className="ptools-primary" disabled={!folderName.trim()||creatingFolder} onClick={()=>void createFolder()}>{creatingFolder?'创建中':'创建文件夹'}</button></div></BottomSheet>
  </div>;
}
