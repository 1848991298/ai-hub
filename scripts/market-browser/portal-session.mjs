// 维护者本机验证工具；复用本机加密会话，不接受网络端命令，不输出认证资料。
import {createRequire} from 'node:module';import {resolve,dirname,join} from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';import {mkdir,chmod} from 'node:fs/promises';import {createInterface} from 'node:readline';
import {PORTALS,trusted,publicUrl,redact} from './portals.mjs';
import {restoreAuth} from './auth.mjs';
const root=process.env.AI_HUB_ROOT||resolve(dirname(fileURLToPath(import.meta.url)),'../..');const {chromium}=createRequire(join(root,'.local/market-browser-runtime/package.json'))('playwright');
const contexts=new Map();const input=createInterface({input:process.stdin});
for(const provider of process.argv.slice(2)){
 if(!PORTALS[provider])throw new Error('unsupported provider');
 const profile=join(root,'.local/market-browser',provider);await mkdir(profile,{recursive:true,mode:0o700});await chmod(profile,0o700);
 try{const context=await chromium.launchPersistentContext(profile,{headless:false,viewport:null,acceptDownloads:false,args:['--start-maximized']});contexts.set(provider,context);await restoreAuth(context,root,provider).catch(()=>{});const p=context.pages()[0]||await context.newPage();await p.goto(PORTALS[provider].url,{waitUntil:'domcontentloaded',timeout:25000}).catch(()=>{});console.log(JSON.stringify({provider,state:'login_window_open',path:publicUrl(p.url())}));}catch{console.log(JSON.stringify({provider,state:'browser_unavailable'}));}
}
let busy=false;
input.on('line',async line=>{if(busy)return;busy=true;try{const [command,provider]=line.trim().split(' ');const context=contexts.get(provider);
 if(command==='status'){console.log(JSON.stringify({providers:await Promise.all([...contexts].map(async([id,c])=>({provider:id,pages:await Promise.all(c.pages().map(async p=>({path:publicUrl(p.url()),title:await p.title().catch(()=>'' )})))})))}));}
 else if(command==='inspect'&&context){console.log(JSON.stringify({provider,frames:await Promise.all(context.pages().at(-1).frames().filter(f=>trusted(provider,f.url())).map(async f=>({path:publicUrl(f.url()),text:redact(await f.locator('body').innerText().catch(()=>'' )).slice(0,8500)})))}));}
 else if(command==='run'&&context){const m=await import(pathToFileURL(join(root,'.local/portal-probe.mjs')).href+'?t='+Date.now());await m.default({provider,context,page:context.pages().at(-1),trusted,publicUrl,redact,root});}
 else if(command==='close'&&context){await context.close();contexts.delete(provider);if(!contexts.size){input.close();process.exit(0);}}
}catch{console.log(JSON.stringify({state:'operation_failed'}));}finally{busy=false;}});
process.on('SIGTERM',async()=>{await Promise.all([...contexts.values()].map(c=>c.close().catch(()=>{})));process.exit(0);});
