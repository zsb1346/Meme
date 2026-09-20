/**
 * 通用展示格式化工具（Wave 1 地基）。
 *
 * 本波次只提供实现，不迁移任何调用方 —— 各页面现存的本地格式化函数
 * 由后续 Wave 统一切换到此处，切换前行为必须逐字节一致。
 */

/**
 * 素材/录制时长短标签：≥10s 一位小数，<10s 两位小数。
 * 例：formatDuration(3.456) → "3.46s"；formatDuration(12.34) → "12.3s"
 */
export function formatDuration(sec: number): string {
  return sec >= 10 ? `${sec.toFixed(1)}s` : `${sec.toFixed(2)}s`;
}

/**
 * 播放头时间标签：m:ss.d（秒部分零填充到 X.X 两位宽度）。
 * 非有限值 / 负数一律按 0 处理。
 * 例：formatTime(65.42) → "1:05.4"；formatTime(3.07) → "0:03.1"
 */
export function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '0:00.0';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/**
 * 频率标签：≥1000 Hz 以 kHz 展示，其余以 Hz；最多保留两位有效小数。
 * null / undefined（音高未检出）返回空字符串，由调用方决定占位文案。
 * 例：formatHz(3200) → "3.2 kHz"；formatHz(261.63) → "261.63 Hz"；formatHz(null) → ""
 */
export function formatHz(hz?: number | null): string {
  if (hz === null || hz === undefined || !Number.isFinite(hz)) return '';
  // 与页面内 trimNum 同规则：toFixed(2) 后去掉尾随零
  const trimNum = (n: number): string => String(Number(n.toFixed(2)));
  return hz >= 1000 ? `${trimNum(hz / 1000)} kHz` : `${trimNum(hz)} Hz`;
}

/* ═══════════════════════════════════════════════════════════════════
   去重命名 —— 切片入库 / 批量导入时的默认名生成
   ═══════════════════════════════════════════════════════════════════ */

/**
 * 在已有名字集合中生成一个不冲突的默认名。
 *
 * 规则（对应用户反馈的「名称体验」）：
 *   1. 首选 `${base} ${n}`，n 从 1 开始递增，取第一个未被占用的；
 *   2. 若名字池里存在裸 `${base}`，则跳过 `1`（避免出现
 *      「测试素材」与「测试素材 1」并存这种看着像重复的命名）；
 *   3. 一定返回不冲突的名字，调用方不必再判重。
 *
 * 例（existing 含 "测试素材"）：uniqueName("测试素材", existing) → "测试素材 2"
 * 例（existing 为空）：        uniqueName("测试素材", existing) → "测试素材 1"
 */
export function uniqueName(base: string, existing: Iterable<string>): string {
  const taken = new Set<string>();
  for (const n of existing) taken.add(n);
  const trimmed = base.trim() || '未命名';
  if (!taken.has(trimmed)) return trimmed; // 裸名可用则直接用，最干净
  let i = 1;
  while (taken.has(`${trimmed} ${i}`)) i++;
  return `${trimmed} ${i}`;
}

/**
 * 切片默认名：`${源素材名} 切片` 去重。
 * 例：源「喵叫」且已有「喵叫 切片」→「喵叫 切片 2」
 */
export function defaultSliceName(
  sourceName: string,
  existing: Iterable<string>,
): string {
  return uniqueName(`${sourceName.trim() || '素材'} 切片`, existing);
}

/**
 * 上传默认名：去掉扩展名后本身已足够可读，故不再追加后缀；
 * 仅在同名时补序号。
 * 例：文件名 "喵叫.mp3" → "喵叫"
 */
export function defaultUploadName(fileName: string, existing: Iterable<string>): string {
  const base = fileName.replace(/\.[^.]+$/, '').trim() || '素材';
  return uniqueName(base, existing);
}
