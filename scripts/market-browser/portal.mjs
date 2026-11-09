// 未配置适配器的平台只建立独立登录窗口，绝不冒充数据同步成功。
import {createRequire} from 'node:module';import {resolve,dirname,join} from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';import {mkdir,chmod,access} from 'node:fs/promises';
import {PORTALS,trusted} from './portals.mjs';
import {profile} from './profile.mjs';
import {restoreAuth,saveAuth,watchAuthentication} from './auth.mjs';
const root=process.env.AI_HUB_ROOT||resolve(dirname(fileURLToPath(import.meta.url)),'../..');const provider=process.argv[2];if(!PORTALS[provider]||provider==='oppo')throw new Error('unsupported provider');
const {chromium}=createRequire(join(root,'.local/market-browser-runtime/package.json'))('playwright');
const login=process.argv.includes('--login');let context,authWatch;const output={provider,package:'com.jryx.isho',state:'needs_adapter',rows:{channels:[],metrics:[],reviews:[]},parts:{}};
try{
 const directory=await profile(root,provider);
 try{context=await chromium.launchPersistentContext(directory,{headless:!login,viewport:{width:1440,height:1000},acceptDownloads:false});}catch{throw new Error('profile_busy');}
 try{await restoreAuth(context,root,provider);}catch(e){if(!login)throw e;}
 authWatch=watchAuthentication(context,root,provider);
 const page=context.pages()[0]||await context.newPage();await page.goto(provider==='xiaomi'&&!login?'https://dev.mi.com/xiaomihyperos/console/app-manage/mobile':PORTALS[provider].url,{waitUntil:'domcontentloaded',timeout:30000});
 let adapter;let available=true;try{await access(join(root,'scripts/market-browser/adapters',provider+'.mjs'));}catch{available=false;}if(available)adapter=await import(pathToFileURL(join(root,'scripts/market-browser/adapters',provider+'.mjs')).href);
 if(login){
  for(const label of ['登录/注册','登录','管理中心']){const target=page.getByText(label,{exact:true}).filter({visible:true});if(await target.count()===1){await target.click({timeout:10000});break;}}
 }
 if(adapter){
  const deadline=Date.now()+(login?12*60*60*1000:0);
  let settled=false;
  while(true){
   if(login&&Date.now()<deadline&&(new URL(page.url()).origin!==new URL(PORTALS[provider].url).origin||/\/login(?:[/?]|$)/i.test(new URL(page.url()).pathname))){settled=false;await page.waitForTimeout(1000);continue;}
   if(login&&new URL(page.url()).pathname.startsWith('/cn/verify')){output.state='developer_unverified';if(!output.auth_saved){await saveAuth(context,root,provider);output.auth_saved=true;}if(Date.now()>deadline)throw new Error('developer_unverified');await page.waitForTimeout(1000);continue;}
   if(login&&!settled){await page.waitForTimeout(4000);settled=true;}
   try{const v=await adapter.collect({page,context,provider,root});Object.assign(output,v);if(login&&v.state==='needs_login'&&!Object.values(v.parts||{}).some(p=>p.state==='ok')&&Date.now()<deadline&&!page.isClosed()){await page.waitForTimeout(3000);continue;}if(Object.values(v.parts||{}).some(p=>p.state==='ok')&&!Object.values(v.parts||{}).some(p=>p.state==='needs_login'))await saveAuth(context,root,provider);break;}
   catch(e){
    if(!login||Date.now()>deadline||page.isClosed())throw e;
    // 登录完成但团队初始化或业务页查询暂未就绪时保留窗口，避免让用户重复登录。
    try{for(const p of context.pages()){let confirmed=false;for(const f of p.frames()){if(new URL(f.url()).origin!==new URL(PORTALS[provider].url).origin)continue;if((await f.locator('body').innerText({timeout:1000})).includes('com.jryx.isho')){confirmed=true;break;}}if(confirmed){await saveAuth(context,root,provider);output.auth_saved=true;break;}}}catch{}
    await page.waitForTimeout(5000);
   }
  }
 }else if(login){
  // 完成登录后仍需按 ISHO 包名绑定并核实只读字段，窗口可由用户自行关闭。
  await new Promise(resolve=>{context.once('close',resolve);const t=setTimeout(resolve,12*60*60*1000);t.unref();});output.state='needs_login';
 }
}catch(e){output.state=output.state==='developer_unverified'?'developer_unverified':['needs_login','profile_busy','app_not_found','access_denied','developer_unverified','auth_restore_failed','auth_key_unavailable'].find(s=>e.message.includes(s))||'read_failed';
 // 业务查询中断时，若官方页面已明确显示目标包名，先保住刚完成的登录；不据此标记业务同步成功。
 if(login&&context&&output.state==='read_failed')try{for(const p of context.pages()){let confirmed=false;for(const f of p.frames()){if(new URL(f.url()).origin!==new URL(PORTALS[provider].url).origin)continue;if((await f.locator('body').innerText({timeout:2000})).includes('com.jryx.isho')){confirmed=true;break;}}if(confirmed){await saveAuth(context,root,provider);output.auth_saved=true;break;}}}catch{}
}
finally{if(authWatch)await authWatch.finish().catch(()=>{});if(context)await context.close().catch(()=>{});}
console.log(JSON.stringify(output));
