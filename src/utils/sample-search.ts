/**
 * sample-search —— 素材名搜索工具（LibraryPage 素材箱 / NotePalette 装配面板共用）。
 *
 * 四种匹配模式，单输入框自动识别（无需模式切换）：
 *  - 精准字符串：`名称 === 查询`（全等，最高优先级）
 *  - 模糊字符串：`名称.includes(查询)`（连续子串，大小写不敏感）
 *  - 模糊拼音：  纯字母查询 → 命中「名称全拼」的子串（含首字母前缀），如 `haji` → 哈吉米
 *  - 首字母搜索：纯字母查询 → 命中「各字拼音首字母」序列，如 `hjm` → 哈吉米
 *
 * 排序：命中得分高的在前；空查询由调用方自行排序（通常按 createdAtMs）。
 * 打分逻辑见 matchName 内注释，保证同分时名称自然稳定。
 */
import { pinyin } from 'pinyin-pro';

/** 单个名称的拼音派生索引 */
interface NameIndex {
  /** 全拼（无空格、小写），如 "hajimi"；含非中文原样保留 */
  full: string;
  /** 首字母序列（无空格、小写），如 "hjm" */
  initials: string;
}

// 模块级小缓存：名称 → 索引。素材名通常几十个，缓存无内存压力；
// 名称可变（重命名），缓存 key 是字符串本身，天然自洽无需失效。
const indexCache = new Map<string, NameIndex>();

/** 去掉空白（拼音输出以空格分词，查询串也可能带空格） */
const compact = (s: string): string => s.replace(/\s+/g, '');

/**
 * 取「拼音词干」：剥掉末尾的扩展名与重复序号。
 *
 * 素材名普遍是 `张三.mp3` / `重庆.002.mp3` 这种「词干 [+ .序号] + 扩展名」。
 * **必须剥掉再建拼音索引** —— 否则全拼永远只能落到最宽松的「前缀」档
 * （`zhangsan.mp3`.startsWith(`zhangsan`)，而不是全等），
 * 「全拼精确 / 首字母精确」两档形同虚设，`张三.mp3` 会排在 `张三丰.mp3` 之后。
 *
 * 字面匹配**不受影响**：`mp3`、`002` 这类查询仍由模糊子串路径命中带后缀的原名。
 */
function pinyinStem(name: string): string {
  const stem = name.replace(/(?:\.[0-9]+)?\.[a-zA-Z0-9]{1,5}$/, '');
  return stem || name; // 形如 ".mp3" 的极端名 → 退回原名，避免空串
}

export function getNameIndex(name: string): NameIndex {
  const cached = indexCache.get(name);
  if (cached) return cached;

  // 整体调用 pinyin() 让上下文消歧生效（如「乐音」→ yue yin，非逐字 le/yin）
  // nonZh:'consecutive' 保持非中文连续（如 "v2" 不拆成 "v","2"）
  const segments: string[] = pinyin(pinyinStem(name), {
    toneType: 'none',
    type: 'array',
    nonZh: 'consecutive',
  });

  // 全拼：各段直接拼接，如 ["ha","ji","mi","v2"] → "hajimiv2"
  const full = compact(segments.join('')).toLowerCase();

  // 首字母：取每段的首个拉丁字母；非中文段（含数字/符号）整段保留
  // 如 ["ha","ji","mi","v2"] → ["h","j","m","v2"] → "hjmv2"
  const initials = compact(
    segments
      .map((seg) => {
        // 纯拉丁字母段 → 取首字母；含数字/符号的段 → 非中文，整段保留
        return /^[a-zA-Z]+$/.test(seg) ? seg[0].toLowerCase() : seg.toLowerCase();
      })
      .join(''),
  ).toLowerCase();

  const index: NameIndex = { full, initials };
  indexCache.set(name, index);
  return index;
}

export type MatchMode = 'exact' | 'fuzzy' | 'pinyin' | 'initial';

export interface SampleMatch {
  score: number;
  mode: MatchMode | null;
}

/** 判断查询词是否为纯拉丁字母/数字串（可能含空格）。含中文/符号的走字符串匹配路径。 */
function isLatinQuery(q: string): boolean {
  return /^[a-zA-Z0-9\s]+$/.test(q);
}

/**
 * 对单个名称打分（>0 表示命中）。分值刻意分档，便于上层只按 score 排序：
 * 精准 5000 > 模糊字符串 2000~ > 首字母精确 1500 > 首字母前缀 1300 >
 * 拼音精确 1100 > 拼音前缀 900 > 首字母子串 700 > 拼音子串 500~。
 * 子串类命中用「起点越靠前分越高」区分相关性。
 */
export function matchName(name: string, query: string): SampleMatch {
  const qRaw = query.trim();
  if (!qRaw) return { score: 0, mode: null };

  const q = qRaw.toLowerCase();
  const qc = compact(q); // 查询串去空白，用于拼音/首字母比较
  if (!qc) return { score: 0, mode: null };

  const lower = name.toLowerCase();
  const lowerC = compact(lower);

  // 1) 精准字符串：名称与查询全等（忽略空白差异、大小写）
  if (lowerC === qc) return { score: 5000, mode: 'exact' };

  // 2) 模糊字符串：连续子串命中。非纯字母查询（含中文/数字）只走这条 + 精准
  const subIdx = lower.indexOf(q);
  if (subIdx >= 0) {
    return { score: 2000 - Math.min(subIdx, 500), mode: 'fuzzy' };
  }

  // 3) 拼音 / 首字母：仅当查询为纯拉丁字母串才可能命中
  if (!isLatinQuery(qRaw)) return { score: 0, mode: null };

  const { full, initials } = getNameIndex(name);

  // 首字母精确命中（如 hjm == hjm）：覆盖"整名缩写"场景
  if (initials === qc) return { score: 1500, mode: 'initial' };
  // 首字母前缀（如 hjm 是 hjmv2 的前缀）
  if (initials.startsWith(qc)) return { score: 1300, mode: 'initial' };
  // 拼音精确命中（如 hajimi == 哈吉米的全拼）
  if (full === qc) return { score: 1100, mode: 'pinyin' };
  // 拼音前缀（如 haji 是 hajimi 的前缀）
  if (full.startsWith(qc)) return { score: 900, mode: 'pinyin' };
  // 首字母子串（如 jm 落在 hjmv2 中间）
  const iniSub = initials.indexOf(qc);
  if (iniSub >= 0) return { score: 700 - Math.min(iniSub, 200), mode: 'initial' };
  // 拼音子串（最宽松：任意位置包含）
  const pySub = full.indexOf(qc);
  if (pySub >= 0) return { score: 500 - Math.min(pySub, 300), mode: 'pinyin' };

  return { score: 0, mode: null };
}

/**
 * 通用过滤 + 相关度排序。接受任意带 name 的对象数组，返回过滤后按 score 降序的新数组。
 * 空查询返回原数组（不排序，调用方自行按 createdAtMs 等）。
 */
export function searchByName<T extends { name: string }>(
  items: T[],
  query: string,
): T[] {
  const q = query.trim();
  if (!q) return items;

  const scored = items
    .map((it) => ({ it, m: matchName(it.name, q) }))
    .filter((x) => x.m.score > 0)
    .sort(
      (a, b) =>
        b.m.score - a.m.score || a.it.name.localeCompare(b.it.name, 'zh'),
    );
  return scored.map((x) => x.it);
}
