import 'dotenv/config';
import { createWorkbench } from './app.js';
const host=process.env.HOST || '127.0.0.1',port=Number(process.env.PORT || 8797);
if(!['127.0.0.1','localhost','::1'].includes(host)) throw new Error('会议工作台 v1 仅支持本机监听，请将 HOST 设为 127.0.0.1');
const workbench=createWorkbench();
workbench.server.listen(port,host,()=>console.log(`会议工作台 http://${host}:${port}`));
let closing=false;
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,async()=>{if(closing)return;closing=true;await workbench.close();process.exit(0);});
