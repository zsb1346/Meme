// yin_core —— YIN 基频检测的共享算法核心。
//
// yin.rs::detect_pitch 和 psola.rs::track_pitch 都调用这里的函数，
// 只在参数适配层做各自的 F0 范围、窗参数、后处理差异。
//
// 性能：这里的差分函数是整个「变调 / 拉伸」链路里唯一的大头 ——
// 实测占 hajimi_tx_run mode=1 总耗时的 ~78%（逐帧 YIN 是 O(win × max_tau)，
// 一帧约 200 万次浮点乘加）。下面两处优化都是针对它，且都不改变数值结果：
//   ① 内层用切片 zip 而不是 `x[j]` / `x[j + tau]` 双重索引 —— 后者无法让
//      编译器证明下标在界内，每次迭代都留一次边界检查；
//   ② 差分 / CMND 缓冲提到 thread_local 复用，不再每帧两次 vec! 分配
//      （30 秒素材约 3000 帧 → 6000 次分配）。

use std::cell::RefCell;

/// 单帧 YIN 结果。
pub struct YinResult {
    pub freq: f32,
    pub conf: f32,
}

thread_local! {
    /// (diff, cmnd, ac) 复用缓冲。wasm 单线程，thread_local 等价于全局。
    /// `yin_frame` 只用前两个；`autocorr_frame` 三个都用。
    static SCRATCH: RefCell<(Vec<f32>, Vec<f32>, Vec<f32>)> =
        const { RefCell::new((Vec::new(), Vec::new(), Vec::new())) };
}

/// 单帧 YIN：差分函数 → CMND → 阈值搜索 → 抛物线插值。
///
/// 调用方保证 `offset + win + max_tau <= x.len()`，故 `x[j + tau]` 恒不越界。
pub fn yin_frame(
    x: &[f32],
    offset: usize,
    win: usize,
    min_tau: usize,
    max_tau: usize,
    threshold: f32,
    sample_rate: f32,
) -> Option<YinResult> {
    if win == 0 || max_tau == 0 || offset + win + max_tau > x.len() {
        return None;
    }

    SCRATCH.with(|cell| {
        let mut scratch = cell.borrow_mut();
        let (diff, cmnd, _ac) = &mut *scratch;
        if diff.len() < max_tau + 1 {
            diff.resize(max_tau + 1, 0.0);
            cmnd.resize(max_tau + 1, 0.0);
        }
        let diff = &mut diff[..=max_tau];
        let cmnd = &mut cmnd[..=max_tau];

        // ---- 差分函数 d(tau) = Σ_j (x[j] - x[j+tau])² ----
        //
        // 用不可变切片 + zip：两个子切片各自只做一次边界检查，内层循环因此
        // 完全没有下标检查（原先 `x[j]` / `x[j + tau]` 双索引每次迭代都要判两次）。
        let a = &x[offset..offset + win];
        for tau in 1..=max_tau {
            let b = &x[offset + tau..offset + tau + win];
            let mut sum = 0.0f32;
            for (p, q) in a.iter().zip(b.iter()) {
                let delta = p - q;
                sum += delta * delta;
            }
            diff[tau] = sum;
        }

        // ---- CMND ----
        cmnd[0] = 1.0;
        let mut running = 0.0f32;
        for tau in 1..=max_tau {
            running += diff[tau];
            cmnd[tau] = if running == 0.0 {
                1.0
            } else {
                (diff[tau] * tau as f32) / running
            };
        }

        // ---- 阈值搜索 ----
        let mut tau_est: Option<usize> = None;
        for tau in min_tau..=max_tau {
            if cmnd[tau] < threshold {
                let mut t = tau;
                while t + 1 <= max_tau && cmnd[t + 1] < cmnd[t] {
                    t += 1;
                }
                tau_est = Some(t);
                break;
            }
        }
        let tau_est = tau_est?;

        // ---- 抛物线插值 ----
        let mut better_tau = tau_est as f32;
        if tau_est > min_tau && tau_est < max_tau {
            let a = cmnd[tau_est - 1];
            let b = cmnd[tau_est];
            let c = cmnd[tau_est + 1];
            let denom = 2.0 * (a + c - 2.0 * b);
            if denom != 0.0 {
                better_tau = tau_est as f32 + (a - c) / denom;
            }
        }

        let freq = sample_rate / better_tau;
        if !freq.is_finite() || freq <= 0.0 {
            return None;
        }
        Some(YinResult {
            freq,
            conf: 1.0 - cmnd[tau_est],
        })
    })
}

/// 自相关兜底检测的单帧结果。
pub struct AcResult {
    /// 中选周期对应的频率。
    pub freq: f32,
    /// 0..1 的周期性分数（峰值自相关与 2×/3× 处自相关的均值各占一半）。
    pub score: f32,
}

/// 自相关兜底检测的分数下限。
///
/// 实测（真素材 41 个 + 合成对照）：白噪声与「脉冲串 + 强噪声」的分数只有
/// 0.030~0.062，而 YIN 漏检的那批真素材最低也有 0.142 —— 0.10 两边都留了余量。
const AC_MIN_SCORE: f32 = 0.10;

/// 中选 lag 处 YIN CMND 的上限。
///
/// 这条才是真正把「无音高」挡在外面的闸门：合成的无音高信号 CMND 恒在
/// 0.875~0.941，而 YIN 漏检的真素材最高只到 0.821。
const AC_MAX_CMND: f32 = 0.85;

/// 自相关 + 谐波性的单帧周期估计 —— YIN 的兜底。
///
/// # 为什么需要它
///
/// 真素材里约三分之一是「短切片 / 带音效 / 噪声型」，逐帧 YIN 一帧都过不了
/// 0.12 的 CMND 阈值。实测 41 个真素材：YIN 严格阈值漏检 **14 个**，而
/// `hajimi_detect_pitch` 漏检会让自动修音**静默失效**（`detectedPitchHz` 为 null
/// → `sampleSemitonesAtPitch` 直接退回手动偏移 = 不变调）；PSOLA 取不到 mark
/// 也会**静默不变调**。两者是同一批素材。
///
/// # 为什么不是「放宽 YIN 阈值」
///
/// 把阈值放到 0.30 能救回 12/14，但会在别的素材上咬到二次谐波：
/// 实测「豆.mp3」从 360.6Hz 直接跳到 721.0Hz（正好 2 倍）。**八度错比不检出更糟** ——
/// 不检出只是不变调，八度错是整套颗粒几何都错。
///
/// 自相关 + 谐波性没这个毛病：它要求候选周期处自相关强，**且 2×/3× 该周期处也强**。
/// 二次谐波不满足后者（它的 2× 已经是基频的 4×，那里通常已经衰减）。
///
/// # 并列裁决
///
/// 自相关的经典失效是「基频 / 二次谐波 / 三次次谐波」几乎同高 —— 实测「豆.mp3」
/// 的峰值 lag 给出 120.6Hz（1/3 次谐波）。所以在「自相关达到峰值 90% 以上」的
/// 候选里，改由 YIN 的 CMND 选最小者：CMND 对这类倍频错位是敏感的。
/// 这一条把「豆.mp3」从 120.6Hz 裁决回 358.2Hz（YIN 的值是 360.9Hz）。
pub fn autocorr_frame(
    x: &[f32],
    offset: usize,
    win: usize,
    min_tau: usize,
    max_tau: usize,
    sample_rate: f32,
) -> Option<AcResult> {
    if win == 0 || max_tau <= min_tau || offset + win + max_tau > x.len() {
        return None;
    }
    let a = &x[offset..offset + win];
    let mut e0 = 0.0f32;
    for v in a {
        e0 += v * v;
    }
    if e0 <= 1e-12 {
        return None;
    }

        SCRATCH.with(|cell| {
        let mut scratch = cell.borrow_mut();
        let (diff, cmnd, ac) = &mut *scratch;
        // 三个缓冲必须**各自**判长度。曾经只判 `diff`：`yin_frame` 从不增长 `ac`，
        // 于是 `yin_frame` 之后紧接 `autocorr_frame` 会拿到空切片直接 panic
        // （`hajimi_detect_pitch` 正是这个调用顺序）。测试 `ac_buffer_is_shared_safely` 盯这个。
        if diff.len() < max_tau + 1 {
            diff.resize(max_tau + 1, 0.0);
        }
        if cmnd.len() < max_tau + 1 {
            cmnd.resize(max_tau + 1, 0.0);
        }
        if ac.len() < max_tau + 1 {
            ac.resize(max_tau + 1, 0.0);
        }
        let diff = &mut diff[..=max_tau];
        let cmnd = &mut cmnd[..=max_tau];
        let ac = &mut ac[..=max_tau];

        // 一次遍历同时得到差分函数与自相关。CMND 必须从 tau=1 起累加，
        // 这样它才和 `yin_frame` 里的是同一个量，才能拿来当并列裁决的裁判。
        for tau in 1..=max_tau {
            let b = &x[offset + tau..offset + tau + win];
            let mut d = 0.0f32;
            let mut s = 0.0f32;
            for (p, q) in a.iter().zip(b.iter()) {
                let delta = p - q;
                d += delta * delta;
                s += p * q;
            }
            diff[tau] = d;
            ac[tau] = s / e0;
        }
        cmnd[0] = 1.0;
        let mut running = 0.0f32;
        for tau in 1..=max_tau {
            running += diff[tau];
            cmnd[tau] = if running == 0.0 {
                1.0
            } else {
                (diff[tau] * tau as f32) / running
            };
        }

        // 自相关峰值
        let mut peak_tau = min_tau;
        let mut peak = f32::NEG_INFINITY;
        for tau in min_tau..=max_tau {
            if ac[tau] > peak {
                peak = ac[tau];
                peak_tau = tau;
            }
        }
        if !(peak > 0.0) {
            return None;
        }

        // 谐波性：2× / 3× 候选周期处也应强
        let mut harm = 0.0f32;
        let mut cnt = 0u32;
        for k in 2..=3usize {
            let t = peak_tau * k;
            if t <= max_tau {
                harm += ac[t];
                cnt += 1;
            }
        }
        let harm_avg = if cnt > 0 { harm / cnt as f32 } else { 0.0 };
        let score = 0.5 * peak + 0.5 * harm_avg;

        // 并列裁决：ac 达峰值 90% 以上的候选里，取 CMND 最小者
        let mut pick = peak_tau;
        let mut best_cmnd = cmnd[peak_tau];
        for tau in min_tau..=max_tau {
            if ac[tau] >= peak * 0.9 && cmnd[tau] < best_cmnd {
                best_cmnd = cmnd[tau];
                pick = tau;
            }
        }

        if score < AC_MIN_SCORE || best_cmnd > AC_MAX_CMND {
            return None;
        }

        // 抛物线插值（自相关的峰是极大值，与 CMND 的极小值符号相反）
        let mut tau_f = pick as f32;
        if pick > min_tau && pick < max_tau {
            let (p, q, r) = (ac[pick - 1], ac[pick], ac[pick + 1]);
            let den = 2.0 * (p - 2.0 * q + r);
            if den != 0.0 {
                tau_f = pick as f32 + (p - r) / den;
            }
        }
        let freq = sample_rate / tau_f;
        if !freq.is_finite() || freq <= 0.0 {
            return None;
        }
        Some(AcResult { freq, score })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f32, sr: f32, n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| (2.0 * std::f32::consts::PI * freq * i as f32 / sr).sin())
            .collect()
    }
    #[test]
    fn detects_sine() {
        let sr = 48000.0;
        for freq in [80.0f32, 200.0, 440.0, 880.0] {
            let x = sine(freq, sr, 8192);
            let max_tau = (sr / 50.0) as usize;
            let r = yin_frame(&x, 0, 4096, 48, max_tau.min(2000), 0.15, sr)
                .unwrap_or_else(|| panic!("{}Hz 未检出", freq));
            let err = 1200.0 * (r.freq / freq).log2().abs();
            assert!(err < 5.0, "{}Hz 测得 {:.1}Hz（{:.1} 音分）", freq, r.freq, err);
        }
    }

    /// 复用缓冲必须不残留上一帧的数据：先测高音再测低音，结果都要对。
    /// 若 SCRATCH 只 grow 不清零，短 max_tau 后的长 max_tau 会读到脏值。
    #[test]
    fn scratch_reuse_across_frames_is_clean() {
        let sr = 48000.0;
        let a = sine(800.0, sr, 8192);
        let b = sine(90.0, sr, 16384);
        for _ in 0..3 {
            let ra = yin_frame(&a, 0, 4096, 48, 960, 0.15, sr).expect("高音");
            assert!((ra.freq - 800.0).abs() < 10.0, "got {}", ra.freq);
            let rb = yin_frame(&b, 0, 8192, 48, 1900, 0.15, sr).expect("低音");
            assert!((rb.freq - 90.0).abs() < 3.0, "got {}", rb.freq);
        }
    }

    #[test]
    fn out_of_bounds_is_rejected() {
        let sr = 48000.0;
        let x = sine(200.0, sr, 4096);
        assert!(yin_frame(&x, 0, 4096, 48, 960, 0.15, sr).is_none());
        assert!(yin_frame(&x, 0, 0, 48, 960, 0.15, sr).is_none());
    }

    /// 自相关兜底必须和 YIN 共用 SCRATCH 而不炸、不串味。
    ///
    /// 这条盯的是一个真实踩过的 panic：SCRATCH 是三元组，早期只在 `diff` 太短时
    /// 一起 resize 三个缓冲，而 `yin_frame` 从不增长 `ac` —— 于是
    /// 「先 `yin_frame` 再 `autocorr_frame`」会拿到空切片直接越界 panic。
    /// `hajimi_detect_pitch` 走的正是这个调用顺序，一调就崩。
    #[test]
    fn ac_buffer_is_shared_safely() {
        let sr = 48000.0;
        let x = sine(300.0, sr, 16384);
        for _ in 0..3 {
            // 交替顺序，确保两个方向都不会读到脏缓冲
            let y = yin_frame(&x, 0, 4096, 48, 900, 0.15, sr).expect("YIN");
            assert!((y.freq - 300.0).abs() < 5.0, "YIN got {}", y.freq);
            let a = autocorr_frame(&x, 0, 4096, 48, 900, sr).expect("自相关");
            assert!((a.freq - 300.0).abs() < 5.0, "自相关 got {}", a.freq);
        }
    }

    /// 短缓冲 + 长 max_tau：`ac` 从未被增长过，第一次调用就要能正确判定越界。
    #[test]
    fn ac_out_of_bounds_is_rejected() {
        let sr = 48000.0;
        let x = sine(200.0, sr, 4096);
        assert!(autocorr_frame(&x, 0, 4096, 48, 960, sr).is_none());
        assert!(autocorr_frame(&x, 0, 0, 48, 960, sr).is_none());
    }

    /// 白噪声必须被闸门挡在外面 —— 这是「没音高就别硬报一个」的底线。
    /// 实测合成噪声的分数只有 0.030~0.062、中选 lag 的 CMND 恒在 0.87 以上，
    /// 两条闸门（score ≥ 0.10、CMND ≤ 0.85）都碰不到。
    #[test]
    fn noise_is_rejected_by_the_gate() {
        let sr = 48000.0;
        // 确定性伪随机，避免测试随机翻绿
        let mut seed = 0x1234_5678u32;
        let x: Vec<f32> = (0..48000)
            .map(|_| {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                ((seed >> 8) as f32 / (1 << 24) as f32 - 0.5) * 0.6
            })
            .collect();
        assert!(
            autocorr_frame(&x, 0, 4096, 48, 900, sr).is_none(),
            "白噪声被判成了有音高"
        );
    }
}
