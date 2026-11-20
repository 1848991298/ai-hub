import { createHash } from 'node:crypto';
import { count, finish, result, today, version } from './common.mjs';
import { redact } from '../portals.mjs';

export const HUAWEI_PACKAGE = 'com.jinriyixiu.isho';
const ORIGIN = 'https://developer.huawei.com';
const CONSOLE = '/consumer/cn/hdc-console/';
const REPORT = '/consumer/cn/service/josp/agc/';
const STATUS = new Map([
  ['准备提交', 'not_submitted'], ['草稿', 'not_submitted'],
  ['审核中', 'reviewing'], ['正在审核', 'reviewing'], ['等待审核', 'reviewing'], ['升级审核中', 'reviewing'],
  ['审核不通过', 'rejected'], ['待修改', 'rejected'], ['审核未通过', 'rejected'],
  ['待上架', 'approved'], ['预约上架', 'approved'], ['审核通过待上架', 'approved'],
  ['已上架', 'live'], ['已发布', 'live'], ['已下架', 'offline'],
]);

function isConsole(raw) {
  const url = new URL(raw);
  return url.origin === ORIGIN && url.pathname.startsWith(CONSOLE);
}

function isBound(text) {
  return text.some(label => {
    const parts = label.trim().split(/\s+/);
    return parts.length === 2 && parts[0] === 'ISHO' && parts[1] === HUAWEI_PACKAGE;
  });
}

async function readBinding(page) {
  const labels = await page.locator('[role="button"].el-tooltip__trigger').evaluateAll(elements =>
    elements.filter(element => element.getClientRects().length).map(element => element.innerText));
  return isBound(labels);
}

async function waitFor(page, read, timeout = 14000) {
  const until = Date.now() + timeout;
  do {
    if (new URL(page.url()).origin !== ORIGIN) throw new Error('needs_login');
    const value = await read();
    if (value) return value;
    await page.waitForTimeout(250);
  } while (Date.now() < until);
  throw new Error('read_failed');
}

async function openApp(page) {
  if (new URL(page.url()).origin !== ORIGIN) throw new Error('needs_login');
  if (!isConsole(page.url())) {
    const url = new URL(page.url());
    if (url.pathname === '/consumer/cn/service/josp/agc/index.html') {
      await page.goto(ORIGIN + CONSOLE + 'index.html', { waitUntil: 'domcontentloaded', timeout: 16000 });
    }
    try {
      await waitFor(page, () => isConsole(page.url()));
    } catch (error) {
      if (error.message === 'needs_login') throw error;
      throw new Error('console_unready');
    }
  }
  if (await readBinding(page)) return;
  // Multiple cards can link to different sections of the same app. Use an
  // unambiguous app ID from the visible ISHO card, then verify the package.
  let href;
  try {
    href = await waitFor(page, async () => {
      if (await readBinding(page)) return 'bound';
      const links = await page.locator('a[href]').evaluateAll(items => items.flatMap(item => {
        if (!item.getClientRects().length) return [];
        return [{ href: item.href, label: [item.getAttribute('aria-label'), item.getAttribute('title'), item.innerText]
          .find(value => ['ISHO', '应用管理'].includes(value?.trim()))?.trim() }];
      }));
      const targets = links.filter(link => link.label).map(link => ({ ...link, url: new URL(link.href) }))
        .filter(({ url }) => isConsole(url.href) && /^#\/app\/\d+\?/.test(url.hash))
        .map(link => ({ ...link, appId: new URLSearchParams(link.url.hash.split('?')[1]).get('appId') }))
        .filter(link => link.appId);
      const cards = targets.filter(link => link.label === 'ISHO');
      const ids = new Set(cards.map(link => link.appId));
      if (ids.size === 1) return cards[0].url.href;
      const current = new URL(page.url());
      if (!current.hash.startsWith('#/home/')) return null;
      const currentApp = new URLSearchParams(current.hash.split('?')[1]).get('appId');
      const management = targets.filter(link =>
        link.label === '应用管理' && (!currentApp || link.appId === currentApp));
      return new Set(management.map(link => link.appId)).size === 1 ? management[0].url.href : null;
    });
  } catch (error) {
    if (error.message === 'needs_login') throw error;
    throw new Error('app_selection_pending');
  }
  if (href !== 'bound') {
    await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 16000 });
    try {
      await waitFor(page, () => readBinding(page));
    } catch (error) {
      if (error.message === 'needs_login') throw error;
      throw new Error('app_not_found');
    }
  }
}

export function readVersions(labels) {
  const versions = [...new Set(labels.map(label => label.trim()))].map(label => {
    const match = /^(\d+(?:\.\d+)+)\s+(.+)$/.exec(label);
    if (!match || !STATUS.has(match[2])) throw new Error('unknown_status');
    return { version: version(match[1]), status: STATUS.get(match[2]) };
  });
  const live = versions.filter(row => row.status === 'live');
  const next = versions.filter(row => row.status !== 'live');
  if (!versions.length || live.length > 1 || next.length > 1) throw new Error('version_schema');
  const row = {
    channel: 'huawei', status: next[0]?.status || 'live', as_of: today(),
    pending_version: next[0]?.version || '', pending_code: null,
  };
  if (live.length) {
    row.live_version = live[0].version;
    row.live_code = null;
  }
  return { row, liveKnown: live.length === 1 };
}

async function openSection(page, label) {
  if (!isConsole(page.url()) || !await readBinding(page)) throw new Error('app_not_found');
  const groups = label === '下载安装' ? ['分析', '分发分析'] : ['推广运营', '用户运营'];
  const visibleText = text => page.getByText(text, { exact: true }).filter({ visible: true });
  const menu = visibleText(label);
  try {
    for (const group of groups) {
      if (await menu.count()) break;
      const heading = visibleText(group);
      if (await heading.count() !== 1) continue;
      const collapsed = await heading.evaluate(element => {
        const submenu = element.closest('.el-sub-menu__title')?.closest('.el-sub-menu');
        return submenu && !submenu.classList.contains('is-opened');
      });
      if (collapsed) await heading.click({ timeout: 5000 });
    }
    await menu.click({ timeout: 10000 });
  } catch {
    throw new Error('report_navigation');
  }
}

async function readTable(page, columns, previous = null) {
  return waitFor(page, async () => {
    const handle = await page.locator('#mainIframeView').elementHandle({ timeout: 1000 }).catch(() => null);
    if (!handle) return null;
    const frame = await handle.contentFrame().finally(() => handle.dispose()).catch(() => null);
    if (!frame?.url().startsWith(ORIGIN + REPORT)) return null;
    const tables = await frame.locator('.el-table').evaluateAll((items, keys) => {
      return items.filter(table => table.getClientRects().length).flatMap(table => {
        if ([...table.querySelectorAll('.el-loading-mask')].some(mask => mask.getClientRects().length)) return [];
        const headers = [...table.querySelectorAll('table.el-table__header th')].map(th => th.innerText.trim());
        if (keys.some(key => headers.filter(header => header === key).length !== 1)) return [];
        const rows = [...table.querySelectorAll('table.el-table__body tbody tr')].map(tr => {
          const cells = [...tr.querySelectorAll(':scope > td')];
          return Object.fromEntries(keys.map(key => {
            const cell = cells[headers.indexOf(key)];
            const value = cell?.innerText.trim();
            const rating = cell?.querySelector('[aria-valuenow]')?.getAttribute('aria-valuenow');
            return [key, key === '评分' && !value ? rating : value];
          }));
        });
        const empty = table.querySelector('.el-table__empty-text');
        return rows.length || empty?.getClientRects().length && empty.innerText.trim() === '暂无数据' ? [rows] : [];
      });
    }, columns).catch(() => []);
    if (tables.length !== 1) return null;
    return previous !== JSON.stringify(tables[0]) ? tables[0] : null;
  }, 22000).catch(error => {
    if (error.message === 'needs_login') throw error;
    throw new Error('report_table');
  });
}

export function downloadRows(entries) {
  const seen = new Set();
  return entries.flatMap(entry => {
    const date = entry['日期'];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || date > today() || seen.has(date)) throw new Error('report_schema');
    seen.add(date);
    const value = entry['新下载成功次数'];
    if (value === '—' || value === '-' || value === '') return [];
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(value || '')) throw new Error('report_schema');
    return [{ channel: 'huawei', date, downloads: count(value.replaceAll(',', '')),
      source: '华为 AppGallery 鸿蒙后台 · 新下载成功次数' }];
  });
}

function reviewRow(entry) {
  const time = entry['评论时间'];
  const date = time?.slice(0, 10);
  const rating = Number(entry['评分']);
  const body = entry['评论内容'];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || date > today() ||
      !Number.isInteger(rating) || rating < 1 || rating > 5 || typeof body !== 'string') {
    throw new Error('review_schema');
  }
  const identifier = createHash('sha256')
    .update(JSON.stringify([entry['用户昵称'], time, entry['应用版本'], rating, body])).digest('hex');
  return { channel: 'huawei', external_id: identifier, date, rating,
    version: entry['应用版本'] || '', body: redact(body).slice(0, 5000),
    source: '华为 AppGallery 鸿蒙后台 · 互动评论' };
}

async function readReviews(page) {
  const fields = ['用户昵称', '评论内容', '应用版本', '评分', '评论时间'];
  let entries = await readTable(page, fields);
  const frame = page.frameLocator('#mainIframeView');
  const next = frame.locator('.el-pagination button.btn-next').filter({ visible: true });
  const reviews = [];
  for (let pageNumber = 0; pageNumber < 12; pageNumber++) {
    reviews.push(...entries.map(reviewRow));
    const controls = await next.count();
    if (!controls || controls === 1 && await next.isDisabled()) {
      if (new Set(reviews.map(row => row.external_id)).size !== reviews.length) throw new Error('review_pagination');
      return reviews;
    }
    if (controls !== 1) throw new Error('review_pagination');
    await next.click({ timeout: 10000 });
    entries = await readTable(page, fields, JSON.stringify(entries));
  }
  throw new Error('review_pagination');
}

function failed(error) {
  const code = ['unknown_status', 'app_not_found', 'needs_login', 'version_schema', 'console_unready', 'app_selection_pending',
    'report_navigation', 'report_table', 'report_schema', 'review_schema', 'review_pagination'].includes(error.message) ? error.message : 'read_failed';
  return { state: code === 'app_not_found' || code === 'needs_login' ? code : 'read_failed', code };
}

export async function collect({ page, login = false }) {
  const output = { ...result('huawei'), package: HUAWEI_PACKAGE };
  try {
    await openApp(page);
  } catch (error) {
    output.parts.channels = failed(error);
    if (login && ['app_selection_pending', 'app_not_found', 'console_unready'].includes(output.parts.channels.code)) {
      output.parts.channels.state = 'needs_login';
    }
    return finish(output);
  }
  try {
    const labels = await waitFor(page, async () => {
      const entries = await page.locator('li[id^="left-menu-v"]').allInnerTexts();
      return entries.filter(text => /^\s*\d+(?:\.\d+)+\s/.test(text)).length
        ? entries.filter(text => /^\s*\d+(?:\.\d+)+\s/.test(text)) : null;
    });
    const { row, liveKnown } = readVersions(labels);
    output.rows.channels = [row];
    output.parts.channels = { state: 'ok' };
    output.parts.listing = liveKnown ? { state: 'ok' } : { state: 'read_failed', code: 'live_unconfirmed' };
  } catch (error) {
    output.parts.channels = failed(error);
  }
  try {
    await openSection(page, '下载安装');
    const rows = downloadRows(await readTable(page, ['日期', '新下载成功次数']));
    output.rows.metrics = rows;
    output.parts.downloads = { state: 'ok', count: rows.length };
  } catch (error) {
    output.parts.downloads = failed(error);
  }
  try {
    await openSection(page, '互动评论');
    output.rows.reviews = await readReviews(page);
    output.parts.reviews = { state: 'ok', count: output.rows.reviews.length };
  } catch (error) {
    output.parts.reviews = failed(error);
  }
  return finish(output);
}
