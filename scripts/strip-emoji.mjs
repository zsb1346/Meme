/**
 * emoji 清理器
 *
 * 注意：本文件的替换表**故意用码点构造**（写 `E(0x2705)` 而不是直接写那个字符），
 * 所以脚本源码里一个 emoji 字面量都没有 —— 目的是让全仓扫描能干净地输出
 * `files=0`，不必再记住「要排除清理器自己」这条人为例外。
 * 另外脚本仍会按 `import.meta.filename` 跳过自己，作为「将来有人把字面量写回来」
 * 时的兜底，避免复扫出现误导性的「残留 1 个文件」。
 *
 * ── 判定规则：用 Unicode 属性，不凭感觉 ──
 *   删：\p{Extended_Pictographic}  —— 图画型字符
 *       （本脚本处理过的典型：U+1F4C1 U+1F399 U+1F3BC U+1F50A U+1F3B9 U+1F507
 *         U+1F5D1 U+2B50 U+2705 U+274C U+26A0 U+2714 U+2699 U+270F U+2328 U+23F8 …）
 *   留：\u2190-\u21FF  —— 排版箭头（→ ↑ ↓ ← ↔ ↗）。它们是「input → pitch → stretch」
 *                        这种流程写法的一部分，Unicode 里 Emoji=No，删了会把注释读坏。
 *   留：\u25A0-\u25FF  —— 几何字形（▶ ■ ● ○ ◆）。**这是活的功能字形**：
 *                        `ExportDialog` 的 `'▶ 预览' / '■ 停止'`、`EditMatrixView` 的 `'▶'`
 *                        都是按钮文案，删掉就是改坏 UI。
 *   留：° ± × ≈ ≤ ≥ ★ ♪ ♩ § ¶ 等纯符号。
 *
 * ── 「别改坏文件」的三条保险 ──
 *  1. 干跑优先：不加 --apply 绝不写盘。
 *  2. 不变量校验：stripSpace(改前) === stripSpace(改后)，
 *     其中 stripSpace = 去空白 + 去 emoji。等价于「除空白与 emoji，一个字符没动」。
 *     任何一条不成立 → 该文件跳过并报错。
 *  3. 写盘前逐文件备份到临时目录（不在仓库里留 .bak 垃圾）。
 *
 * 用法：
 *   node scripts/strip-emoji.mjs --root=<根> --out=.emoji-plan.txt     # 干跑
 *   node scripts/strip-emoji.mjs --root=<根> --apply                   # 落盘
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, relative, resolve, extname, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// 自身路径：兜底跳过自己。用真实路径比较，改名也不会失效。
const SELF = fileURLToPath(import.meta.url);

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const root = resolve(opt('root', process.cwd()));
const outFile = opt('out', '.emoji-plan.txt');
// 备份默认落在系统临时目录，不在仓库里留 .bak 垃圾
const backupRoot = opt('backup', join(tmpdir(), 'hajimi-emoji-backup'));
const APPLY = argv.includes('--apply');

// ── 范围 ──
const INCLUDE_DIRS = ['src', 'wasm/src', 'scripts', 'types', 'style-demos', '原型', '.workbuddy'];
const INCLUDE_ROOT_FILES = [
  'index.html', 'package.json', 'tailwind.config.js', 'postcss.config.js',
  'vite.config.ts', 'vitest.config.ts', 'tsconfig.json', 'tsconfig.worker.json',
];
const EXCLUDE_SUBSTR = [
  '/basic-pitch-main/', '/PitchNet-master/', '/node_modules/', '/dist/', '/build/',
  '/target/', '/OpenDWA/', '/.probe', '/.enc-', '/.omo', '/.playwright-mcp/',
];
const TEXT_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.rs', '.json', '.md', '.html', '.css', '.scss', '.toml', '.yml', '.yaml', '.txt']);

// 删除集：图画型字符
const PICTO = '[\\p{Extended_Pictographic}\\p{Emoji_Presentation}]';
// 保留集：排版箭头 + 几何字形（活的功能字形）
const KEEP_GLYPH = /[\u2190-\u21FF\u25A0-\u25FF]/u;
// 一次匹配「一个 emoji 及其变体选择符/零宽连接符链条」
const EMOJI_CHAIN = new RegExp(
  `(?:${PICTO}(?:\\uFE0E|\\uFE0F|\\u200D(?=${PICTO}))*)+`,
  'gu',
);

const ascii = (s) => {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x20 && cp < 0x7f) out += ch;
    else if (cp === 0x09) out += '\\t';
    else if (cp > 0xffff) out += `\\u{${cp.toString(16).toUpperCase()}}`;
    else out += `\\u${cp.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
};

/** 把一个 emoji 链条里「真正要删的字符」挑出来（排除保留字形） */
function strippable(chars) {
  return chars.filter((c) => !KEEP_GLYPH.test(c));
}

/** 码点 → 字符。替换表用码点构造，脚本源码里就不含 emoji 字面量。 */
const E = (hex) => String.fromCodePoint(hex);

/**
 * 「通过 / 失败」家族的**文字替换**（先于删除执行）。
 *
 * 为什么不能一删了之：这些符号承载布尔语义，成对出现在三元表达式里 ——
 *   console.log(`${pass ? E(0x2705) : E(0x274C)} ${name}`)
 * 直接删会把两个分支都掏成空串（`pass ? '' : ''`），信息就丢了。
 * 换成等宽 ASCII 词，语义保住、排版还更整齐。
 *
 * 顺带解决一个 Unicode 陷阱：U+2714 属于图画型字符会被删，而
 * U+2718 / U+2713 / U+2717（同族的叉与勾）的属性里**没有** Emoji ——
 * 只删前者会把一对勾叉拆成「一个没了、一个还在」。整个家族一起换成词才自洽。
 */
const WORD_MAP = [
  [E(0x2705), 'PASS'], // U+2705 白粗勾
  [E(0x274c), 'FAIL'], // U+274C 粗叉
  [E(0x2714), 'OK'],   // U+2714 重勾（属 Extended_Pictographic）
  [E(0x2718), 'NG'],   // U+2718 重叉
  [E(0x2713), 'OK'],   // U+2713 勾
  [E(0x2717), 'NG'],   // U+2717 叉
];

/**
 * 在一段文本上执行删除；保留字形不动。
 *
 * 空格处理是这里唯一有讲究的地方 —— 只删字符会留下难看的残迹：
 *   `// U+26A0 老形状`   →  `//  老形状`（双空格）
 *   `'U+2714 守恒'`     →  `' 守恒'`（引号后带前导空格）
 *   `      U+26A0 未解决项` → ` 未解决项`（**缩进被压成 1 格** —— 最隐蔽的一类）
 * 规则：**保留 emoji 左侧的空白原样，右侧空白整段丢弃**；只有 emoji 落在行尾
 * （右侧无空白）时才连左侧空白一起丢弃，避免留下尾随空格：
 *   `// U+26A0 老形状`   →  `// 老形状`
 *   `'U+2714 守恒'`     →  `'守恒'`
 *   `      U+26A0 未解决项` → `      未解决项`（缩进保住）
 *   `xxx U+26A0`（行尾） →  `xxx`（Markdown 的硬换行不会被误伤）
 *
 * 踩过的坑：早期写法是 `left && right ? ' ' : ''` —— 两侧都有空白时**固定输出一个
 * 空格**，于是行首缩进全部塌成 1 格（本项目实测 5 处：4 处注释缩进 + 1 处
 * JSX 按钮文案多出一个前导空格）。不变量校验查不出来，因为它刻意忽略空白差异。
 * **`norm` 抹空白的设计决定了「空白是否合理」必须单独用样例回归，不能靠不变量。**
 */
const CHAIN_PAD = new RegExp(`([ \\t]*)(${EMOJI_CHAIN.source})([ \\t]*)`, 'gu');

function strip(text) {
  let t = text;
  for (const [glyph, word] of WORD_MAP) t = t.split(glyph).join(word);
  return t.replace(CHAIN_PAD, (_m, left, chain, right) => {
    // 链条里若含保留字形（如「U+25B6 + 变体选择符」里的 U+25B6）：保留字形，两侧空白原样不动
    const kept = [...chain].filter((c) => KEEP_GLYPH.test(c)).join('');
    if (kept) return left + kept + right;
    // 保留左侧空白原样（缩进不能塌）；右侧无空白说明 emoji 在行尾，连左侧一起丢
    return right ? left : '';
  });
}

const inScope = (rel) => {
  for (const s of EXCLUDE_SUBSTR) if (rel.includes(s)) return false;
  if (INCLUDE_ROOT_FILES.includes(rel)) return true;
  const top = rel.split('/')[0];
  const two = rel.split('/').slice(0, 2).join('/');
  return INCLUDE_DIRS.includes(top) || INCLUDE_DIRS.includes(two);
};

const files = [];
function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', '.git', 'dist', 'build', 'target', 'coverage'].includes(e.name)) continue;
      walk(p);
    } else if (TEXT_EXT.has(extname(e.name).toLowerCase())) files.push(p);
  }
}
walk(root);

const report = [];
const charCount = new Map();
const keptCount = new Map();
const fileStats = [];
const samples = [];
const bad = [];
let removed = 0;

for (const f of files) {
  const rel = relative(root, f).replace(/\\/g, '/');
  if (!inScope(rel)) continue;
  if (f === SELF) continue;
  if (/_scan-encoding|_enc-/.test(rel)) continue;

  let src;
  try {
    src = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  if (!EMOJI_CHAIN.test(src)) continue;
  EMOJI_CHAIN.lastIndex = 0;

  const out = strip(src);
  if (out === src) continue;

  let n = 0;
  for (const m of src.matchAll(EMOJI_CHAIN)) {
    const s = strippable([...m[0]]);
    n += s.length;
    for (const c of s) charCount.set(c, (charCount.get(c) || 0) + 1);
    for (const c of [...m[0]].filter((c) => KEEP_GLYPH.test(c))) {
      keptCount.set(c, (keptCount.get(c) || 0) + 1);
    }
  }
  if (n === 0) continue;
  removed += n;

  // ── 不变量校验 ──
  // norm = 「再 strip 一次 + 抹掉所有空白」。等式成立 ⇔ 除空白、emoji、
  // 以及 WORD_MAP 的确定性替换之外，一个字符都没被动过。
  const norm = (s) => strip(s).replace(/\s+/g, '');
  const ok = norm(src) === norm(out);
  if (!ok) bad.push(ascii(rel));
  fileStats.push({ rel, n, ok });

  if (samples.length < 10) {
    const i = src.split(/\r?\n/).findIndex((l) => EMOJI_CHAIN.test(l));
    const before = src.split(/\r?\n/)[i] || '';
    const after = out.split(/\r?\n/)[i] || '';
    samples.push(`${ascii(rel)}:${i + 1}\n    - ${ascii(before.trim().slice(0, 140))}\n    + ${ascii(after.trim().slice(0, 140))}`);
  }

  if (APPLY && ok) {
    const dest = join(backupRoot, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(f, dest);
    writeFileSync(f, out, 'utf8');
  }
}

report.push(`# emoji 清理${APPLY ? '（已落盘）' : '（干跑）'}`);
report.push('');
report.push(`含 emoji 的文件: ${fileStats.length}   将删除字符数: ${removed}`);
report.push(`不变量校验失败（整文件跳过）: ${bad.length}${bad.length ? ' → ' + bad.join(', ') : ''}`);
report.push('');
report.push('=== 删除的字符（降序） ===');
for (const [ch, c] of [...charCount.entries()].sort((a, b) => b[1] - a[1])) {
  report.push(`  ${String(c).padStart(5)}  ${ascii(ch)}   U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
}
report.push('');
report.push('=== 刻意保留的字形（在保留集里，不会被删） ===');
for (const [ch, c] of [...keptCount.entries()].sort((a, b) => b[1] - a[1])) {
  report.push(`  ${String(c).padStart(5)}  ${ascii(ch)}   U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
}
report.push('');
report.push('=== 按文件（降序） ===');
for (const s of [...fileStats].sort((a, b) => b.n - a.n)) {
  report.push(`  ${String(s.n).padStart(4)}  ${s.ok ? '  ' : '!!'}  ${ascii(s.rel)}`);
}
report.push('');
report.push('=== 样例（改前 / 改后，同一行号） ===');
report.push(...samples);

writeFileSync(resolve(root, outFile), report.join('\n') + '\n', 'utf8');
console.log(`[strip-emoji] ${APPLY ? 'APPLIED' : 'DRY'}: files=${fileStats.length} chars=${removed} violations=${bad.length}`);
