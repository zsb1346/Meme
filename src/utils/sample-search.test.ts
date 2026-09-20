/**
 * sample-search 特征化测试 —— 素材名搜索的四种匹配模式与相关度排序。
 *
 * 这套工具同时服务素材箱（LibraryPage）与逐音装配面板（NotePalette），
 * 所以「张三.mp3 能被 张三 / zhang / zs / zhangsan 搜到」这类验收用例
 * 必须钉在这里，而不是各调用点各测一遍。
 *
 * 覆盖：
 * 1. 精准 / 模糊子串 / 大小写不敏感；
 * 2. 全拼（精确、前缀、子串）；
 * 3. 首字母（精确、前缀、子串）；
 * 4. 多音字由 pinyin-pro 依上下文消歧（重庆 → chongqing / cq）；
 * 5. 非中文名不受拼音化影响（"v2" 不拆碎）；
 * 6. 相关度排序：精准 > 名称子串 > 首字母 > 拼音，同分按名称稳定；
 * 7. 空查询原样返回（不排序，由调用方决定默认序）。
 */

import { describe, expect, it } from 'vitest';

import { getNameIndex, matchName, searchByName } from './sample-search';

const NAMES = ['张三.mp3', '李四.mp3', '张三丰.mp3', '哈吉米.mp3', '重庆.002.mp3'];
const items = NAMES.map((name) => ({ name }));
const names = (q: string) => searchByName(items, q).map((x) => x.name);

// ---------------------------------------------------------------------------
// 1. 字符串匹配
// ---------------------------------------------------------------------------

describe('字符串匹配', () => {
  it('精准：名称与查询全等（忽略空白与大小写）', () => {
    expect(matchName('kick.mp3', 'kick.mp3').mode).toBe('exact');
    expect(matchName('KICK.MP3', 'kick.mp3').mode).toBe('exact');
  });

  it('模糊：连续子串命中，大小写不敏感', () => {
    expect(matchName('Kick Drum.mp3', 'ick').mode).toBe('fuzzy');
    expect(matchName('Kick Drum.mp3', 'kick').mode).toBe('fuzzy');
  });

  it('子串起点越靠前分越高', () => {
    const a = matchName('吉米米', '吉米').score;
    const b = matchName('哈吉米', '吉米').score;
    expect(a).toBeGreaterThan(b);
  });

  it('不相关查询不命中', () => {
    expect(matchName('张三.mp3', 'wangwu').score).toBe(0);
    expect(matchName('张三.mp3', '李四').score).toBe(0);
  });

  it('空查询不命中（由调用方处理空态）', () => {
    expect(matchName('张三.mp3', '').score).toBe(0);
    expect(matchName('张三.mp3', '   ').score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2~3. 拼音 / 首字母（用户验收用例）
// ---------------------------------------------------------------------------

describe('拼音与首字母（验收用例：张三.mp3）', () => {
  it('原文：张三', () => {
    expect(names('张三')).toContain('张三.mp3');
  });

  it('全拼前缀：zhang', () => {
    expect(names('zhang')).toContain('张三.mp3');
  });

  it('首字母：zs', () => {
    expect(names('zs')).toContain('张三.mp3');
  });

  it('全拼：zhangsan', () => {
    expect(names('zhangsan')).toContain('张三.mp3');
  });

  it('全拼：lisi → 李四.mp3', () => {
    expect(names('lisi')).toEqual(['李四.mp3']);
  });

  it('大小写不敏感：ZhangSan', () => {
    expect(names('ZhangSan')).toContain('张三.mp3');
  });

  it('全拼精确比全拼前缀得分高', () => {
    // zhangsan 对「张三.mp3」是全拼精确；对「张三丰.mp3」只是前缀
    expect(matchName('张三.mp3', 'zhangsan').score).toBeGreaterThan(
      matchName('张三丰.mp3', 'zhangsan').score,
    );
  });

  it('首字母精确比拼音子串得分高', () => {
    expect(matchName('张三.mp3', 'zs').mode).toBe('initial');
    expect(matchName('张三.mp3', 'zs').score).toBeGreaterThan(
      matchName('张三.mp3', 'hangsa').score,
    );
  });
});

describe('多音字与上下文消歧', () => {
  it('重庆 → chongqing 与 cq 都能命中', () => {
    expect(names('chongqing')).toContain('重庆.002.mp3');
    expect(names('cq')).toContain('重庆.002.mp3');
  });
});

describe('非中文名不被拼音化干扰', () => {
  it('拉丁名照常按子串命中', () => {
    expect(searchByName([{ name: 'kick-v2.mp3' }], 'v2').map((x) => x.name)).toEqual([
      'kick-v2.mp3',
    ]);
  });

  it('拼音索引建在「词干」上：扩展名与重复序号被剥掉', () => {
    // 若不剥后缀，全拼只能落到「前缀」档 → 精准档失效、排序退化
    expect(getNameIndex('张三.mp3').full).toBe('zhangsan');
    expect(getNameIndex('张三.mp3').initials).toBe('zs');
    expect(getNameIndex('重庆.002.mp3').full).toBe('chongqing');
    expect(getNameIndex('重庆.002.mp3').initials).toBe('cq');
  });

  it('无扩展名的名称不受影响', () => {
    expect(getNameIndex('张三').full).toBe('zhangsan');
  });

  it('剥后缀不影响字面匹配：mp3 / 序号 仍能搜到', () => {
    expect(names('mp3').length).toBe(NAMES.length);
    expect(names('002')).toEqual(['重庆.002.mp3']);
  });
});

// ---------------------------------------------------------------------------
// 6~7. 排序与空态
// ---------------------------------------------------------------------------

describe('searchByName', () => {
  it('空查询原样返回（不排序，保持调用方顺序）', () => {
    expect(searchByName(items, '')).toBe(items);
    expect(searchByName(items, '   ')).toBe(items);
  });

  it('结果按相关度降序：精准 > 名称子串 > 拼音', () => {
    // 「张三」全等 5000；「张三丰」子串起点 0 → 2000；「小张三」子串起点 1 → 1999
    const r = searchByName(
      [{ name: '张三' }, { name: '小张三' }, { name: '张三丰' }],
      '张三',
    );
    expect(r.map((x) => x.name)).toEqual(['张三', '张三丰', '小张三']);
  });

  it('全拼精确（张三.mp3）排在全拼前缀（张三丰.mp3）之前', () => {
    expect(names('zhangsan')[0]).toBe('张三.mp3');
  });

  it('只返回命中的项', () => {
    expect(names('wangwu')).toEqual([]);
  });

  it('中文查询不会误走拼音路径', () => {
    // 「张三」对「李四.mp3」不应命中，且不应因拼音而扩大命中面
    expect(names('张三')).toEqual(['张三.mp3', '张三丰.mp3']);
  });
});
