// YIN 基频检测（移植自旧 src/engine/pitch.ts，行为对齐）。
//
// 算法核心在 yin_core.rs；本文件只做「多帧扫描 + 高置信中位数」的编排。
//
// **这是项目里唯一的 YIN 实现**。JS 侧曾经有一份同名同算法的副本
// （`src/engine/pitch.ts::detectPitchYinCore`），两者的兜底逻辑各自演化，
// 结果在 41 个真素材上：wasm 未检出 **2/41**，JS 未检出 **15/41**，且
// JS 那 15 个的可用结果全是 wasm 的子集（见 `scripts/probe-ai/probe-yin-parity.html`）。
// 现在面板路径改为经 [`crate::hajimi_yin_f32`] 调回这里，JS 版只留作
// wasm 加载失败时的应急退路 —— **不要再往 JS 版里补算法**。

use crate::yin_core;

/// 默认 CMND 阈值（越低越严格）。
pub const DEFAULT_THRESHOLD: f32 = 0.12;
const WIN: usize = 2048;
const MAX_SCAN_FRAMES: usize = 24;
/// 默认频率上下限。
pub const DEFAULT_MIN_HZ: f32 = 65.0;
pub const DEFAULT_MAX_HZ: f32 = 1200.0;

/// 在单声道 f32 数据上检测基频；返回 Hz，0.0 = 未检出。
/// 多帧扫描取「高置信度前半」的频率中位数，显著抗噪。
pub fn detect_pitch(data: &[f32], sample_rate: u32) -> f32 {
    detect_pitch_opts(
        data,
        sample_rate,
        DEFAULT_THRESHOLD,
        DEFAULT_MIN_HZ,
        DEFAULT_MAX_HZ,
    )
}

/// 与 [`detect_pitch`] 同一条路径，只是阈值与频率上下限可调。
///
/// 面板上的「阈值 / 最低 Hz / 最高 Hz」三个参数要真的作用到检测上，
/// 所以把这套编排参数化 —— 但**算法本体只有一份**（`yin_core`），
/// 参数化只影响范围与门限，不影响兜底逻辑。
/// `threshold <= 0` / `min_hz <= 0` / `max_hz <= 0` 时退回默认值。
pub fn detect_pitch_opts(
    data: &[f32],
    sample_rate: u32,
    threshold: f32,
    min_hz: f32,
    max_hz: f32,
) -> f32 {
    if data.len() < WIN + 2 {
        return 0.0;
    }
    let threshold = if threshold > 0.0 { threshold } else { DEFAULT_THRESHOLD };
    let min_hz = if min_hz > 0.0 { min_hz } else { DEFAULT_MIN_HZ };
    let max_hz = if max_hz > 0.0 { max_hz } else { DEFAULT_MAX_HZ };
    if max_hz <= min_hz {
        return 0.0;
    }

    let sr = sample_rate as f32;
    let min_tau = ((sr / max_hz).floor() as usize).max(2);
    let max_tau = ((sr / min_hz).ceil() as usize).min(WIN - 2);
    if max_tau <= min_tau {
        return 0.0;
    }

    let usable = data.len() - WIN;
    let stride = (usable / MAX_SCAN_FRAMES).max(1);

    let mut freqs: Vec<f32> = Vec::new();
    let mut off = 0usize;
    while off + WIN + max_tau <= data.len() {
        if let Some(r) = yin_core::yin_frame(data, off, WIN, min_tau, max_tau, threshold, sr) {
            freqs.push(r.freq);
        }
        off += stride;
    }
    if freqs.is_empty() {
        // YIN 一帧都没过阈值 → 自相关兜底。
        //
        // 这一条直接决定「自动修音」能不能用：`detectedPitchHz` 为 null 时
        // `sampleSemitonesAtPitch` 会**静默退回** manualSemitoneOffset（默认 0），
        // 于是自动修音开关按下去毫无效果 —— 实测真素材 41 个里有 14 个是这样。
        return autocorr_fallback(data, sr, min_tau, max_tau);
    }

    // 按频率排序取中位数（简单抗离群）
    freqs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(core::cmp::Ordering::Equal));
    freqs[freqs.len() / 2]
}

/// 自相关兜底检测 + **帧间一致性**闸门。
///
/// 单帧的自相关兜底仍可能在「实在没有音高」的素材上给出散布的值 —— 实测
/// 「绿.mp3」（192ms，YIN 与神经检测都拒检）各帧分别落在 103Hz / 302Hz 这种
/// 互相矛盾的位置。真正的音高在帧间是稳定的，所以这里加一道自检：
/// **通过闸门的帧里必须有半数以上互相同意（±100 音分）**，否则一律返回未检出。
///
/// 这样「实在没音高」的素材仍然得到 null（行为不比从前差），而真正的短切片
/// 能拿到一个可信的音高（实测 14 个 YIN 漏检素材里救回 13 个）。
fn autocorr_fallback(data: &[f32], sr: f32, min_tau: usize, max_tau: usize) -> f32 {
    if max_tau <= min_tau {
        return 0.0;
    }

    let stride = ((data.len() - WIN) / MAX_SCAN_FRAMES).max(1);
    let mut freqs: Vec<f32> = Vec::new();
    let mut off = 0usize;
    while off + WIN + max_tau <= data.len() {
        if let Some(r) = yin_core::autocorr_frame(data, off, WIN, min_tau, max_tau, sr) {
            freqs.push(r.freq);
        }
        off += stride;
    }
    if freqs.is_empty() {
        return 0.0;
    }

    freqs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(core::cmp::Ordering::Equal));
    let med = freqs[freqs.len() / 2];
    if med <= 0.0 {
        return 0.0;
    }
    let agree = freqs
        .iter()
        .filter(|f| (1200.0 * (**f / med).log2()).abs() <= 100.0)
        .count();
    if agree * 2 < freqs.len() {
        return 0.0;
    }
    med
}
