/**
 * 探针驱动：先确认 dev server 起来（轮询直到 200），再拉 Chrome 跑探针页。
 *
 *   node scripts/probe-ai/_run-probe.mjs <path> [--timeout=ms] [--port=5199]
 *
 * 为什么需要它：`_probe-ai-browser.mjs` 一启动就导航，dev server 还没监听时
 * 会直接吞掉 ERR_CONNECTION_REFUSED，探针页永远不输出 —— 看起来像「探针挂了」。
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const path = args[0];
if (!path) {
  console.error('用法: node scripts/probe-ai/_run-probe.mjs <path> [--timeout=ms] [--port=5199]');
  process.exit(2);
}
const opt = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const PORT = Number(opt('port', 5199));
const TIMEOUT = opt('timeout', '180000');
const outFile = opt('out', '.probe-run.txt');
const base = `http://127.0.0.1:${PORT}`;
const absOut = resolve(process.cwd(), outFile);

/**
 * vite 默认只听 `localhost`，而 node 的 fetch 可能先解析到 ::1 ——
 * 用字面 127.0.0.1 去探就会 ERR_CONNECTION_REFUSED，看起来像「服务没起来」。
 * 所以两个主机名都试。
 */
const CANDIDATES = [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`];

/** 本驱动自己的话也落盘 —— 只看 stdout 的话，「server 没起来」和「探针挂了」长得一样。 */
const logLines = [];
const note = (s) => {
  logLines.push(s);
  console.log(s);
  try {
    writeFileSync(absOut, logLines.join('\n') + '\n', 'utf8');
  } catch {
    /* 忽略 */
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let up = false;
let host = null;
for (let round = 0; round < 2 && !up; round++) {
  for (const cand of CANDIDATES) {
    try {
      const r = await fetch(cand + '/');
      if (r.ok) {
        up = true;
        host = cand;
        break;
      }
    } catch {
      /* 还没起来 */
    }
  }
  if (!up) await sleep(500);
}
if (!up) {
  note(`[run-probe] 失败：dev server ${CANDIDATES.join(' / ')} 都没起来`);
  process.exit(1);
}

const url = host + (path.startsWith('/') ? path : '/' + path);
note(`[run-probe] ${url}`);

const child = spawn(
  process.execPath,
  [
    resolve(here, '_probe-ai-browser.mjs'),
    url,
    `--timeout=${TIMEOUT}`,
    `--shot=${outFile.replace(/\.txt$/, '.png')}`,
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);

let buf = '';
child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
});
child.stderr.on('data', (d) => {
  buf += d.toString('utf8');
});
const code = await new Promise((r) => child.on('close', r));
note(`[run-probe] chrome 退出码 ${code}`);
// 注意：这里直接落盘，别再走 note() 了 —— note 只写 logLines，会把刚才拼进去的
// 探针输出整个盖掉（踩过一次，结果拿到一个只有 4 行的「空报告」）。
writeFileSync(absOut, logLines.join('\n') + '\n' + buf, 'utf8');
console.log(`[run-probe] 输出已写入 ${outFile}（${buf.length} 字符）`);

