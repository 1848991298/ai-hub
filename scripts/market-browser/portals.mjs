export const PORTALS={
 oppo:{name:'OPPO',url:'https://open.oppomobile.com/',hosts:['oppomobile.com','heytap.com']},
 vivo:{name:'vivo',url:'https://dev.vivo.com.cn/',hosts:['vivo.com.cn','vivo.com']},
 xiaomi:{name:'小米',url:'https://dev.mi.com/',hosts:['mi.com','xiaomi.com']},
 tencent:{name:'应用宝',url:'https://app.open.qq.com/',hosts:['qq.com']},
 honor:{name:'荣耀',url:'https://developer.honor.com/cn/',hosts:['honor.com','hihonor.com','cloud.huawei.com']},
};
export function trusted(provider,raw){try{const u=new URL(raw);return u.protocol==='https:'&&PORTALS[provider]?.hosts.some(h=>u.hostname===h||u.hostname.endsWith('.'+h));}catch{return false;}}
export function publicUrl(raw){try{const u=new URL(raw);return u.origin+u.pathname;}catch{return '';}}
export function redact(text){const secret=/(密钥|勿外泄|app.?key|api.?key|secret|password|密码|验证码|access.?token|refresh.?token)/i;return text.replace(/\b[a-f0-9]{32,}\b/gi,'[凭据已隐藏]').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[邮箱已隐藏]').replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g,'[手机号已隐藏]').split('\n').filter((l,i,a)=>!secret.test(l)&&!(i&&secret.test(a[i-1]))).join('\n');}
