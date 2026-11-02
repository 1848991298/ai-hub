import {defineConfig} from 'vite';
import {fileURLToPath} from 'node:url';
export default defineConfig({build:{rollupOptions:{input:{index:fileURLToPath(new URL('./index.html',import.meta.url)),market:fileURLToPath(new URL('./market.html',import.meta.url))}}}});
