// hajimi-audio 播放 DSP —— 离线整段「时间/音高」变换（相位声码器 + 带限重采样）。
//
// 架构（用户定稿：静态参数 + 离线预渲染）：主线程按 (素材, π, τ) 调本模块整段渲染出
// 变换后的 planar f32，包成 AudioBuffer 用原生 AudioBufferSourceNode 以 rate=1 精确播放。
// 非实时，故可用大窗 FFT，质量优先。
//
// 统一公式：out = pv_stretch( resample(x, π), τ·π )
//   变调不变时长   π=p, τ=1
//   变时长不变调   π=1, τ=r
//   变时长也变调   π=p, τ=1/p  （α=τ·π=1 → 跳过声码器，纯重采样）
// resample 用带限 sinc 防混叠；pv_stretch 用经典相位累积保证解耦时音高不漂。

use std::cell::RefCell;
use std::f64::consts::PI;

use rustfft::num_complex::Complex;
use rustfft::FftPlanner;

use crate::psola;

const FFT_N: usize = 2048;
const HOP_A: usize = FFT_N / 4; // 分析 hop（75% 重叠）
const SINC_TAPS: f64 = 16.0; // 重采样每侧抽头数



/// 带限 sinc 重采样。ratio = 输入帧/输出帧（>1 为加速/升调）。
fn resample_sinc(x: &[f32], ratio: f64) -> Vec<f32> {
    if x.is_empty() || ratio <= 0.0 {
        return Vec::new();
    }
    if (ratio - 1.0).abs() < 1e-6 {
        return x.to_vec();
    }
    let out_len = ((x.len() as f64) / ratio).floor().max(0.0) as usize;
    let mut out = vec![0f32; out_len];
    // 降采样(ratio>1)需低通到 1/ratio 防混叠；升采样不滤。
    let fc = if ratio > 1.0 { 1.0 / ratio } else { 1.0 };
    for o in 0..out_len {
        let c = o as f64 * ratio;
        let lo = (c - SINC_TAPS).ceil().max(0.0) as usize;
        let hi = (c + SINC_TAPS).floor().min((x.len() - 1) as f64) as usize;
        let mut acc = 0f64;
        let mut wsum = 0f64;
        for idx in lo..=hi {
            let dx = c - idx as f64;
            let arg = PI * dx * fc;
            let sinc = if arg.abs() < 1e-9 { 1.0 } else { arg.sin() / arg };
            let win = if dx.abs() >= SINC_TAPS {
                0.0
            } else {
                0.5 + 0.5 * (PI * dx / SINC_TAPS).cos()
            };
            let wgt = sinc * win * fc;
            acc += x[idx] as f64 * wgt;
            wsum += wgt;
        }
        out[o] = if wsum.abs() > 1e-9 { (acc / wsum) as f32 } else { 0.0 };
    }
    out
}

/// 经典相位声码器时间拉伸。alpha = 输出时长/输入时长。
/// 前后各补 FFT_N 个零再变换、裁掉补零区：保证保留区始终满重叠，消除首尾
/// 因 wnorm 不完整导致的除零放大（边缘尖峰）。
/// resets: 瞬态位置（样本索引），用于相位重置。
fn pv_stretch(x: &[f32], alpha: f64, resets: &[usize]) -> Vec<f32> {
    if x.is_empty() {
        return Vec::new();
    }
    if (alpha - 1.0).abs() < 1e-3 {
        return x.to_vec();
    }
    let pad = FFT_N;
    let mut xp = Vec::with_capacity(x.len() + 2 * pad);
    xp.resize(pad, 0.0f32);
    xp.extend_from_slice(x);
    xp.resize(pad + x.len() + pad, 0.0f32);
    
    // 调整重置位置以考虑填充偏移
    let adjusted_resets: Vec<usize> = resets.iter()
        .map(|&pos| pos + pad)
        .filter(|&pos| pos >= pad && pos < pad + x.len())
        .collect();
    
    let full = pv_stretch_inner(&xp, alpha, &adjusted_resets);
    let trim_start = (pad as f64 * alpha).round() as usize;
    let keep = (x.len() as f64 * alpha).round() as usize;
    if trim_start + keep <= full.len() {
        full[trim_start..trim_start + keep].to_vec()
    } else {
        full
    }
}

fn pv_stretch_inner(x: &[f32], alpha: f64, resets: &[usize]) -> Vec<f32> {
    if x.is_empty() {
        return Vec::new();
    }
    let n = FFT_N;
    let ha = HOP_A;
    let hs = ((ha as f64) * alpha).round().max(1.0) as usize; // 合成 hop
    let win: Vec<f32> = (0..n)
        .map(|i| (0.5 - 0.5 * (2.0 * PI * i as f64 / (n - 1) as f64).cos()) as f32)
        .collect();
    // omega 不再需要，因为相位锁定使用了更精确的瞬时频率计算

    let frames = x.len();
    let num_an = if frames >= n { (frames - n) / ha + 1 } else { 1 };
    let out_len = num_an * hs + n;
    let mut out = vec![0f32; out_len];
    let mut wnorm = vec![0f32; out_len];

    let mut prev_phase = vec![0f64; n / 2 + 1];
    let mut acc_phase = vec![0f64; n / 2 + 1];
    let mut inited = vec![false; n / 2 + 1];

    let mut planner_f = FftPlanner::new();
    let mut planner_i = FftPlanner::new();
    let fwd = planner_f.plan_fft_forward(n);
    let inv = planner_i.plan_fft_inverse(n);
    let mut spec: Vec<Complex<f32>> = vec![Complex::new(0.0, 0.0); n];

    for m in 0..num_an {
        let base = m * ha;
        for i in 0..n {
            let s = if base + i < frames { x[base + i] } else { 0.0 };
            spec[i] = Complex::new(s * win[i], 0.0);
        }
        fwd.process(&mut spec);

        // 提取幅度和相位
        let mut magnitude = vec![0f32; n / 2 + 1];
        let mut phase = vec![0f64; n / 2 + 1];
        for k in 0..=n / 2 {
            let re = spec[k].re as f64;
            let im = spec[k].im as f64;
            magnitude[k] = (re * re + im * im).sqrt() as f32;
            phase[k] = im.atan2(re);
        }

        // 检查是否需要相位重置（瞬态位置）
        let hit_reset = resets.iter().any(|&position| {
            position >= base && position < base + ha
        });

        if m == 0 || hit_reset || !inited[1] {
            // 第一帧或瞬态重置：使用分析相位初始化合成相位
            for k in 0..=n / 2 {
                acc_phase[k] = phase[k];
                prev_phase[k] = phase[k];
                inited[k] = true;
            }
        } else {
            // Identity Phase Locking (Laroche-Dolson 方法)
            // 1. 峰值检测：找到局部极大值
            let mut peak_of = vec![0usize; n / 2 + 1];
            let mut current_peak = 0usize;
            for k in 1..n / 2 {
                if magnitude[k] > magnitude[k - 1] && magnitude[k] >= magnitude[k + 1] {
                    current_peak = k;
                }
                peak_of[k] = current_peak;
            }

            // 2. 计算峰值 bin 的相位旋转
            let two_pi = 2.0 * PI;
            let mut peak_rotation = vec![0f64; n / 2 + 1];
            for k in 0..=n / 2 {
                if peak_of[k] == k || k == 0 {
                    // 峰值 bin：计算瞬时频率和相位推进
                    let expected = two_pi * k as f64 * ha as f64 / n as f64;
                    let mut delta = phase[k] - prev_phase[k] - expected;
                    delta -= two_pi * (delta / two_pi).round();
                    let instantaneous = (expected + delta) / ha as f64;
                    let advance = instantaneous * hs as f64;
                    let new_phase = acc_phase[k] + advance;
                    peak_rotation[k] = new_phase - phase[k];
                    acc_phase[k] = new_phase;
                }
            }

            // 3. 非峰值 bin 锁定到峰值 bin 的相位旋转
            for k in 0..=n / 2 {
                let peak = peak_of[k];
                if peak != k {
                    acc_phase[k] = phase[k] + peak_rotation[peak];
                }
                prev_phase[k] = phase[k];
            }
        }

        // 重建频谱
        for k in 0..=n / 2 {
            let (sin, cos) = (acc_phase[k].sin(), acc_phase[k].cos());
            let yr = magnitude[k] as f64 * cos;
            let yi = magnitude[k] as f64 * sin;
            spec[k] = Complex::new(yr as f32, yi as f32);
            if k > 0 && k < n / 2 {
                spec[n - k] = Complex::new(yr as f32, -yi as f32);
            }
        }

        inv.process(&mut spec);
        let obase = m * hs;
        // rustfft 逆变换不做 1/n 归一，手动除以 n，否则每帧输出放大 n 倍。
        let inv_n = 1.0 / n as f32;
        for i in 0..n {
            if obase + i < out_len {
                out[obase + i] += spec[i].re * inv_n * win[i];
                wnorm[obase + i] += win[i] * win[i];
            }
        }
    }

    for i in 0..out_len {
        out[i] = if wnorm[i] > 1e-6 { out[i] / wnorm[i] } else { 0.0 };
    }
    out
}

/// 单声道：out = pv_stretch(resample(x, π), τ·π)。
fn transform_channel(x: &[f32], pitch: f64, time: f64, resets: &[usize]) -> Vec<f32> {
    let r = if (pitch - 1.0).abs() < 1e-6 {
        x.to_vec()
    } else {
        resample_sinc(x, pitch)
    };
    let alpha = time * pitch;
    if (alpha - 1.0).abs() < 1e-3 {
        r
    } else {
        // 调整重置位置以考虑重采样偏移
        let adjusted_resets: Vec<usize> = resets.iter()
            .map(|&pos| (pos as f64 / pitch).round() as usize)
            .filter(|&pos| pos < r.len())
            .collect();
        pv_stretch(&r, alpha, &adjusted_resets)
    }
}

/// SOLA 时间伸缩：按波形相关性寻找最佳拼接点，再对重叠区交叉淡化。
/// 相比相位声码器不重建频谱，因此没有典型“电音/水声”；相比逐周期 PSOLA
/// 不依赖清浊音判断，气声、辅音和复杂素材也不会因检测失败而被门控成静音。
fn sola_stretch(x: &[f32], alpha: f64) -> Vec<f32> {
    if x.is_empty() || alpha <= 0.0 {
        return Vec::new();
    }
    if (alpha - 1.0).abs() < 1e-3 {
        return x.to_vec();
    }

    const WINDOW: usize = 2048;
    const OVERLAP: usize = 512;
    const SYNTH_HOP: usize = WINDOW - OVERLAP;
    const SEARCH: isize = 384;
    const SEARCH_STEP: usize = 2;
    const CORRELATION_STEP: usize = 4;

    if x.len() <= WINDOW {
        // 极短片段没有足够上下文做相关搜索，线性插值保持连续且不产生空洞。
        let out_len = ((x.len() as f64) * alpha).round().max(1.0) as usize;
        return (0..out_len)
            .map(|i| {
                let pos = i as f64 / alpha;
                let a = pos.floor() as usize;
                let frac = (pos - a as f64) as f32;
                let s0 = x[a.min(x.len() - 1)];
                let s1 = x[(a + 1).min(x.len() - 1)];
                s0 + (s1 - s0) * frac
            })
            .collect();
    }

    let target_len = ((x.len() as f64) * alpha).round().max(1.0) as usize;
    let mut out = vec![0.0f32; target_len + WINDOW];
    let first = WINDOW.min(x.len()).min(target_len);
    out[..first].copy_from_slice(&x[..first]);

    let analysis_hop = SYNTH_HOP as f64 / alpha;
    let mut expected_src = analysis_hop;
    let mut dst = SYNTH_HOP;

    while dst < target_len {
        let expected = expected_src.round() as isize;
        let min_src = (expected - SEARCH).max(0) as usize;
        let max_src = (expected + SEARCH)
            .max(0)
            .min(x.len().saturating_sub(WINDOW) as isize) as usize;

        let mut best_src = min_src;
        let mut best_score = f64::NEG_INFINITY;
        for candidate in (min_src..=max_src).step_by(SEARCH_STEP) {
            let available = OVERLAP.min(target_len.saturating_sub(dst));
            let mut dot = 0.0f64;
            let mut aa = 0.0f64;
            let mut bb = 0.0f64;
            for i in (0..available).step_by(CORRELATION_STEP) {
                let a = out[dst + i] as f64;
                let b = x[candidate + i] as f64;
                dot += a * b;
                aa += a * a;
                bb += b * b;
            }
            let score = dot / (aa * bb).sqrt().max(1e-12);
            if score > best_score {
                best_score = score;
                best_src = candidate;
            }
        }

        let frame_len = WINDOW
            .min(x.len().saturating_sub(best_src))
            .min(target_len.saturating_sub(dst));
        let overlap = OVERLAP.min(frame_len);
        for i in 0..overlap {
            let t = i as f32 / overlap.max(1) as f32;
            out[dst + i] = out[dst + i] * (1.0 - t) + x[best_src + i] * t;
        }
        for i in overlap..frame_len {
            out[dst + i] = x[best_src + i];
        }

        dst += SYNTH_HOP;
        expected_src += analysis_hop;
    }

    out.truncate(target_len);
    out
}

/// FL Stretch 风格：先带限重采样改变音高，再用 SOLA 恢复独立目标时长。
fn transform_channel_sola(x: &[f32], pitch: f64, time: f64) -> Vec<f32> {
    let pitched = if (pitch - 1.0).abs() < 1e-6 {
        x.to_vec()
    } else {
        resample_sinc(x, pitch)
    };
    sola_stretch(&pitched, time * pitch)
}

/// 简单的瞬态检测：基于能量变化
fn detect_transients(x: &[f32], threshold: f32) -> Vec<usize> {
    if x.len() < 1024 {
        return Vec::new();
    }
    
    let window_size = 512;
    let hop = 256;
    let mut transients = Vec::new();
    
    // 计算能量
    let mut energy = Vec::new();
    for i in (0..x.len()).step_by(hop) {
        let end = (i + window_size).min(x.len());
        let mut sum = 0.0;
        for j in i..end {
            sum += x[j] * x[j];
        }
        energy.push(sum / (end - i) as f32);
    }
    
    // 检测能量突变
    for i in 1..energy.len() {
        if energy[i] > energy[i - 1] * threshold && energy[i] > 0.01 {
            transients.push(i * hop);
        }
    }
    
    transients
}

// ---------------------------------------------------------------------------
// extern "C" 导出（结果暂存，JS 按指针读回）
// ---------------------------------------------------------------------------

struct TxOut {
    channels: Vec<Vec<f32>>,
    frames: usize,
}

thread_local! {
    static TX: RefCell<Option<TxOut>> = const { RefCell::new(None) };
}

/// 变换 planar f32。in_ptr 处 ch 段 × frames 连续。返回输出帧数（<=0 失败）。
#[no_mangle]
pub extern "C" fn hajimi_tx_run(
    in_ptr: *const f32,
    frames: u32,
    ch: u32,
    pitch: f32,
    time: f32,
    mode: u32,          // 0=声码器, 1=PSOLA, 2=SOLA/FL Stretch 风格
    sample_rate: f32,   // 采样率
) -> i32 {
    if in_ptr.is_null() || frames == 0 || ch == 0 {
        return -1;
    }
    // 诊断计数清零：调用方在 mode=1 之后读 `hajimi_tx_voiced_frames()` 判断本次
    // 变调是不是「成功但没做事」（详见 psola::LAST_VOICED）。非 mode=1 时保持 0。
    psola::reset_last_voiced_stats();
    let total = frames as usize * ch as usize;
    let flat = unsafe { std::slice::from_raw_parts(in_ptr, total) };
    let nch = ch as usize;
    let mut planar: Vec<&[f32]> = Vec::new();
    for c in 0..nch {
        let begin = c * frames as usize;
        planar.push(&flat[begin..begin + frames as usize]);
    }
    let pitch_raw = if pitch.is_finite() && pitch > 0.0 { pitch as f64 } else { 1.0 };
    let time_raw = if time.is_finite() && time > 0.0 { time as f64 } else { 1.0 };
    
    let outs: Vec<Vec<f32>> = if mode == 1 || mode == 3 {
        // PSOLA 人声路径——所有编排逻辑集中在 psola::apply_planar
        let sr = if sample_rate > 0.0 { sample_rate } else { 48000.0 };
        // 颗粒周期钳位照搬 PitchNet kMinPitchRatio / kMaxPitchRatio（±24 半音）。
        // 曾经是 [0.5, 2.0]（±12 半音），于是 mode 1 会在没有任何提示的情况下
        // 把 +13 半音悄悄夹成 +12，而 mode 0/2 不夹 —— 同一个 UI 参数在两个引擎上
        // 语义不一致。现在与 PitchNet 对齐，超出范围由 DSP 层统一收敛。
        let p = pitch_raw.clamp(0.25, 4.0);
        let t = time_raw.clamp(0.25, 4.0);
        if mode == 3 {
            // mode 3 = PSOLA + 谐波/噪声分离（降调时压制「沙沙」，见 psola 模块 E）。
            // 与 mode 1 唯一的区别就是内核入口，参数与钳位完全一致。
            psola::apply_planar_harmonic(&planar, sr, p as f32, t as f32)
        } else {
            psola::apply_planar(&planar, sr, p as f32, t as f32)
        }
    } else if mode == 2 {
        planar
            .iter()
            .map(|p| transform_channel_sola(p, pitch_raw, time_raw))
            .collect()
    } else {
        // 原声码器路径
        let resets = if nch > 0 && (time_raw * pitch_raw - 1.0).abs() > 1e-3 {
            detect_transients(planar[0], 1.5)
        } else {
            Vec::new()
        };
        
        planar.iter().map(|p| transform_channel(p, pitch_raw, time_raw, &resets)).collect()
    };
    
    let min_len = outs.iter().map(|v| v.len()).min().unwrap_or(0);
    if min_len == 0 {
        return -2;
    }
    let channels: Vec<Vec<f32>> = outs.into_iter().map(|mut v| {
        v.truncate(min_len);
        v
    }).collect();
    TX.with(|t| *t.borrow_mut() = Some(TxOut { channels, frames: min_len }));
    min_len as i32
}

#[no_mangle]
pub extern "C" fn hajimi_tx_channels() -> i32 {
    TX.with(|t| t.borrow().as_ref().map(|o| o.channels.len() as i32).unwrap_or(0))
}

#[no_mangle]
pub extern "C" fn hajimi_tx_frames() -> i32 {
    TX.with(|t| t.borrow().as_ref().map(|o| o.frames as i32).unwrap_or(0))
}

#[no_mangle]
pub extern "C" fn hajimi_tx_channel_ptr(c: usize) -> *const f32 {
    TX.with(|t| match t.borrow().as_ref() {
        Some(o) => o.channels.get(c).map(|v| v.as_ptr()).unwrap_or(std::ptr::null()),
        None => std::ptr::null(),
    })
}

#[no_mangle]
pub extern "C" fn hajimi_tx_free() {
    TX.with(|t| *t.borrow_mut() = None);
}

/// 上一次 `hajimi_tx_run` 里被判为 voiced 的帧数（只有 mode=1 会填）。
///
/// 用途单一：识别**静默空转**。PSOLA 对非周期素材会整段走固定颗粒路径，那等于
/// 「按时间映射重采样」，**音高不移动**，却照样返回一段合法音频、不抛异常。
/// 调用方（`playSample` 的降级链）是靠 catch 推进的，于是以为成功了 ——
/// 这就是「装配面板 Shift+↑ 在部分素材上完全没反应」的机制。
///
/// 判定规则：`pitch != 1 && hajimi_tx_voiced_frames() == 0` → 本次 mode=1 什么
/// 都没做，应当降级到 SOLA。实测真素材 41 个里 13 个会命中这一条。
///
/// 另一个可用值是 pitch mark 数（`hajimi_tx_marks()`），但 voiced 帧数更靠前、
/// 更能反映「有没有周期可同步」这个本质。
#[no_mangle]
pub extern "C" fn hajimi_tx_voiced_frames() -> i32 {
    psola::last_voiced_stats().0 as i32
}

/// 上一次 mode=1 渲染得到的 pitch mark 数。见 [`hajimi_tx_voiced_frames`]。
#[no_mangle]
pub extern "C" fn hajimi_tx_marks() -> i32 {
    psola::last_voiced_stats().1 as i32
}
