import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 探针的 A/B 试听产物（`outputs/_ab/*.wav`）**刻意不放在 `public/` 下**。
 *
 * 原因：Vite 会**原样拷贝整个 `publicDir`**，`.gitignore` 管得住 git、管不住这次拷贝。
 * 实测 `public/_ab/` 有 62 个 WAV，直接让 `dist/` 多出约 2.8 MB —— 比 wasm 本体（1.14 MB）
 * 还大，而用户的硬约束是「体积要小」。所以在源头改：探针写到 `outputs/_ab/`。
 *
 * 但「点开链接就能试听」这个便利要保住，于是 dev server 挂一个只读中间件，
 * 把 `/outputs/_ab` 暴露成 `/_ab`（与原来探针打印的 URL 一致）。只读、只 dev。
 */
function serveProbeArtifacts(): Plugin {
  const DIR = resolve(process.cwd(), 'outputs', '_ab');
  return {
    name: 'hajimi-serve-probe-artifacts',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/_ab', (req, res, next) => {
        // 只认 .wav，且路径里不许出现 .. —— 这是个开发用的只读出口，不是通用静态服务
        const name = decodeURIComponent((req.url ?? '').split('?')[0].replace(/^\/+/, ''));
        if (!name.endsWith('.wav') || name.includes('..') || name.includes('/')) return next();
        const file = join(DIR, name);
        if (!existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('Content-Type', 'audio/wav');
        res.setHeader('Cache-Control', 'no-store');
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), serveProbeArtifacts()],
  build: {
    target: 'es2020',
    // tone.js 体积较大，放宽告警阈值；lamejs 通过动态 import 自动拆为独立 chunk
    chunkSizeWarningLimit: 1200,
  },
  /*
    ⚠️ 必须把依赖扫描钉死在 index.html 上，否则 dev server 会被仓库里那棵外来源码树搞崩。

    Vite 5.1 起，`optimizeDeps.entries` 不显式指定时会用宽松 glob **扫描 root 下所有源文件**。
    本仓库根目录有 `OpenDWA/`（288 MB、1770 个 .ts/.tsx 的完整外来项目，含 zip，
    已在 .gitignore 里但仍在磁盘上），它的 `main.tsx` 引用了 `@opendaw/lib-*` ——
    这些包我们没装、也不该装，于是扫描器直接报
    「The following dependencies are imported but could not be resolved」并中断优化。

    钉成显式清单后只从真正的入口出发，扫描范围 = 我们自己的模块图。
    这一条同时把启动时的文件扫描量从 288 MB 降到项目实际规模。

    ⚠️ **必须把 `scripts/` 下的探针页面一起列上**。这些页面用 `--port` 起自己的
    dev server 来跑 CDP 探针，如果它们的依赖不在预构建里，Vite 会在探针跑到一半时
    「发现新依赖 → 整页 reload」，探针就在错误的时机读到还没就绪的 DOM
    （表现为「随机失败」，极难查）。所以新增探针页面时记得回来补一行。
  */
  optimizeDeps: {
    /*
      这几个包只在**用户点选第三方引擎**时才动态 import。
      不显式声明的话，Vite 要到那一刻才发现它们，当场预构建并**整页 reload** ——
      试听听到一半页面自己刷新，很容易被当成「点坏了」，也会丢掉装配面板里的 staging。
      列进 include 让 dev server 启动时就构建好，点选只剩网络传输。

      `@audio/shift-*` 这一族现在共 15 个（与 `external-shift.ts` 的 LOADERS 一一对应，
      也和那个 meta 包 `@audio/shift@1.1.4` 的 dependencies 完全一致）。
      新增引擎时**两处都要改**：这里的 include，和 `external-shift.ts` 的 LOADERS。
    */
    include: [
      '@audio/shift-pvoc',
      '@audio/shift-pvoc-lock',
      '@audio/shift-transient',
      '@audio/shift-formant',
      '@audio/shift-hpss',
      '@audio/shift-sms',
      '@audio/shift-paulstretch',
      '@audio/shift-psola',
      '@audio/shift-wsola',
      '@audio/shift-ola',
      '@audio/shift-delay',
      '@audio/shift-granular',
      '@audio/shift-sample',
      '@audio/shift-lpc',
      '@audio/shift-hybrid',
      '@audio/stretch-psola',
      '@soundtouchjs/core',
      '@soundtouchjs/stretch-phase-vocoder',
    ],
    entries: [
      'index.html',
      'scripts/probe-palette/probe-palette.html',
      'scripts/probe-ai/probe-ai.html',
      'scripts/probe-ai/probe-ai-e2e.html',
      'scripts/probe-ai/probe-ai-sweep.html',
      'scripts/probe-ai/probe-ai-threshold.html',
      'scripts/probe-ai/probe-real-worker.html',
      'scripts/probe-ai/probe-worker-yin.html',
      'scripts/probe-ai/probe-yin-parity.html',
    ],
  },
  server: {
    /*
      别让 HMR 的文件监视器去爬 OpenDWA：同样那 288 MB / 1770 个文件，
      监视它只会吃掉 inotify 配额与启动时间，且对开发毫无价值。
      （`server.fs.deny` 只管 HTTP 读取，管不住扫描，所以必须在这里排。）
    */
    watch: {
      ignored: ['**/OpenDWA/**', '**/dist/**', '**/outputs/**'],
    },
  },
  /*
    ⚠️ worker 必须用 ES 格式，否则 `vite build` 直接失败。

    Vite 默认给 worker 打包用 `iife`，而 iife **不支持代码分割**；
    一旦 worker 的依赖图里出现动态 `import()`，rollup 就会试图切 chunk 并报
    `Invalid value "iife" for option "output.format"`。

    本项目两条 worker 依赖图都满足这个条件：
      · `pitch-worker.ts` —— `await import('@tensorflow/tfjs')` 与
        `await import('@spotify/basic-pitch')`（音高 AI 检测按需加载）；
      · 其余 worker 也没有静态依赖这些大包。

    两个 worker 都是以 `{ type: 'module' }` 创建的
    （`pitch-async.ts` / `sample-player.ts` 的 audio-worker），
    现代浏览器下 module worker 本来就该配 ES 格式 —— 所以这里是「对齐」而非变通。
  */
  worker: {
    format: 'es',
  },
});
