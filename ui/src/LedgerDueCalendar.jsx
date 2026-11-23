import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';

const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
const daySteps = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
const dateLabel = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'long', timeZone: 'UTC' });

function dateKey(day) {
  const year = day.getUTCFullYear();
  return year >= 1 && year <= 9999 ? day.toISOString().slice(0, 10) : '';
}

function readDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const day = new Date(value + 'T00:00:00Z');
  return dateKey(day) === value ? day : null;
}

function moveDays(day, offset) {
  const target = new Date(day);
  target.setUTCDate(target.getUTCDate() + offset);
  return target;
}

function moveMonths(day, offset) {
  const target = new Date(day);
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + offset + 1, 0);
  target.setUTCDate(Math.min(day.getUTCDate(), target.getUTCDate()));
  return target;
}

const weekday = day => (day.getUTCDay() + 6) % 7;

export default function LedgerDueCalendar({ current, today, onSave }) {
  const titleId = useId();
  const grid = useRef(null);
  const pendingFocus = useRef(false);
  const [value, setValue] = useState(current);
  const [cursor, setCursor] = useState(() => readDay(current) ? current : today);
  const activeDay = readDay(cursor);
  const year = activeDay.getUTCFullYear();
  const month = activeDay.getUTCMonth();
  const first = moveDays(activeDay, 1 - activeDay.getUTCDate());
  const start = moveDays(first, -weekday(first));
  const previous = dateKey(moveMonths(activeDay, -1));
  const next = dateKey(moveMonths(activeDay, 1));
  const valid = Boolean(readDay(value));

  useLayoutEffect(() => {
    if (!pendingFocus.current) return;
    pendingFocus.current = false;
    grid.current?.querySelector('[data-initial-focus]')?.focus({ preventScroll: true });
  }, [cursor]);

  function moveCursor(key, focus) {
    if (!key || key === cursor) return;
    pendingFocus.current = focus;
    setCursor(key);
  }

  function select(key, focus = false) {
    setValue(key);
    moveCursor(key, focus);
  }

  function navigateDays(event) {
    let offset = daySteps[event.key];
    let target;
    if (event.key === 'Home') offset = -weekday(activeDay);
    if (event.key === 'End') offset = 6 - weekday(activeDay);
    if (offset !== undefined) target = moveDays(activeDay, offset);
    if (event.key === 'PageUp' || event.key === 'PageDown') {
      target = moveMonths(activeDay, (event.key === 'PageUp' ? -1 : 1) * (event.shiftKey ? 12 : 1));
    }
    if (!target) return;
    event.preventDefault();
    moveCursor(dateKey(target), true);
  }

  return <form className="ledger-due-calendar" onSubmit={event => {
    event.preventDefault();
    if (valid && value !== current) onSave(value);
  }}>
    <div className="ledger-due-calendar-header">
      <strong id={titleId} aria-live="polite">{year}年{month + 1}月</strong>
      <div className="ledger-due-calendar-nav">
        <button type="button" onClick={() => select(today)}>今天</button>
        <button type="button" aria-label="上个月" title="上个月" disabled={!previous} onClick={() => moveCursor(previous, false)}>
          <ChevronLeft size={16} aria-hidden="true"/>
        </button>
        <button type="button" aria-label="下个月" title="下个月" disabled={!next} onClick={() => moveCursor(next, false)}>
          <ChevronRight size={16} aria-hidden="true"/>
        </button>
      </div>
    </div>
    <div ref={grid} className="ledger-due-calendar-grid" role="grid" aria-labelledby={titleId} onKeyDown={navigateDays}>
      <div className="ledger-due-calendar-weekdays" role="row">
        {weekdays.map(day => <span key={day} role="columnheader" aria-label={'星期' + day}>{day}</span>)}
      </div>
      {Array.from({ length: 6 }, (_, week) => <div className="ledger-due-calendar-week" role="row" key={week}>
        {Array.from({ length: 7 }, (_, column) => {
          const day = moveDays(start, week * 7 + column);
          const key = dateKey(day);
          return <div key={column} role="gridcell" aria-selected={Boolean(key) && key === value}>
            {key && <button type="button" className={day.getUTCMonth() === month ? undefined : 'is-adjacent'}
              tabIndex={key === cursor ? 0 : -1} data-initial-focus={key === cursor ? '' : undefined}
              aria-label={dateLabel.format(day)} aria-current={key === today ? 'date' : undefined}
              onClick={() => select(key, true)}>{day.getUTCDate()}</button>}
          </div>;
        })}
      </div>)}
    </div>
    <div className="ledger-due-calendar-footer">
      <label className="ledger-due-calendar-entry">
        <CalendarDays size={16} aria-hidden="true"/>
        <input aria-label="截止日期（YYYY-MM-DD）" placeholder="YYYY-MM-DD" maxLength={10}
          value={value} autoComplete="off" spellCheck={false} aria-invalid={value.length === 10 && !valid}
          onChange={event => {
            const text = event.target.value;
            setValue(text);
            if (readDay(text)) moveCursor(text, false);
          }}/>
      </label>
      {current && <button type="button" className="text-button" aria-label="清空日期" onClick={() => onSave(null)}>清空</button>}
      <button type="submit" className="ledger-primary" disabled={!valid || value === current}>保存日期</button>
    </div>
  </form>;
}
