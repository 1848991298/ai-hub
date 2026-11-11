import test from 'node:test';import assert from 'node:assert/strict';import {PORTALS,trusted,publicUrl,redact} from './portals.mjs';import {channel as xiaomiChannel} from './adapters/xiaomi.mjs';import {collect as vivo} from './adapters/vivo.mjs';
function fakePage(host,data,text='已上架 1.0.2 ISHO com.jryx.isho 已发布'){return {url:()=>`https://${host}/`,evaluate:async(fn,{path,params})=>{const v=data[path];if(!v)throw new Error('unexpected path');return typeof v==='function'?v(params):v;},goto:async()=>{},locator:()=>({filter:()=>({first:()=>({waitFor:async()=>{},innerText:async()=>text})})})};}
test('五个平台白名单，拒绝恶意后缀域名；链接和文本不带认证信息',()=>{assert.equal(Object.keys(PORTALS).length,5);assert.ok(trusted('honor','https://hnid-drcn.cloud.honor.com/CAS/'));assert.ok(!trusted('honor','https://honor.com.evil.example/'));assert.ok(!trusted('vivo','http://dev.vivo.com.cn/'));assert.equal(publicUrl('https://dev.mi.com/x?token=private'),'https://dev.mi.com/x');assert.ok(!redact('appKey\nnever-export\n正常内容').includes('never-export'));});
const miData={'/pltapi/uiue/myitems/listApp':[{packageName:'com.jryx.isho',appId:'2882303761520556760',namespaceValue:0}],'/pltapi/uiue/app/detailsPage':{packageName:'com.jryx.isho',appId:'2882303761520556760',onlineVersionSelling:true,onlineVersion:{appDetailsInfo:{summary:'已上架',versionName:'1.0.2',versionCode:25229}},releaseNewVersion:{appDetailsInfo:{summary:'未发布',versionName:'1.0.2',versionCode:0}}}};
test('小米线上与未提交草稿分开；草稿占位构建号 0 不冒充有效版本',async()=>{const v=xiaomiChannel(miData['/pltapi/uiue/app/detailsPage'],'2882303761520556760');assert.equal(v.live_code,25229);assert.equal(v.status,'not_submitted');assert.equal(v.pending_code,null);});
test('其他包名不绑定成 ISHO',async()=>{assert.throws(()=>xiaomiChannel({...miData['/pltapi/uiue/app/detailsPage'],packageName:'other'},'2882303761520556760'),/app_mismatch/);});
test('vivo 真实列表的明确零保留，累计下载数不混入每日首次下载',async()=>{const data={'/webapi/app/list-app':[{id:1,packageName:'com.jryx.isho'}],'/webapi/app/detail':{id:1,packageName:'com.jryx.isho',versionName:'1.0.2',versionCode:'25229'},'/webapi/app/app-online-version':{appStoreSale:1,versionName:'1.0.2'},'/webapi/data-service/table/v2':q=>({indexList:[{indexField:'increase_download',indexName:'首次下载'}],pageData:{pageCount:1,data:[{effect_date:q.endDate,increase_download:'0',accu_total_download_cnt:'900'}]}})};const v=await vivo({page:fakePage('dev.vivo.com.cn',data)});assert.equal(v.rows.metrics[0].downloads,0);assert.equal(v.rows.channels[0].status,'live');assert.equal(v.parts.reviews.state,'read_failed');});
import{encrypt,decrypt}from'./auth.mjs';import{randomBytes}from'node:crypto';
test('认证资料只保存密文，平台绑定防止错用会话',()=>{const key=randomBytes(32),value={provider:'vivo',storage:{cookies:[{value:'fixture-only-secret'}]},sessions:{}};const raw=encrypt(value,key,'vivo');assert.ok(!raw.includes('fixture-only-secret'));assert.deepEqual(decrypt(raw,key,'vivo'),value);assert.throws(()=>decrypt(raw,key,'xiaomi'));assert.throws(()=>decrypt(raw,randomBytes(32),'vivo'));});
import{confirmsAuthentication}from'./auth.mjs';import{collect as honor}from'./adapters/honor.mjs';
test('荣耀实名视图明确阻止业务同步，不报告为登录成功或已接通',async()=>{await assert.rejects(()=>honor({page:{url:()=> 'https://developer.honor.com/cn/verify'},context:{}}),/developer_unverified/);});
test('认证检查点只接受指定平台的授权响应，拒绝错误与外站响应',()=>{const good={code:'BE000000',data:{permissions:[],cards:[]}};assert.ok(confirmsAuthentication('honor','https://developer.honor.com/portal/card/userPermissions',good));assert.ok(!confirmsAuthentication('honor','https://evil.example/portal/card/userPermissions',good));assert.ok(!confirmsAuthentication('honor','https://developer.honor.com/portal/card/userPermissions',{...good,code:401}));});
import {captureSessions,watchAuthentication} from './auth.mjs';
test('同源多个标签合并会话键，统计页不能抹掉主控制台状态；其他源不采集',async()=>{const frame=(url,value)=>({url:()=>url,evaluate:async()=>value});const c={pages:()=>[{frames:()=>[frame('https://dev.mi.com/console',{fixtureAuth:'private-fixture',shared:'a'})]},{frames:()=>[frame('https://dev.mi.com/comment',{tracking:'b'}),frame('https://untrusted.example/',{other:'never'})]}]};assert.deepEqual(await captureSessions(c,'https://dev.mi.com'),{'https://dev.mi.com':{fixtureAuth:'private-fixture',shared:'a',tracking:'b'}});});
test('已确认会话保存后，结束采集不重新覆盖检查点',async()=>{let observer,saves=0;const c={on:(_,fn)=>{observer=fn;},off:()=>{}};const watcher=watchAuthentication(c,'fixture-root','vivo',async()=>{saves++;});await observer({url:()=> 'https://dev.vivo.com.cn/webapi/app/list-app',json:async()=>({code:0,data:[{packageName:'com.jryx.isho'}]})});await new Promise(r=>setTimeout(r,1100));assert.equal(saves,1);await watcher.finish();assert.equal(saves,1);});

import {result,finish} from './adapters/common.mjs';
import {collect as tencent} from './adapters/tencent.mjs';
test('应用宝 HTTP 200 的 code -7 是登录失败，不冒充应用不存在或部分成功',async()=>{
 const page={url:()=> 'https://app.open.qq.com/p/home',evaluate:async()=>({value:{code:-7,message:'type:business, code:-7, msg:request auth fail'},http_status:200})};
 const v=await tencent({page});assert.equal(v.state,'needs_login');assert.equal(v.parts.channels.reason,'authentication_failed');assert.equal(v.parts.channels.business_code,-7);assert.equal(v.parts.downloads.state,'needs_login');assert.deepEqual(v.rows,{channels:[],metrics:[],reviews:[]});
});
test('应用宝错误诊断隐藏链接和长标识，错误包名仍停止数据读取',async()=>{
 const denied=await tencent({page:{url:()=> 'https://app.open.qq.com/p/home',evaluate:async()=>({value:{code:403,message:'permission denied https://example.com/?token=fixture xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'},http_status:200})}});
 assert.equal(denied.state,'access_denied');assert.ok(!denied.parts.channels.detail.includes('token='));assert.ok(!denied.parts.channels.detail.includes('xxxxxxxx'));
 const mismatch=await tencent({page:{url:()=> 'https://app.open.qq.com/p/home',evaluate:async()=>({value:{app_id:'1112464281',package_name:'other'},http_status:200})}});
 assert.equal(mismatch.state,'app_not_found');assert.equal(mismatch.rows.channels.length,0);
});
test('零成功分项不能标记部分同步，登录失败给出重登录状态',()=>{
 const failed=result('tencent');failed.parts={channels:{state:'read_failed'},downloads:{state:'read_failed'},reviews:{state:'unsupported'}};
 assert.equal(finish(failed).state,'read_failed');
 failed.parts.channels={state:'needs_login'};assert.equal(finish(failed).state,'needs_login');
 failed.parts.channels={state:'ok'};assert.equal(finish(failed).state,'partial');
});
test('未接入的分项不降低已读分项的同步结果',()=>{
 const value=result('tencent');
 value.parts={channels:{state:'ok'},downloads:{state:'ok'},audit:{state:'unsupported'},reviews:{state:'unsupported'}};
 assert.equal(finish(value).state,'ready');
 value.parts.downloads={state:'read_failed'};
 assert.equal(finish(value).state,'partial');
 value.parts={reviews:{state:'unsupported'}};
 assert.equal(finish(value).state,'read_failed');
});

test('小米定时上架属于待发布，新版不能冒充当前线上版本',()=>{
 const d={packageName:'com.jryx.isho',appId:'123',onlineVersionSelling:true,onlineVersion:{appDetailsInfo:{summary:'已上架',versionName:'3.2',versionCode:312}},releaseNewVersion:{appDetailsInfo:{summary:'审核通过，定时上架',versionName:'3.3',versionCode:313}}};
 const v=xiaomiChannel(d,'123');assert.equal(v.status,'approved');assert.equal(v.live_version,'3.2');assert.equal(v.live_code,312);assert.equal(v.pending_version,'3.3');assert.equal(v.pending_code,313);assert.equal(v.reason,'审核通过，定时上架');
 assert.throws(()=>xiaomiChannel({...d,releaseNewVersion:{appDetailsInfo:{...d.releaseNewVersion.appDetailsInfo,summary:'fixture-unknown'}}},'123'),/unknown_status/);
});

test('小米人工审核中保留官方状态，区分构建号相同的线上与提审版本',()=>{
 const data={
  packageName:'com.jryx.isho',appId:'123',onlineVersionSelling:true,
  onlineVersion:{appDetailsInfo:{summary:'已上架',versionName:'3.2',versionCode:312}},
  releaseNewVersion:{appDetailsInfo:{summary:'人工审核中',versionName:'3.3',versionCode:312}},
 };
 const row=xiaomiChannel(data,'123');
 assert.equal(row.status,'reviewing');
 assert.equal(row.reason,'人工审核中');
 assert.equal(row.live_version,'3.2');
 assert.equal(row.pending_version,'3.3');
});

function honorContext(detailOverrides={}){
 const origin='https://developer.honor.com';
 const packageName='com.jryx.isho';
 const releaseId='1234567890123456789';
 const detailPath='/managecenter/opencards/app/openplatformApi/application/release/detail';
 const app={
  packageName,appId:'fixture-app',
  statusList:[
   {status:'231',versionName:'3.2',versionCode:311,createTime:'2026-01-01'},
   {status:'232',versionName:'3.3',versionCode:312,appReleaseId:releaseId,createTime:'2026-01-02'},
  ],
 };
 let observer,currentUrl=origin;
 const context={on:(_,fn)=>{observer=fn;},off:()=>{observer=null;}};
 const response=(path,value,request={})=>({
  url:()=>origin+path,request:()=>({method:()=>'POST',postDataJSON:()=>request,postData:()=>JSON.stringify(request)}),
  json:async()=>value,status:()=>200,ok:()=>true,
 });
 const detail={apkInfo:{packageName},releaseStatus:232,versionName:'3.3',versionCode:312,
  reviewComment:['请补充说明。\n参照 https://example.com/help?token=fixture-private'],...detailOverrides};
 const frame={
  url:()=>origin+'/managecenter/opencards/app/?t=fixture#/AppList?__lang=zh',
  goto:async url=>assert.equal(new URL(url).hash,'#/openplatform/appShelves/versionInformation?appReleaseId='+releaseId),
  evaluate:async(_,comments)=>comments.join('\n\n'),
 };
 const page={
  url:()=>currentUrl,frames:()=>[frame],
  async waitForResponse(predicate){
   assert.equal(predicate(response(detailPath,{},{appReleaseInfoId:'1'})),false);
   const matching=response(detailPath,{code:'0000',data:detail},{appReleaseInfoId:releaseId});
   assert.equal(predicate(matching),true);
   return matching;
  },
  async goto(url){
   currentUrl=url;
   if(url.endsWith('E00006')){
    await observer(response('/application/manage/v3/list',{code:'0000',data:{list:[app]}}));
   }else{
    await observer(response('/reportPortal/v2/queryFilterData',{data:[{key:packageName,appId:app.appId}]},{filterType:'androidapp-pkgname'}));
    await observer(response('/reportPortal/v2/queryComponentData',{
     data:{reportTableVo:{headList:[{key:'new_download',label:'新下载成功次数'}],values:[{date:'2026-01-02',new_download:7}]}},
    },{filters:[
     {fieldName:'app_pkg_name',fieldValue:packageName},
     {fieldName:'date',expression:'gte',fieldValue:'2026-01-01'},
     {fieldName:'date',expression:'lte',fieldValue:'2026-01-02'},
    ]}));
   }
  },
 };
 return {page,context};
}

test('荣耀绑定驳回详情到本次提审，保留线上版本和下载',async()=>{
 const data=await honor(honorContext());
 const [row]=data.rows.channels;
 assert.equal(row.status,'rejected');
 assert.equal(row.live_version,'3.2');
 assert.equal(row.pending_version,'3.3');
 assert.equal(row.reason,'请补充说明。\n参照 https://example.com/help');
 assert.equal(data.rows.metrics[0].downloads,7);
 assert.deepEqual(data.parts.audit,{state:'ok'});
 assert.equal(data.state,'ready');
});

test('荣耀详情版本或包名不符时保留已验证的驳回状态并标记详情失败',async()=>{
 for(const mismatched of [{versionName:'3.2'},{versionCode:311},{apkInfo:{packageName:'other'}}]){
  const data=await honor(honorContext(mismatched));
  assert.equal(data.rows.channels[0].status,'rejected');
  assert.equal(data.rows.channels[0].reason,'');
  assert.equal(data.rows.metrics[0].downloads,7);
  assert.deepEqual(data.parts.audit,{state:'read_failed'});
  assert.equal(data.state,'partial');
 }
});
