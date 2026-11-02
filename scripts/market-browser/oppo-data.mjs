// 只保留运营字段，不保存后台响应、账号、认证信息或测试账号。
export const APP_ID='37892440', PACKAGE='com.jryx.isho';
export function requireApp(row){if(String(row.app_id??row.appId)!==APP_ID)throw new Error('app_mismatch');}
export function channels(info,versions,today){
 requireApp(info);if(typeof info.version_name!=='string'||!info.version_name.trim()||!/^\d+$/.test(String(info.version_code))||!/^\d+$/.test(String(info.version_id)))throw new Error('version_schema');if(info.pkg_name!==PACKAGE)throw new Error('package_mismatch');
 const labels={'审核不通过':'rejected','审核中':'reviewing','审核通过':'approved','待审核':'reviewing','已下架':'offline','未提交':'not_submitted'};
 const live=versions.filter(r=>r.version_state==='上架');for(const r of versions)requireApp(r);
 if(live.length>1)throw new Error('multiple_live_versions');
 const currentLive=live[0];const same=currentLive&&String(currentLive.version_id)===String(info.version_id);
 const status=same?'live':labels[info.audit_status_name];if(!status)throw new Error('unknown_audit_status');
 const r={channel:'oppo',status,as_of:today,pending_version:same?'':String(info.version_name),pending_code:same?null:info.version_code,submitted_at:(versions.find(v=>String(v.version_id)===String(info.version_id))?.create_time||'').slice(0,10),reason:status==='rejected'?(info.refuse_reason_with_sugg||[]).map(x=>x.reason).join('\n'):''};
 // 版本历史当前“上架”记录才作为线上版本；无记录时清空，不能沿用旧版本冒充仍在线。
 r.live_version=currentLive?.version_name||'';r.live_code=currentLive?.version_code??null;
 r.released_at=(currentLive?.online_time||'').slice(0,10);if(r.released_at.startsWith('0000'))r.released_at='';
 return r;
}
export function downloads(rows){return rows.map(r=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(r.dt)||!/^\d+$/.test(String(r.pure_dl)))throw new Error('invalid_download_row');return {channel:'oppo',date:r.dt,downloads:Number(r.pure_dl),source:'OPPO 开发者后台 · 每日净下载量（不含更新下载）'};});}
export function reviews(rows){return rows.map(r=>{requireApp(r);if(typeof r.ID!=='string'||!/^\d+$/.test(r.ID))throw new Error('invalid_review_id');return {channel:'oppo',external_id:r.ID,date:r.CREATE_TIME.slice(0,10),rating:r.USER_GRADE,body:String(r.PM_WORD||'').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[邮箱已隐藏]').replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g,'[手机号已隐藏]'),version:'',source:'OPPO 开发者后台 · 用户评论'};});}
