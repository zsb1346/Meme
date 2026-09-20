// 把 cargo 编译出的 wasm 产物拷到 public/，供静态托管与 worker 运行时 fetch。
// 跨平台：npm 脚本在 Windows(cmd)/Unix(sh) 下都调用本 node 脚本，避免 copy/cp 差异。
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'wasm', 'target', 'wasm32-unknown-unknown', 'release', 'hajimi_audio.wasm');
const outDir = join(root, 'public');
const out = join(outDir, 'hajimi_audio.wasm');

if (!existsSync(src)) {
  console.error(`[copy-wasm] 找不到产物：${src}\n请先 cargo build --target wasm32-unknown-unknown --release`);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
copyFileSync(src, out);
const kb = (existsSync(out) ? (await import('node:fs')).statSync(out).size / 1024 : 0).toFixed(1);
console.log(`[copy-wasm] 已拷贝 hajimi_audio.wasm (${kb} KB) → public/`);
