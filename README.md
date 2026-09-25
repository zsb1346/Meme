# 哈吉米 · Meme Studio

把音频切片装到琴键上的网页乐器 —— 按下即出声，录下旋律，导出成品。

**在线体验** → <https://zsb1346.github.io/Meme/>

纯前端运行，不需要服务器、不需要上传音频到任何地方，所有处理都在你自己的浏览器里完成。

---

## 四个工作台

| 页面 | 做什么 |
|---|---|
| **素材箱** | 导入 mp3 / wav，双击波形做切片，每个切片自动检测音高 |
| **演奏台** | 手机端的主力页面。键盘直接拍，力度、音高实时响应 |
| **制作台** | 钢琴卷帘编辑、MIDI 导入、录制 take、导出音频 |
| **混音台** | 效果链（压缩 / EQ / 合唱 / 延迟 / 混响）与主输出电平 |

核心循环是「拍一下 → 听 → 改一个音 → 再拍」。

---

## 本地运行

```bash
npm ci
npm run dev          # http://localhost:5173
```

**环境要求**：Node 20+。首次运行无需额外步骤 —— wasm 内核已预构建并提交在 `public/hajimi_audio.wasm`。

## 构建与部署

```bash
npm run build        # 类型检查 + worker 编译 + 产物到 dist/
```

⚠️ **部署到子路径时必须带 `--base`**，否则资源会 404（表现为白屏或整个应用没有声音）：

```bash
npx vite build --base=/你的子路径/
```

本项目部署在 `https://zsb1346.github.io/Meme/`，所以 base 是 `/Meme/`（见 `.github/workflows/deploy.yml`）。

若要重新编译 wasm 内核（只有改 `wasm/src/**` 时才需要）：

```bash
npm run build:wasm
```

## 技术栈

- **React 18 + TypeScript + Vite** —— 界面与构建
- **Rust → WebAssembly** —— 变调 / 音高检测内核（`wasm/src/psola.rs`、`yin.rs`）
- **Tone.js** —— 音频调度与合成声部
- **Zustand + IndexedDB** —— 工程状态与本地持久化
- 第三方变调引擎（`@audio/shift-*`、`@soundtouchjs/*`）可在界面上切换对比

---

## 许可证

**GNU Affero General Public License v3.0** —— 见 [LICENSE](./LICENSE)。

选这个协议不是随手抓的，原因需要说明白：本项目的变调 / 合成内核
`wasm/src/psola.rs` 在编写时**逐行对照了 PitchNet 的
`Source/Audio/Synthesis/PsolaSynthesizer.cpp`** 参考实现（该实现以 AGPL-3.0 发布）。
按「是否接触过原代码」这个判断标准，它属于**衍生作品**，而不是独立实现。
因此本项目以 AGPL-3.0 发布。

这意味着：**你可以自由使用、修改、甚至商用，但不能把它闭源之后拿去部署。**

### 如果你 fork 或部署本项目

AGPL-3.0 §13 有一条额外义务：**只要用户能通过网络与你的版本交互，你就必须让他们
能拿到完整源码。** 界面左下角和移动端底栏里那个「源码」链接就是干这个用的 ——
请确保它指向你自己的仓库，不要摘掉。

### 第三方组件

见 [NOTICE](./NOTICE)。其中 Spotify Basic Pitch（Apache-2.0）被用于 AI 音高检测，
其许可要求保留版权与许可声明。

---

## 不在仓库里的东西

`原型/`、`素材/`、`dist/`、`outputs/` 已被 `.gitignore` 排除，其中 `原型/` 含有
第三方源码副本与**非商业许可的模型权重**，**不要把它们打进任何发行包或提交到仓库**
——那会构成再分发。
