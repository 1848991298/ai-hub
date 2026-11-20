import React, {useState} from 'react';
import {ArrowDown, ArrowUp, ArrowUpRight, GripVertical, Save} from 'lucide-react';
import {moveItem} from './market-order.js';

export function ChannelSettings({stores, order, hidden, saving, onSave}) {
  const [draft, setDraft] = useState({order, hidden});
  const [dragged, setDragged] = useState(null);
  const [over, setOver] = useState(null);
  function move(from, to) {
    setDraft(current => ({...current, order: moveItem(current.order, from, to)}));
  }
  function toggle(id) {
    setDraft(current => ({...current, hidden: current.hidden.includes(id)
      ? current.hidden.filter(item => item !== id) : [...current.hidden, id]}));
  }

  return <form className="market-channel-settings" onSubmit={event => {
    event.preventDefault();
    onSave(draft);
  }}>
    <p className="market-caption">隐藏后，大盘、渠道筛选和批量同步会跳过此渠道。自动同步与历史记录保留。</p>
    <ul className="market-channel-settings-list">
      {draft.order.map((id, index) => <li key={id} onDragOver={event => {
        if (dragged && !saving) {event.preventDefault(); setOver(id);}
      }} onDrop={event => {
        event.preventDefault();
        if (dragged && !saving) move(dragged, id);
        setDragged(null);
        setOver(null);
      }} className={over === id && dragged !== id ? 'is-drop' : ''}>
        <span draggable={!saving} className="market-drag" title="拖动排序" onDragStart={event => {
          event.dataTransfer.setData('text/plain', id);
          event.dataTransfer.effectAllowed = 'move';
          setDragged(id);
        }} onDragEnd={() => {setDragged(null); setOver(null);}} aria-hidden="true">
          <GripVertical size={16}/>
        </span>
        <span className="market-channel-settings-name">{stores[id]}</span>
        <label className="market-visibility">
          <input type="checkbox" checked={!draft.hidden.includes(id)} disabled={saving}
            onChange={() => toggle(id)} aria-label={'显示 ' + stores[id]}/>
          <span>{draft.hidden.includes(id) ? '已隐藏' : '显示'}</span>
        </label>
        <div className="market-sort-actions">
          <button type="button" disabled={saving || index === 0} aria-label={'上移 ' + stores[id]}
            onClick={() => move(id, draft.order[index-1])}><ArrowUp size={15}/></button>
          <button type="button" disabled={saving || index === draft.order.length - 1} aria-label={'下移 ' + stores[id]}
            onClick={() => move(draft.order[index+1], id)}><ArrowDown size={15}/></button>
        </div>
      </li>)}
    </ul>
    <footer><span>显示 {draft.order.length - draft.hidden.length} / {draft.order.length} 个渠道</span>
      <button type="submit" disabled={saving} className="market-primary"><Save size={15}/>{saving?'保存中…':'保存设置'}</button>
    </footer>
  </form>;
}

export function HuaweiAuthorization({saving, onSave}) {
  return <form className="market-huawei-auth" onSubmit={event => {
    event.preventDefault();
    onSave(Object.fromEntries(new FormData(event.currentTarget)));
  }}>
    <p className="market-caption">使用中国站点 AppGallery Connect 的 API 客户端。通过 ISHO 应用绑定核对后，凭据保存在当前 Mac 的登录钥匙串。</p>
    <a href="https://developer.huawei.com/consumer/cn/service/josp/agc/index.html" target="_blank" rel="noreferrer">打开华为开发者后台<ArrowUpRight size={14}/></a>
    <fieldset className="market-form" disabled={saving}>
      <label>应用类型<select name="platform" defaultValue="harmony"><option value="harmony">HarmonyOS</option><option value="android">Android</option></select></label>
      <label>App ID<input name="app_id" required inputMode="numeric" pattern="[0-9]{1,32}" maxLength={32} autoComplete="off"/></label>
      <label>客户端 ID<input name="client_id" required maxLength={256} autoComplete="off"/></label>
      <label>客户端密钥<input name="client_secret" type="password" required maxLength={2048} autoComplete="off"/></label>
    </fieldset>
    <footer><span>授权后同步版本、下载和中国区评论</span>
      <button type="submit" disabled={saving} className="market-primary">{saving?'正在核验…':'验证并保存'}</button>
    </footer>
  </form>;
}
