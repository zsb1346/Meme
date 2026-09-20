---
name: repo-encoding-and-emoji-hygiene
description: 给仓库做「中文注释编码体检」与「emoji 清理」时用。当用户说「某些文件中文注释是乱码、帮我恢复」「移除所有 emoji」「别改坏文件」时使用。含最硬的乱码判据（GBK 往返还原）、emoji 与排版字形的区分规则、防改坏的三条保险，以及文档语义后修流程。
agent_created: true
---

# 编码体检 + emoji 清理

两件事经常一起被提出来，但风险完全不同：**乱码体检是只读的，emoji 清理是大范围写盘**。
先体检、拿到文件清单，再清理。

## 第 0 条：报告本身必须是纯 ASCII

这是整个流程里最容易踩的坑，不遵守会让你**分不清「文件坏了」和「展示坏了」**。

实测过一次：扫描报告里带中文原文，落盘后用 Read 一看全是 `涔辩爜鍛戒腑`（乱码），
第一反应是「文件坏了」；但同一份报告上一版读出来是正常的。
最后只能靠**把报告写成纯 ASCII**（非 ASCII 一律 `\uXXXX` 转义 + 附原始字节 hex）
才把事实钉死。

```js
const ascii = (s) => {           // 只保留可打印 ASCII，其余转义
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x20 && cp < 0x7f) out += ch;
    else if (cp > 0xffff) out += `\\u{${cp.toString(16).toUpperCase()}}`;
    else out += `\\u${cp.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
};
```

顺带一个更省事的判据：**写盘后用「已知内容的瑞士轮」验证写读链路**。
写一个含既定中文串的文件，读回来比 `stripAllWhitespace`，再把这串转义打印。
两边一致 → 工具链没问题，问题在文件；不一致 → 问题在工具链。

## 第 1 条：最硬的乱码判据是 GBK 往返还原

关键字表（找 `锟斤拷`、`æåäç` 之类）会漏，因为误码产物不受具体用词限制。
**真正的判据是能否还原**：「UTF-8 字节被当 GBK 解码」的产物，用同一张 GBK 表编码回
字节后，应该恰好是**合法 UTF-8 且解出中文**。

```js
// 建 char → GBK 字节 的反查表
const gbk = new TextDecoder('gbk');
const gbkBack = new Map();
for (let lead = 0x81; lead <= 0xfe; lead++)
  for (let trail = 0x40; trail <= 0xfe; trail++) {
    if (trail === 0x7f) continue;
    const ch = gbk.decode(new Uint8Array([lead, trail]));
    if (ch && ch.length === 1 && ch !== '\uFFFD' && !gbkBack.has(ch)) gbkBack.set(ch, [lead, trail]);
  }

const utf8Fatal = new TextDecoder('utf-8', { fatal: true });
function unMojibake(s) {                 // 还原得出中文 → 返回它；否则 null
  if (!/[\u4e00-\u9fff]/.test(s)) return null;
  const bytes = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp > 0xffff) return null;
    const b = gbkBack.get(ch);
    if (b) bytes.push(...b);
    else if (cp < 0x80) bytes.push(cp);
    else return null;                    // 不在 GBK 双字节空间 → 不是这种误码
  }
  try {
    const back = utf8Fatal.decode(Uint8Array.from(bytes));
    return back !== s && /[\u4e00-\u9fff]/.test(back) ? back : null;
  } catch { return null; }
}
```

**别只测整行**。只有半句坏掉的行会漏（整行里混着正常中文时，反查表必然在中途 `return null`）。
补一层「按连续非 ASCII 片段切片，长度 ≥ 4 才判」——4 字门槛是为了压掉 2 个汉字
的 GBK 字节恰好构成合法 UTF-8 的巧合。

实测这个判据在 3847 个文件上只报 2 条真命中，且都能正确还原出原文
（`未检出为 0`、`F:\L练习\鬼畜哈吉米`）—— 精度够用。

## 第 2 条：编码普查要覆盖 UTF-16（NUL 字节不是「二进制」的同义词）

用 `buf.includes(0)` 判二进制会把 **UTF-16 文件整份跳过**，
而「文件是 UTF-16、编辑器按 UTF-8 打开」正是「中文注释全是乱码」的第一大成因。
所以要按 BOM + NUL 分布**分类**而不是丢弃：

| 判据 | 结论 |
|---|---|
| `EF BB BF` | UTF-8-BOM（无害，但和纯 UTF-8 要分开统计） |
| `FF FE` / `FE FF` | UTF-16LE / UTF-16BE ← 重点怀疑对象 |
| 无 BOM 但有 NUL | 真二进制（`.od` `.onnx` `.syx` `.npz`）或 UTF-16 无 BOM，看 NUL 分布 |
| `utf8Fatal.decode` 抛错 | 非 UTF-8（大概率 GBK 存的源码） |

## 第 3 条：emoji 判定要分清「图画型字符」与「排版字形」

**用 Unicode 属性，别凭感觉。** 用户说「移除所有 emoji」时，删掉箭头和几何字形
就是把注释读坏、把 UI 改坏。

```js
const PICTO = '[\\p{Extended_Pictographic}\\p{Emoji_Presentation}]';  // 删
const KEEP  = /[\u2190-\u21FF\u25A0-\u25FF]/u;                        // 留
```

- **留 `\u2190-\u21FF`（排版箭头）**：`input → pitch → stretch`、`↑ 在顶部夹取`
  这类写法里箭头是语法的一部分，Unicode 里 Emoji=No。
- **留 `\u25A0-\u25FF`（几何字形）**：这是**活的功能字形**。本项目实测
  `ExportDialog` 的 `'▶ 预览' / '■ 停止'`、`EditMatrixView` 的 `'▶'`
  都是按钮文案 —— 删掉就是改坏 UI。
- 也别动 `° ± × ≈ ≤ ≥ ★ ♪ ♩ § ¶`。

### 一个必须知道的 Unicode 陷阱：勾叉家族不同属性

U+2714（HEAVY CHECK MARK）属于 `Extended_Pictographic` 会被删，而 U+2718 / U+2713 /
U+2717（后三个同族的叉与勾）**没有** Emoji 属性 —— 只删前者会把成对的勾叉拆成「一个没了、一个还在」。
**整个家族一起处理**，而且不要一删了之。

### 「通过/失败」类符号要换成词，不能删

```js
`${pass ? 'U+2705' : 'U+274C'} ${name}`   // 删掉 → pass ? '' : ''，信息全丢
`${pass ? 'PASS' : 'FAIL'} ${name}`
```

同理 U+2714 / U+2718 → `OK/NG`。**先做文字替换，再跑删除**（替换是删除的前置步骤，
否则三元表达式会被掏空）。

### 删字符必须连带处理相邻空格 —— 但**不能**吃掉缩进

只删字符会留下残迹，实测三类：

| 原样 | 只删字符 | 应该变成 |
|---|---|---|
| `// U+26A0 老形状` | `//  老形状`（双空格） | `// 老形状` |
| `'U+2714 守恒'` | `' 守恒'`（引号后前导空格） | `'守恒'` |
| `      U+26A0 未解决项` | ` 未解决项`（**缩进塌成 1 格**） | `      未解决项` |

正确规则：**保留 emoji 左侧的空白原样，右侧空白整段丢弃**；只有 emoji 落在行尾
（右侧无空白）时才连左侧空白一起丢，避免尾随空格。

```js
return right ? left : '';          // 对
return left && right ? ' ' : '';   // 错：两侧都有空白时固定输出 1 个空格 → 缩进塌掉
```

**这个坑极难发现，因为它同时被两层校验放过：**
- 不变量 `norm` 刻意抹掉所有空白，所以缩进塌陷在它眼里是合法的；
- 破坏是**纯视觉**的：注释缩进错位看不出、JSX 里会多一个前导空格而渲染后察觉不到。

本项目实测 5 处（4 处注释缩进 + `RollEmptyState.tsx` 的 `U+1F399 录制演奏` 按钮文案），
是从 `git diff` 的 `-`/`+` 行**前导空白长度对比**里捞出来的。所以：
**改完必须专门审计一遍「缩进有没有变短」**，不能只跑不变量。

审计写法：`git diff -U0` → 逐 hunk 配对 `-`/`+` 行（行数相等才配对）→
`-` 行含图画型字符且 `+` 行前导空白更短 → 命中。实测命中数就是修复清单的长度。
注意配对的可靠性依赖 `-U0`（无上下文行时删/增行数一致），别用默认 `-U3`。

## 第 4 条：防「改坏」的三条保险

1. **干跑优先**：默认只报告，`--apply` 才写盘。
2. **不变量校验**：`norm(改前) === norm(改后)`，其中
   `norm = strip 一次 + 抹掉所有空白`。等式成立 ⇔ 除空白、emoji、
   以及确定性的文字替换之外，**一个字符都没被动过**。不成立就整文件跳过并报错。
3. **写盘前逐文件备份**到 `os.tmpdir()`（别在仓库里留 `.bak` 垃圾）。

项目本身在 git 上时，`git diff` 是第一层保险 —— 但注意它**分不出「这次改的」和
「上一轮未提交的」**。要隔离本轮改动，用备份目录 vs 工作区做逐行 diff。

## 第 5 条：文档里的「表意符号」必须后修

机械替换对**源码注释和日志**是安全的，但对文档会伤语义。实测出现的三类残迹：

| 残迹 | 成因 | 修法 |
|---|---|---|
| `\| \|`（空单元格） | 评级列 `\| U+2B50×3 \|` 被删 | 按原星级补文字：`\| 高 \|` / `\| 中 \|` / `\| 低 \|` |
| `PASSPASS` | `U+2705` 连写两个被逐字符映射 | 删掉整串装饰 |
| `emoji（）` | 括号里全是被删的 emoji | 改写成说明文字 |

还有一处语义走偏：文档里的 U+2705 / U+274C 常表示「有/无」「禁/允」，映射成 `PASS/FAIL` 是错的
（`- U+274C 渐变按钮` 是禁忌清单的一行）。**逐文件、逐行处理，不要全局 replace_all**。

后修脚本的写法：每条替换写成 `{file, line, from, to}`，**先断言 `from` 出现在该行**，
找不到就报错退出。这样不会出现「以为改了其实没改」或「改到别处」。

## 第 6 条：验收

```bash
npx tsc --noEmit                       # 主
npx tsc -p tsconfig.worker.json        # worker（独立 tsconfig）
npx vitest run
npm run build
```

再复跑一次 emoji 扫描确认为 0，并复跑一次编码体检确认为「合法 UTF-8」不变。

**注意区分临时文件的乱码**：本项目 `.probe-*` `.diff-*` `.v-*` 这类用 PowerShell
重定向写出的临时文件，里面中文必然是乱码（见下）。报告「还有 N 条乱码」前，
先看命中在哪个文件 —— 全是自己的临时文件就是干净的。

**让清理器自己也不含 emoji 字面量。** 替换表用码点构造即可：

```js
const E = (hex) => String.fromCodePoint(hex);
const WORD_MAP = [[E(0x2705), 'PASS'], [E(0x274c), 'FAIL'], [E(0x2714), 'OK'], /* … */];
```

这样全仓扫描才能干净地输出 `files=0`，不需要给用户附一句「除了清理器自己」的例外说明
（有例外就有争议空间）。注释里要提到具体字符时一律写 `U+XXXX` 记法。
另外脚本仍应**按 `import.meta.filename` 跳过自己**作兜底 —— 早先它用路径正则排除，
文件名从 `_strip-emoji.mjs` 改成 `strip-emoji.mjs` 后正则失配，复扫就永远报「残留 1 个文件」。
**别用名字模式排除自己，用真实路径比较。**

改完替换表**必须回归测试**（别只信「干跑 0 命中」—— 那可能只是因为把匹配写坏了）：
造一个含各类边界的样本文本 `scripts/sample.ts` 放到系统临时目录，用
`--root=<临时目录> --apply` 跑一遍，逐条比对预期：`'U+2705 pass' → 'PASS pass'`、
三元里的 `U+2705/U+274C → PASS/FAIL`、`U+2714/U+2718 → OK/NG`、
行尾 `xxx U+26A0 → xxx`（不留尾随空格）、`U+25B6` 与 `→` 不动，
且仍是无 BOM 的 UTF-8。**还要专门覆盖缩进用例**：
`    // x U+26A0 y` → `    // x y`、`       U+26A0 deep` → `       deep`、
`      U+1F399 label` → `      label` —— 前导缩进必须原样保住（这正是最容易写错的一条）。

**自己写文档时也要守同一条规矩**：技能/记忆文件里提到具体字符一律写 `U+XXXX`。
我这次就是先在技能文档里写了 `U+1F399 录制演奏` 的字面量版本，复扫立刻多报 2 个文件 ——
**写文档的人自己就是最大的污染源**，收尾复扫要跑在「所有文档都写完」之后。

### 「白名单内 0 残留」不等于「全仓 0 残留」

清理器只扫白名单目录，所以它的 `files=0` 只证明**代码和文档干净**。
要说「全仓所有 emoji 都移除了」，必须再跑一次**不带任何范围过滤**的全仓扫描，
按白名单内/外分组看结果。实测正是这一步抓到了根目录两个漏网的
`.probe-ai-abstain-*.txt`（探针 stdout 转储，含 U+2714）—— 它们不在白名单里，
清理器的 `files=0` 完全看不见它们。
提交「已全部移除」之前必做这一步，否则结论是假的。

### 失败的验收项要先做 A/B，别急着认领

`npm run build` 在本项目里**本来就是坏的**（`[vite:worker-import-meta-url]
Invalid value "iife" ... not supported for code-splitting builds`，指向
`pitch-async.ts` 的 worker 接线）。我一度以为是自己删 emoji 删坏的。

判定方法：把本次改过的文件**还原成改动前**跑一次同名命令 ——

```
node _ab.mjs <root> verify      # 快照当前版本 + 校验快照一致
node _ab.mjs <root> revert      # 备份版覆盖回工作区（= 回到改动前）
npm run build                   # 对照组：报的错一模一样 → 与本次改动无关
node _ab.mjs <root> restore     # 快照覆盖回去（= 撤销 revert）
```

（`_ab.mjs` 是当次的一次性脚本，已删；要复用时按上面四个子命令重写一遍即可，
核心就是「拿备份目录覆盖工作区 / 再拿快照覆盖回来 + 逐文件 sha256 校对」。）

`restore` 后必须逐文件 sha256 比对（脚本内置），否则「还原干净了」只是感觉。
**改完东西的验收阶段最忌讳把既有失败当成自己引入的**，会白改一通；
反过来说，也忌讳把既有失败当成「不是我干的」而不验证。

## 本项目的基线（2026-09-19 实测）

编码体检（自有代码 + 文档，排除 `OpenDWA/`、`basic-pitch-main/`、`PitchNet-master/` 三块 vendored）：
- **251 个文本文件**：UTF-8-BOM 7 / 二进制(含 NUL) 0 / **非 UTF-8 0**
- GBK 往返判据命中 **2 条，但都不在源码里**：
  1. `.probe-wasm-exports.txt` —— 探针 scratch 日志（`.gitignore` 第 28 行 `.probe-*.txt` 已忽略），
     中文路径被写坏成 `F:\L纁…鍝…`。**成因就是下面那条 PowerShell 重定向坑**，不是源码问题；
  2. 技能文档自己引用的乱码示例 —— 文档化的反例，属预期。
- 结论：**源码与自有文档没有真乱码**，`原型/` 与 `OpenDWA/` 也没有。

emoji 清理范围与结果：
- 白名单：`src/ wasm/src/ scripts/ types/ style-demos/ 原型/ .workbuddy/` + 根配置；
  **排除** `OpenDWA/`（第三方整块源码）与 `原型/` 下的 `basic-pitch-main`、`PitchNet-master`
- 清理量：52 文件 / 280 字符；文档语义后修 55 处；缩进塌陷后修 5 处
- 收尾三查全部为 0：清理器干跑 `files=0`、全仓无过滤扫描 0 文件 0 字符、缩进审计 0 命中

## 环境坑：PowerShell 重定向会把中文写坏

`cmd | Out-File -Encoding utf8`（或 `Set-Content`）**不能**用来落盘含中文的命令输出：
原生命令的 stdout 先按控制台代码页解码，再重编码成 UTF-8，中文必然变成
`鍣０瀹氭爣` 这类乱码。实测 `git diff` 经这条管道落盘后 377 行乱码。

**要落盘含中文的输出，让脚本自己 `writeFileSync(path, text, 'utf8')`**，
不要经过 PowerShell 管道。同理，**验收时别把「PowerShell 写坏的临时文件」
当成「项目里的乱码」**。
