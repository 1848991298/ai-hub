import{mkdir,chmod}from'node:fs/promises';import{join}from'node:path';import{PORTALS}from'./portals.mjs';
export async function profile(root,provider){if(!PORTALS[provider])throw new Error('unsupported provider');const directory=join(root,'.local/market-browser',provider);await mkdir(directory,{recursive:true,mode:0o700});await chmod(directory,0o700);return directory;}
