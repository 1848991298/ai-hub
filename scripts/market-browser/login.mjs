// 独立 OPPO 登录入口；用户在官方页面验证，成功后只读查询并输出白名单运营字段。
if((process.argv[2]||'oppo')!=='oppo')throw new Error('当前仅支持 OPPO 登录验证。');
if(!process.argv.includes('--login'))process.argv.push('--login');
await import('./oppo.mjs');
