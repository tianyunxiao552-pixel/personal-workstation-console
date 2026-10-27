import type { ConsoleState } from './client';
const d=new Date().toISOString();
export const demoState:ConsoleState={
  projects:[{id:'demo-vision',name:'目标检测实验',description:'使用 YOLO 进行目标检测模型训练',directory:'示例 / projects / object-detection',color:'blue',createdAt:d},{id:'demo-site',name:'个人网站',description:'代码助手正在完善页面',directory:'示例 / projects / personal-site',color:'slate',createdAt:d}],
  tasks:[{id:'demo-train',title:'目标检测模型训练',projectId:'demo-vision',kind:'training',status:'running',createdAt:d,latestRunId:'demo-run-train'},{id:'demo-agent',title:'完善个人网站',projectId:'demo-site',kind:'agent',status:'running',createdAt:d,latestRunId:'demo-run-agent'},{id:'demo-question',title:'选择数据增强方案',projectId:'demo-vision',kind:'agent',status:'waiting',createdAt:d,latestRunId:'demo-run-question'}],
  runs:[{id:'demo-run-train',taskId:'demo-train',title:'目标检测模型训练',projectId:'demo-vision',status:'running',createdAt:d,startedAt:d,progress:42,command:'python train.py --epochs 100 --batch 16',cwd:'示例 / object-detection',metrics:Array.from({length:42},(_,i)=>({epoch:i+1,total:100,loss:Number((1.85*Math.exp(-i/10)+0.153).toFixed(3))}))},{id:'demo-run-agent',taskId:'demo-agent',title:'完善个人网站',projectId:'demo-site',status:'running',createdAt:d,progress:null,agent:'codex',prompt:'完善个人网站的响应式布局，并检查主要页面。',answer:'页面结构已完成，正在检查移动端布局与交互。',metrics:[]},{id:'demo-run-question',taskId:'demo-question',title:'选择数据增强方案',projectId:'demo-vision',status:'waiting',createdAt:d,progress:null,agent:'codex',prompt:'分析训练数据并推荐增强策略。',answer:'建议加入随机翻转与轻量色彩增强。是否继续使用这个方案？',metrics:[]}],
  sessions:[],artifacts:[{id:'demo-report',name:'评估报告.html',projectId:'demo-vision',runId:'demo-run-train',taskId:'demo-train',path:'outputs/report.html',size:24320,type:'html',createdAt:d}],
  services:[{id:'demo-tensorboard',name:'TensorBoard',projectId:'demo-vision',url:'',command:''},{id:'demo-preview',name:'网站预览',projectId:'demo-site',url:'',command:''}],
  events:[{id:'demo-event',title:'1 个问题等你回复',detail:'代码助手 · 数据增强方案',type:'waiting',taskId:'demo-question',createdAt:d,read:false}],
  workflows:[]
};
