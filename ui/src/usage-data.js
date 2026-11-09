export const known = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export const count = value => known(value) ? new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 2 }).format(value) : '—';
export const money = value => known(value) ? `$${value.toFixed(2)}` : '—';

export function recentDates(end, length) {
  if (!end) return [];
  return Array.from({ length }, (_, index) => {
    const day = new Date(`${end}T12:00:00Z`);
    day.setUTCDate(day.getUTCDate() - length + index + 1);
    return day.toISOString().slice(0, 10);
  });
}

const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0,10) === value;

export function selectDates(daily, today, mode, start, end) {
  if (mode === '7' || mode === '30') return {dates:recentDates(today,Number(mode)),error:''};
  if (mode === 'all') {
    start = daily.map(row=>row.date).filter(value=>validDate(value) && value>='1970-01-01' && value<=today).sort()[0] || today;
    end = today;
  }
  if (!validDate(start) || !validDate(end)) return {dates:[],error:'请选择完整、有效的开始和结束日期。'};
  if (start>end) return {dates:[],error:'开始日期不能晚于结束日期。'};
  if (start<'1970-01-01' || end>today) return {dates:[],error:'日期需在 1970-01-01 至今天之间。'};
  const length=Math.round((Date.parse(`${end}T12:00:00Z`)-Date.parse(`${start}T12:00:00Z`))/86400000)+1;
  return {dates:recentDates(end,length),error:''};
}

// 三个月以内一天一根；更长才合并，且最多 60 组。空组保持缺失，不记成 0。
export function chartBuckets(dates, daily, metric) {
  const rows=new Map(daily.map(row=>[row.date,row])), size=dates.length<=92?1:Math.max(1,Math.ceil(dates.length/60));
  const result=[];
  for(let offset=0;offset<dates.length;offset+=size) {
    const group=dates.slice(offset,offset+size), values=group.map(day=>rows.get(day)?.[metric]).filter(known);
    result.push({start:group[0],end:group.at(-1),days:group.length,observed:values.length,value:values.length?values.reduce((a,b)=>a+b,0):null});
  }
  return result;
}

// 没有记录的日期保留缺失；不能把缺失或未知费用转换成零。
export function summarize(daily, dates) {
  const dateSet = new Set(dates);
  const selected = daily.filter(row => dateSet.has(row.date));
  const sum = key => {
    const values = selected.map(row => row[key]).filter(known);
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  };
  const completeSum = key => selected.length && selected.every(row => known(row[key])) ? sum(key) : null;
  const input = completeSum('input_tokens'), cached = completeSum('cached_tokens');
  const completeMix = selected.length > 0 && selected.every(row => known(row.input_tokens) && known(row.cached_tokens));
  const models = new Map();
  selected.forEach(row => (row.models || []).forEach(model => {
    const previous = models.get(model.name) || { name: model.name, total_tokens: null, days: 0 };
    if (known(model.total_tokens)) previous.total_tokens = (previous.total_tokens ?? 0) + model.total_tokens;
    previous.days += 1;
    models.set(model.name, previous);
  }));
  return { selected, total: sum('total_tokens'), estimate: sum('estimated_usd'), priced: selected.filter(row => known(row.estimated_usd)).length,
    tokenDays: selected.filter(row => known(row.total_tokens)).length,
    hit: completeMix && input > 0 ? cached / input * 100 : null,
    input, cached, output: completeSum('output_tokens'), models: [...models.values()].sort((a,b) => (b.total_tokens ?? -1) - (a.total_tokens ?? -1)) };
}

// 模型过滤只汇总真实分项，费用缺少分项时保持未知，不按 token 比例摊钱。
export function filterModels(daily, names) {
  if (names === null) return daily;
  const chosen = new Set(names);
  const sumComplete = (models, key) => models.length && models.every(model => known(model[key])) ? models.reduce((sum, model) => sum + model[key], 0) : null;
  return daily.flatMap(row => {
    const models = (row.models || []).filter(model => chosen.has(model.name));
    if (!models.length) return [];
    if (models.length === row.models.length) return [row];
    return [{...row, models, ...Object.fromEntries(['total_tokens','input_tokens','cached_tokens','output_tokens','estimated_usd','reference_usd'].map(key => [key, sumComplete(models,key)])), pricing_complete: models.every(model => !model.fallback_pricing)}];
  });
}

export function pricingCoverage(daily, dates) {
  const rows = daily.filter(row => dates.includes(row.date));
  const models = rows.flatMap(row => row.models || []);
  const total = models.reduce((sum, model) => sum + (known(model.total_tokens) ? model.total_tokens : 0), 0);
  const fallback = models.filter(model => model.fallback_pricing).reduce((sum, model) => sum + (model.total_tokens || 0), 0);
  const values = rows.map(row => row.reference_usd ?? row.estimated_usd).filter(known);
  return {reference: values.length ? values.reduce((a,b)=>a+b,0) : null, referenceDays:values.length, fallbackTokens:fallback, fallbackPercent:total ? fallback/total*100 : null, fallbackModels:[...new Set(models.filter(model => model.fallback_pricing).map(model => model.name))]};
}
