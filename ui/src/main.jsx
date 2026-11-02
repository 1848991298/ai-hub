import React, {useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import MarketPage from './MarketPage.jsx';
import './connection.css';

async function connection(body) {
 const response=await fetch('/api/connection',body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});
 const value=await response.json();if(!response.ok)throw Error(value.error||'连接设置不可用');return value;
}
function Operations(){
 const [config,setConfig]=useState(null),[editing,setEditing]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[generation,setGeneration]=useState(0);
 const [form,setForm]=useState({url:'',username:'screen',password:''});
 useEffect(()=>{connection().then(setConfig).catch(e=>setError(e.message));},[]);
 function edit(){setForm({url:config?.url||'',username:config?.username||'screen',password:''});setError('');setEditing(true);}
 async function save(body){setBusy(true);setError('');try{setConfig(await connection(body));setGeneration(n=>n+1);setEditing(false);}catch(e){setError(e.message);}finally{setBusy(false);}}
 async function switchMode(mode){if(mode===config?.mode)return;if(mode==='shared'&&!config?.has_password){edit();return;}await save({mode});}
 return <main className={'operations '+(config?.mode==='shared'?'operations-shared':'')}>
  <header className="operations-connection"><div><strong>ISHO 运营大屏</strong><p>{config?.mode==='shared'?'使用服务器中的同一份数据；连接失败不会显示本机旧记录。':'数据和商店登录资料保存在本机，与其他电脑互不影响。'}</p></div><div className="operations-modes" role="group" aria-label="数据模式"><button disabled={busy||!config} aria-pressed={config?.mode==='local'} onClick={()=>switchMode('local')}>独立采集</button><button disabled={busy||!config} aria-pressed={config?.mode==='shared'} onClick={()=>switchMode('shared')}>共享服务器</button><button disabled={busy||!config} onClick={edit}>服务器设置</button></div></header>
  {error&&<p className="operations-error" role="alert">{error}</p>}
  {config?.mode==='shared'&&<p className="operations-shared-note">共享地址：{config.url} · {config.username==='screen'?'只读查看':'管理员'}；本机采集暂停。切换模式不会自动上传或覆盖两端数据。</p>}
  {config&&<MarketPage key={generation} standalone/>}
  {editing&&<div className="operations-backdrop"><form role="dialog" aria-modal="true" aria-label="共享服务器设置" onSubmit={e=>{e.preventDefault();save({mode:'shared',...form});}}><h2>共享服务器设置</h2><p>填写已部署的运营服务器地址和访问账号；这不是商店账号密码。</p><label>服务器地址<input required type="url" placeholder="https://ops.example.com" value={form.url} onChange={e=>setForm({...form,url:e.target.value})}/></label><label>访问账号<select value={form.username} onChange={e=>setForm({...form,username:e.target.value})}><option value="screen">screen（只读）</option><option value="admin">admin（管理）</option></select></label><label>访问密码<input type="password" autoComplete="off" placeholder={config?.has_password?'留空保留同一服务器的已存密码':'填写服务器分配的访问密码'} value={form.password} onChange={e=>setForm({...form,password:e.target.value})}/></label><small>服务器连接失败时会显示错误；本机数据保留。配置仅保存在本机忽略目录，不进入源码。</small>{error&&<p role="alert" className="operations-error">{error}</p>}<footer><button disabled={busy} type="button" onClick={()=>{setEditing(false);setError('');}}>取消</button><button disabled={busy} type="submit">{busy?'正在保存…':'保存并切换'}</button></footer></form></div>}
 </main>;
}
createRoot(document.getElementById('root')).render(<Operations/>);
