import React, { useState } from 'react';
import { ArrowRight, CalendarDays, ChevronRight, Clock3 } from 'lucide-react';
import { categoryOf, canonicalStatus } from './ledger-model.js';
import { dueWeek } from './overview-model.js';
import './overview.css';

const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const dateLabel = day => new Date(day + 'T12:00:00Z').toLocaleDateString('zh-CN', {
  month: 'long', day: 'numeric', timeZone: 'UTC',
});

export default function OverviewSchedule({ ledger, today, navigate, children }) {
  const [chosen, choose] = useState('');
  const week = dueWeek(ledger, today);
  const selected = week.days.find(day => day.date === chosen) || week.days.find(day => day.date === today);
  const route = { kind: 'all', due: selected.date, archive: 'active' };
  const unavailable = !week.available;
  const stale = !unavailable && (ledger.error || ledger.authorization_required);
  const rows = selected.rows;

  return <>
    <section className="overview-week" aria-label="本周到期事项">
      <div className="overview-week-summary">
        <span><CalendarDays size={16}/>本周到期</span>
        <strong>{unavailable ? '—' : week.total}<small> 项</small></strong>
        <time>{dateLabel(week.days[0].date)} — {dateLabel(week.days.at(-1).date)}</time>
      </div>
      <div className="overview-week-days" role="group" aria-label="选择到期日期">
        {week.days.map((day, index) => {
          const label = day.date === today ? '今天' : weekdays[index];
          return <button type="button" key={day.date} onClick={() => choose(day.date)}
            aria-label={dateLabel(day.date) + '，' + (unavailable ? '待同步' : day.rows.length + ' 项到期')}
            aria-pressed={day.date === selected.date}>
            <span>{label}</span><strong>{Number(day.date.slice(-2))}</strong>
            <small>{unavailable ? '—' : day.rows.length + ' 项'}</small>
          </button>;
        })}
      </div>
    </section>
    <div className="overview-work">
      <section className="overview-agenda" aria-label="当天到期">
        <header><h2>{selected.date === today ? '今天' : dateLabel(selected.date)}到期</h2>
          <button className="text-button" type="button" onClick={() => navigate('ledger', route)}>查看台账<ArrowRight size={14}/></button>
        </header>
        {stale && <p className="overview-agenda-note" role="status">按最近一次同步的数据展示</p>}
        {rows.slice(0, 6).map(row => <button type="button" className="overview-agenda-row" key={row.kind + ':' + row.id}
          onClick={() => navigate('ledger', { ...route, inspect: row.kind + ':' + row.id })}>
          <span className="overview-agenda-title">
            <strong>{String(row.content || '').split(/\r?\n/).find(line => line.trim())?.trim() || '无标题'}</strong>
            <small>{[categoryOf(row), ...(row.tags || [])].join(' · ')}</small>
          </span>
          <span className="overview-agenda-status">{canonicalStatus(row.status)}</span><ChevronRight size={15} aria-hidden="true"/>
        </button>)}
        {!rows.length && <p className="overview-agenda-note">{unavailable ? ledger ? '尚未读到台账。' : '正在读取台账…' : '这一天没有到期事项。'}</p>}
        {rows.length > 6 && <button className="overview-agenda-more" type="button" onClick={() => navigate('ledger', route)}>
          查看全部 {rows.length} 项<ArrowRight size={14}/>
        </button>}
        {week.overdue > 0 && <button className="overview-agenda-more" type="button"
          onClick={() => navigate('ledger', { kind: 'all', archive: 'active', overdue: '1' })}>
          <Clock3 size={15}/>查看 {week.overdue} 项逾期<ArrowRight size={14}/>
        </button>}
      </section>
      <div className="overview-work-side">{children}</div>
    </div>
  </>;
}
