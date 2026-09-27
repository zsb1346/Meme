# REF-env —— 环境 / 构建红线（本机事实，不看会反复踩）

> 从 `MEMORY.md §G` 迁出。这些都是**本机 / 本沙箱的既成事实**，不是设计决策。

## 1. 沙箱与删除

- **⛔ 沙箱 safe-delete shim 拦「单轮 >50 条目」删除** → **不删，`mv` 挪走**。
  典型受害者：改了 `vite.config.ts` → 触发依赖重优化 → Vite 执行
  `rm -rf node_modules/.vite/deps`（100+ 条）→ 被守卫拦 → **`vite` 在 listen 阶段就崩**，
  报错却长得像 Vite 自己的问题。
  **看到 `node-safe-delete-shim.cjs` 出现在调用栈里，就知道不是 Vite 的锅。**
  处理：`mv node_modules/.vite ".workbuddy/tmp/vite-cache-old-$(date +%s)"` 再启 dev server。
  同法适用于 `dist/`、`public/<大目录>`。
- 详细判定（守卫打印的 `targets` 是**上一次被拒的那批**，别按它指的名字去调试；
  `scope:"turn"` 的拒绝会在整轮内被缓存复用 → **不要在同一轮里硬试第二次**）→ 技能
  `sandbox-bulk-delete-guard`。

## 2. 构建

- **⛔ `worker: { format: 'es' }` 必须留着**（worker 依赖图有动态 import；iife 不支持代码分割）。
- **⛔ `optimizeDeps.entries` 必须显式列出**且**必须含 `scripts/probe-*/**/*.html`**
  （根目录 `OpenDWA/` 288MB 会中断优化；探针页不在预构建里会中途整页 reload）。

## 3. 磁盘与临时目录

- **⛔ C: 盘长期满**（625MB/100%）→ 临时目录一律指项目盘（`.workbuddy/tmp`、`outputs/probe`）。
- **⛔ 探针 WAV 绝不放 `public/`**（会拷进 dist）→ 写 `outputs/_ab/`。

## 4. 网络

- **⛔ 本机挂着环境代理**（系统代理 `127.0.0.1:10809` 已开，`ProxyOverride` 含
  `localhost;127.*`；另有 `HTTP_PROXY` 环境变量，可能已死）→ 访问 loopback 必须绕开：
  Chrome 用 `--no-proxy-server`，curl 用 `--noproxy '*'`，
  跑 CDP 探针前 `unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy`。
- **⛔ 本机对「无人监听的端口」不回 RST —— SYN 被丢掉，连接要干等约 2 秒才失败。**
  实测死端口：IPv4 2.44~2.64s / IPv6 2.35~2.44s。
  **推论：dev server 只绑一族 = 另一族每次都要白付 ~2s**，而浏览器对 `localhost`
  两族都会试 —— 这就是「启动项目后网页迟迟打不开」的真正成因。
  （2026-09-26 已修：`vite.config.ts` 的 `server.host = '::'` 双栈，三种地址都 3~9ms。
  实测前 TTFB 1.3~3.0s / 整页 5.9~10.2s → 修后 TTFB 0.17~0.28s / 整页 1.3s。）
  ⛔ **别改回 `'127.0.0.1'`**：那是镜像问题，IPv6 那侧照样等 2s。
- **⛔ 本地 dev server / `vite preview` / `python -m http.server` 都会被后台任务生命周期带走**
  （整页 `ERR_CONNECTION_REFUSED`、动态 import 全失败）→ **它可消耗，不代表代码坏了**；
  重启 `npx vite --port 5173 --strictPort`。**起服务器与验证尽量放进同一条命令。**

## 5. 工具链路径

- node 用托管版 `...\binaries\node\versions\22.22.2-3\node.exe`；npm 调 `.../npm/bin/npm-cli.js`。
- **bash 必须 `export PATH="/usr/bin:/bin:/c/Windows/System32:/c/Windows:$PATH"`**；git 在 `D:\Git\cmd\git.exe`。

## 6. 既有失败测试（与本项目改动无关，别去修）

- `src/engine/effect-units/prototype-reverb.test.ts` —— 两条：峰值 `≈0.017 < 0.1`、
  生成耗时 `≈350–460ms > 200ms`。该目录相对 HEAD 零 diff，属既有失败。

## 7. 表格生成的坑

- **⛔ 本机没有 LibreOffice、也没有 Python `formulas` 引擎** → 写进 xlsx 的公式**算不出缓存值**
  （微信/邮件附件、`pandas(data_only=True)` 里会显示空白）。
  **生成表格时一律写「算好的静态值」**，不要用 `COUNTIF`/`SUM`/除法做占比。
  快照数据本来就不会变，公式零收益、纯风险。
- 校验入口：`.../sheetagent/.../skills/excel-generation/scripts/recalc.py <xlsx> 60`，
  只看 JSON 的 `status` 与 `total_errors`（**不能凭退出码判断**）。
