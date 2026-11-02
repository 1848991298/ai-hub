import {PACKAGE,today,result,finish,count,version,fail} from './common.mjs';
// 复用官方页面自动携带的授权，只监听固定的只读响应，不读取认证头。
export async function collect({page,context}){
 if(new URL(page.url()).pathname.startsWith('/cn/verify'))throw new Error('developer_unverified');
 const out=result('honor');let list,table,packages;
 const observer=async response=>{try{const u=new URL(response.url());if(u.origin!=='https://developer.honor.com')return;
  if(u.pathname.endsWith('/application/manage/v3/list')){const v=await response.json();if(v.code==='0000'&&Array.isArray(v.data?.list))list=v.data;}
  else if(u.pathname==='/reportPortal/v2/queryFilterData'){const req=JSON.parse(response.request().postData()||'{}');if(req.filterType==='androidapp-pkgname'){const v=await response.json();if(Array.isArray(v.data))packages=v.data;}}
  else if(u.pathname==='/reportPortal/v2/queryComponentData'){const req=JSON.parse(response.request().postData()||'{}');if(!req.filters?.some(f=>f.fieldName==='app_pkg_name'&&f.fieldValue===PACKAGE))return;const v=await response.json();if(v.data?.reportTableVo)table={data:v.data.reportTableVo,filters:req.filters};}
 }catch{}};
 context.on('response',observer);
 async function wait(test){const until=Date.now()+35000;while(!test()){if(new URL(page.url()).pathname.startsWith('/cn/verify'))throw new Error('developer_unverified');if(/login|loginAuth|hnid-/i.test(page.url()))throw new Error('needs_login');if(Date.now()>until)throw new Error('read_failed');await page.waitForTimeout(200);}}
 try{
  await page.goto('https://developer.honor.com/cn/manageCenter/app/E00006',{waitUntil:'domcontentloaded',timeout:35000});await wait(()=>list);
  const apps=list.list.filter(a=>a.packageName===PACKAGE);if(apps.length!==1)throw new Error('app_not_found');const app=apps[0];if(!Array.isArray(app.statusList))throw new Error('version_schema');
  try{
   const live=app.statusList.filter(v=>v.status==='231');if(live.length>1)throw new Error('multiple_live_versions');
   const current=[...app.statusList].sort((a,b)=>String(b.createTime).localeCompare(String(a.createTime)))[0];
   const labels={'231':'live','200':'reviewing'};const status=labels[current?.status];if(!status)throw new Error('unknown_status');
   out.rows.channels=[{channel:'honor',live_version:live[0]?version(live[0].versionName):'',live_code:live[0]?count(live[0].versionCode):null,pending_version:current.status==='231'?'':version(current.versionName),pending_code:current.status==='231'?null:count(current.versionCode),status,as_of:today(),reason:''}];out.parts.channels={state:'ok'};
  }catch(e){out.parts.channels=fail(e);}
  try{
   await page.goto('https://developer.honor.com/cn/manageCenter/app/E00112',{waitUntil:'domcontentloaded',timeout:35000});
   await wait(()=>table||page.frames().some(f=>f.url().includes('/report/entrance')));
   if(!table){const frame=page.frames().find(f=>f.url().includes('/report/entrance'));await frame.getByText('应用分发报表',{exact:true}).click({timeout:15000});await wait(()=>table);}
   await wait(()=>packages);
   const match=packages.filter(p=>p.key===PACKAGE);if(match.length!==1||String(match[0].appId)!==String(app.appId))throw new Error('package_mismatch');
   if(!Array.isArray(table.data.values)||!table.data.headList?.some(h=>h.key==='new_download'&&h.label==='新下载成功次数'))throw new Error('download_schema');
   const from=table.filters.find(f=>f.fieldName==='date'&&f.expression==='gte')?.fieldValue;const to=table.filters.find(f=>f.fieldName==='date'&&f.expression==='lte')?.fieldValue;if(!from||!to||to>today())throw new Error('range_schema');
   const rows=table.data.values;if(new Set(rows.map(r=>r.date)).size!==rows.length)throw new Error('duplicate_date');
   out.rows.metrics=rows.map(r=>{if(r.date<from||r.date>to)throw new Error('date_range');return {channel:'honor',date:r.date,downloads:count(r.new_download),source:'荣耀开发者后台 · 每日新下载成功次数（不含更新）'};});out.parts.downloads={state:'ok',count:rows.length,from,to};
  }catch(e){out.rows.metrics=[];out.parts.downloads=fail(e);}
  out.parts.reviews={state:'unsupported'};return finish(out);
 }finally{context.off('response',observer);}
}
