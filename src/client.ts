export interface Project { id:string;name:string;description:string;directory:string;color?:string;createdAt:string;archived?:boolean; }
export interface Task { id:string;title:string;projectId:string;kind:string;status:string;createdAt:string;latestRunId?:string;archived?:boolean; }
export interface Metric { epoch?:number;total?:number;loss?:number;accuracy?:number;time?:string; }
export interface Run { id:string;taskId:string;title:string;projectId:string;status:string;createdAt:string;startedAt?:string;finishedAt?:string;progress:number|null;command?:string;cwd?:string;agent?:string;prompt?:string;answer?:string;externalSessionId?:string;metrics:Metric[];error?:string;exitCode?:number;workflowId?:string;usage?:Record<string,number>;previousRunId?:string; }
export interface Session { id:string;title:string;projectId:string;status:string;kind:string;createdAt:string; }
export interface Artifact { id:string;name:string;projectId:string;runId:string;taskId:string;path:string;type:string;size:number;createdAt:string;archived?:boolean; }
export interface Service { id:string;name:string;projectId:string;url:string;command?:string;runId?:string; }
export interface ConsoleEvent { id:string;title:string;detail:string;type:string;taskId?:string;createdAt:string;read:boolean;delivery?:string; }
export interface Workflow { id:string;name:string;projectId:string;status:string;stepIndex:number;steps:{name:string;command:string}[];createdAt:string; }
export interface ConsoleState { projects:Project[];tasks:Task[];runs:Run[];sessions:Session[];artifacts:Artifact[];services:Service[];events:ConsoleEvent[];workflows:Workflow[]; }
export interface AgentInfo { id:string;installed:boolean;command:string; }
export interface Connections { desktop?:{connected:boolean;threads?:number;error?:string}; tailscale:{installed:boolean;online:boolean;ip?:string;hostname?:string;backendState?:string};agents:AgentInfo[];docker:{installed:boolean}; }
export const emptyState:ConsoleState={projects:[],tasks:[],runs:[],sessions:[],artifacts:[],services:[],events:[],workflows:[]};
const pendingRequests=new Map<string,string>();
export async function api<T=any>(route:string,method='GET',body?:unknown):Promise<T>{
  const key=`${method}:${route}:${body?JSON.stringify(body):''}`;const changing=method!=='GET';
  if(changing&&!pendingRequests.has(key))pendingRequests.set(key,crypto.randomUUID());
  const headers:Record<string,string>={};if(body)headers['Content-Type']='application/json';if(changing)headers['X-Request-Id']=pendingRequests.get(key)!;
  const response=await fetch(`/api${route}`,{method,headers,body:body?JSON.stringify(body):undefined});const data=await response.json();
  if(response.ok||response.status<500)pendingRequests.delete(key);
  if(!response.ok)throw Object.assign(new Error(data.error||'请求失败'),{status:response.status,...data});return data;
}
export const bytes=(n:number)=>{if(!Number.isFinite(n))return '—';if(n<1024)return `${n} B`;if(n<1024**2)return `${(n/1024).toFixed(0)} KB`;if(n<1024**3)return `${(n/1024**2).toFixed(1)} MB`;return `${(n/1024**3).toFixed(1)} GB`;};
export const time=(s:string)=>new Date(s).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});
export const statusText:Record<string,string>={queued:'排队中',starting:'启动中',running:'运行中',waiting:'等待回复',stopping:'正在停止',completed:'已完成',failed:'失败',cancelled:'已停止',unknown:'待核实',interrupted:'已中断',closed:'已关闭'};
export const active=(s:string)=>['queued','starting','running','stopping','waiting'].includes(s);
