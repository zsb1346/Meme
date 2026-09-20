/**
 * 键盘绑定工具——演奏台和录制棚共享。
 */

/** 根据绑定表查找按键对应的键位索引 */
export function findKeyIndexByKey(
  bindings: Record<number, string>,
  key: string,
): number | null {
  for (const [ki, k] of Object.entries(bindings)) {
    if (k === key) return Number(ki);
  }
  return null;
}
