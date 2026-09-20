//! autotune —— 离线「整曲预渲染」自动修音（移植 QPitch 控制环）。
//!
//! 为什么是离线而不是实时 Worklet：本项目播放架构定稿为「静态参数 + 离线预渲染」
//! （见 stretch.rs 头注释）——主线程整段渲染后以 rate=1 精确播放。离线可以先把
//! 全曲 F0 轨迹看一遍（psola::track_pitch 已做 5 帧中值 + 八度纠错 + 清音插值），
//! 再按帧跑控制环得到 ratio(t) 曲线，最后喂进变 ratio 的 PSOLA 合成。相比实时版
//! 逐块盲跑，天然不怕单帧抖动，修出来的音更稳、更「哈吉米」。
//!
//! 控制环逐行对照 原型/算法参考.html L865-1013（QPitchEngine.process），其中
//! 「一个块 n」= PSOLA 帧 hop = 480 样本（HOP），所有毫秒参数按 hop 与 sr 换算成帧。
//!
//! 合成端复用变调路径的同一颗粒编排内核（[`psola::synth_curve`]）：控制环只负责
//! 产出「逐帧该修多少」的 ratio 曲线，怎么把颗粒铺到输出时间轴上、怎么对齐
//! pitch mark、怎么归一，全部与 hajimi_tx_run mode=1 同一段代码。修音与变调的
//! 听感因此同源 —— 这是「接上新算法」的核心：本模块只管音乐决策，不碰 DSP 几何。
//!
//! 有意跳过的东西（离线整曲处理由更好的机制覆盖）：
//!  - PitchStabilizer（2s 滑动中值，L894-897）：track_pitch 的中值滤波 + 八度纠错
//!    + 插值已在源头抹平单帧毛刺，无需再套一层运行时稳定器；
//!  - snappiness / tPain（L904-906）：它们只是把 effSpeed/effTrans/滞回/防抖各系数
//!    往下缩的旁路乘子，离线版让用户直接给 retune_ms / transition_ms，这两维冗余；
//!    因此 robotic = retune≤5ms 或 trans≤12ms、hardSnap = retune≤10ms 的原样保留；
//!  - humanize 正弦抖动（L972-976）、airMix 高频回填（L1022-1034）、formant 补偿
//!    （L1035-1038）：鬼畜要的就是机械感修音，这些修饰全部跳过，hOff≡0；
//!  - toleranceTime 旋钮（L939-940）：hajimi_at_run 的 ABI 没有这个字段，防抖窗取
//!    内部常量 PENDING_DEBOUNCE_MS；snap/tPain≡0 后代入 effTolT=tolT 本身。

use std::cell::RefCell;

use crate::psola;
use crate::psola::PitchFrame;

/// 帧置信度高于此才算「有效帧」（HTML L892：conf > 0.62）。
const CONF_VALID: f32 = 0.62;
/// 输入 midi 平滑时间常数（HTML L918，45ms）。
const INPUT_SMOOTH_SEC: f32 = 0.045;
/// hold 期满后的修正淡出指数常数（HTML L1009，30ms τ）。
const FADE_SEC: f32 = 0.030;
/// 失去有效帧后保持上一个 ratio 的时长（HTML L907）：常规 180ms，机器人档 120ms。
const HOLD_NORMAL_SEC: f32 = 0.180;
const HOLD_ROBOTIC_SEC: f32 = 0.120;
/// SCALE 模式目标切换防抖（样本计）。HTML 的 toleranceTime 参数未进 ABI，离线定 150ms。
const PENDING_DEBOUNCE_MS: f32 = 150.0;
/// 修正量钳位 ±1200 音分（HTML L984）→ ratio 钳位 0.5..2.0（L996）。
const MAX_CENTS: f32 = 1200.0;

/// hajimi_at_run 的参数包（与 extern "C" 形参一一对应）。
#[derive(Clone, Copy)]
pub struct AtParams {
    /// >0：ABSOLUTE 模式，全曲锁到该 MIDI 音（哈吉米用法）；<=0：SCALE 模式。
    pub target_midi: f32,
    /// 12-bit 音级掩码（bit0=C … bit11=B），SCALE 模式选「最近音阶音」用。
    pub scale_mask: u32,
    /// retune speed（ms）：修正量指数平滑，≤10ms 瞬切（hardSnap）、≤5ms 机器人。
    pub retune_ms: f32,
    /// 目标音符过渡平滑（ms）：锁定目标 → 平滑目标的指数系数，≤20ms 硬切。
    pub transition_ms: f32,
    /// 容差死区（音分）：|偏差|≤它不修，超出部分扣除死区后再修。
    pub tolerance_cents: f32,
    /// 修音强度 0..1（HTML correctionAmount/100）。<=0 由外层直通，不进控制环。
    pub amount: f32,
    /// A4 参考频率（Hz），钳位 400..480 同 HTML L741；<=0 → 440。
    pub ref_hz: f32,
}

#[allow(dead_code)] // 非 wasm 侧（测试/后续 worker 接线）构造默认参数用
impl Default for AtParams {
    fn default() -> Self {
        // 与 HTML QPitchEngine 构造默认一致（correctionAmount=100、absolute 关闭、
        // 全音阶掩码），retune=15ms / transition=120ms / tol=0。
        AtParams {
            target_midi: -1.0,
            scale_mask: 0x0FFF,
            retune_ms: 15.0,
            transition_ms: 120.0,
            tolerance_cents: 0.0,
            amount: 1.0,
            ref_hz: 440.0,
        }
    }
}

fn hz_to_midi(hz: f32, ref_hz: f32) -> f32 {
    69.0 + 12.0 * (hz / ref_hz).log2()
}

/// 音级使能判断（HTML L849-852）。
fn note_enabled(mask: u32, note_class: i32) -> bool {
    let nc = ((note_class % 12) + 12) % 12;
    (mask & (1u32 << nc)) != 0
}

/// 最近的音阶内 MIDI（HTML L853-863）：在 ±12 半音里找掩码允许且距离最近者；
/// 掩码为空时退化为 round(midi)（同 HTML best 初值）。
fn find_nearest_scale_midi(midi: f32, mask: u32) -> i32 {
    let center = midi.round() as i32;
    let mut best = center;
    let mut bd = f32::INFINITY;
    for cand in (center - 12)..=(center + 12) {
        if note_enabled(mask, cand) {
            let d = (cand as f32 - midi).abs();
            if d < bd {
                bd = d;
                best = cand;
            }
        }
    }
    best
}

/// 控制环主体：逐帧 F0 → 逐帧修音 ratio 曲线（每帧一个 ratio，长度 = frames.len()）。
///
/// 帧号 i 对应样本位置 `psola::frame_centre(i)` = WIN/2 + i*HOP（帧栅格约定的唯一
/// 入口，见 psola 模块头）。合成端按同一映射取 ratio，保证「施加在某 mark 上的修正」
/// 正是「该位置测得 f0 时算出的修正」。
/// 三个分支严格对应 HTML L909-1013：有效帧 / hold 期内 / hold 期满淡出。
pub fn control_loop(frames: &[PitchFrame], sr: f32, p: &AtParams) -> Vec<f32> {
    let sr = if sr > 0.0 { sr } else { 48000.0 };
    let hop = psola::HOP as f32; // 控制环的「块长 n」

    let ref_hz = if p.ref_hz > 0.0 {
        p.ref_hz.clamp(400.0, 480.0)
    } else {
        440.0
    };
    let amount = p.amount.clamp(0.0, 1.0);
    let tol_c = p.tolerance_cents.max(0.0);
    // snap/tPain≡0 代入 HTML L904-905：effSpeed=retune、effTrans=transition。
    let retune = p.retune_ms.max(0.0);
    let trans = p.transition_ms.max(0.0);
    let hard_snap = retune <= 10.0; // HTML L921
    let robotic = retune <= 5.0 || trans <= 12.0; // HTML L906（tPain 项去掉）
    let max_hold = ((if robotic { HOLD_ROBOTIC_SEC } else { HOLD_NORMAL_SEC }) * sr / hop) as usize;
    let tol_samples = (PENDING_DEBOUNCE_MS * 0.001 * sr) as usize; // HTML L940（snap/tPain≡0）

    // 指数平滑系数：HTML 里 f = exp(-n / max(1, τ秒*sr))，n=hop。
    let f_in = (-(hop / (INPUT_SMOOTH_SEC * sr).max(1.0))).exp();
    let f_fade = (-(hop / (FADE_SEC * sr).max(1.0))).exp();
    let tc_trans = (-(hop / (trans * 0.001 * sr).max(1.0))).exp(); // HTML L968
    // retune 平滑：HTML L989-990 先算每样本系数 local=exp(-1/(ms*sr/1000))，再 bc=local^n。
    let bc_retune = if retune > 0.0 {
        (-(hop / (retune * 0.001 * sr).max(1.0))).exp()
    } else {
        0.0
    };
    let absolute = p.target_midi > 0.0;

    // —— 状态变量（HTML 构造器 L798-807 的字段一一对应）——
    let mut smoothed_input = -1.0f32;
    let mut locked_target = -1.0f32;
    let mut smoothed_target = -1.0f32;
    let mut pending_target = -1.0f32;
    let mut pending_samples = 0.0f32;
    let mut hold = 0usize;
    let mut corr = 0.0f32; // smoothedCorrectionCents，初值 0

    let mut curve = Vec::with_capacity(frames.len());

    for f in frames {
        let valid = f.voiced && f.f0 > 0.0 && f.f0.is_finite() && f.conf > CONF_VALID;

        if valid {
            // track_pitch 的 f0 即 HTML 里 stabilizer 的「稳定 midi」，直接作为输入。
            let mut in_midi = hz_to_midi(f.f0, ref_hz);

            // 八度折叠：向平滑锚 ±6 半音绕（HTML L913-915），再 45ms 平滑（L918-919）。
            if smoothed_input >= 0.0 {
                while in_midi - smoothed_input > 6.0 {
                    in_midi -= 12.0;
                }
                while smoothed_input - in_midi > 6.0 {
                    in_midi += 12.0;
                }
            } else {
                smoothed_input = in_midi;
            }
            smoothed_input = smoothed_input * f_in + in_midi * (1.0 - f_in);

            if absolute {
                // ABSOLUTE：全曲锁到给定音（HTML L923-927）。
                locked_target = p.target_midi;
                if smoothed_target < 0.0 {
                    smoothed_target = p.target_midi;
                }
                pending_target = -1.0;
                pending_samples = 0.0;
            } else {
                // SCALE：最近音阶音 + 滞回 + 样本防抖（HTML L928-961）。
                let nearest = find_nearest_scale_midi(in_midi, p.scale_mask) as f32;
                if locked_target < 0.0 {
                    locked_target = nearest;
                    smoothed_target = nearest;
                } else if (nearest - locked_target).abs() > f32::EPSILON {
                    let cur_d = (in_midi - locked_target).abs();
                    let new_d = (in_midi - nearest).abs();
                    let hyst = if robotic {
                        0.14
                    } else if hard_snap {
                        0.32
                    } else {
                        0.35 + tol_c * 0.004
                    };
                    let forced = if robotic {
                        0.58
                    } else if hard_snap {
                        1.00
                    } else {
                        1.20
                    };
                    if new_d + hyst < cur_d || cur_d > forced {
                        if tol_samples == 0 || robotic || cur_d > forced {
                            locked_target = nearest;
                            pending_target = -1.0;
                            pending_samples = 0.0;
                        } else {
                            if (pending_target - nearest).abs() > f32::EPSILON {
                                pending_target = nearest;
                                pending_samples = 0.0;
                            }
                            pending_samples += hop;
                            if pending_samples >= tol_samples as f32 {
                                locked_target = pending_target;
                                pending_target = -1.0;
                                pending_samples = 0.0;
                            }
                        }
                    }
                } else {
                    pending_target = -1.0;
                    pending_samples = 0.0;
                }
            }

            if smoothed_target < 0.0 {
                smoothed_target = locked_target;
            }
            // 目标过渡平滑（HTML L965-970）：≤20ms 视为硬切。
            smoothed_target = if trans <= 20.0 {
                locked_target
            } else {
                smoothed_target * tc_trans + locked_target * (1.0 - tc_trans)
            };

            // 修正量：音分 = (目标 - 输入)×100，死区扣除后 ×amount，钳 ±1200
            // （HTML L978-984；humanize hOff 跳过）。
            let mut raw_cents = (smoothed_target - in_midi) * 100.0;
            if tol_c > 0.0 {
                if raw_cents.abs() <= tol_c {
                    raw_cents = 0.0;
                } else {
                    raw_cents -= raw_cents.signum() * tol_c;
                }
            }
            let target = (raw_cents * amount).clamp(-MAX_CENTS, MAX_CENTS);

            // retune 指数平滑（HTML L986-994）：瞬切档直接到位。
            corr = if hard_snap || robotic || !(bc_retune > 0.0 && bc_retune < 1.0) {
                target
            } else {
                corr * bc_retune + target * (1.0 - bc_retune)
            };

            hold = max_hold;
        } else if hold > 0 {
            // hold 期：保持上一个 ratio（corr 不动，HTML L1002-1004）。
            hold -= 1;
        } else {
            // hold 期满：清锁存状态、修正指数淡出回 0（HTML L1005-1012）。
            locked_target = -1.0;
            smoothed_target = -1.0;
            smoothed_input = -1.0;
            corr *= f_fade;
        }

        let ratio = 2f32.powf(corr / 1200.0);
        curve.push(if ratio.is_finite() {
            ratio.clamp(0.5, 2.0)
        } else {
            1.0
        });
    }

    curve
}

/// 按 `psola::f0_at` 同一约定取帧曲线的值。
///
/// 帧号映射必须走 [`psola::frame_index`]（帧 i 的中心 = WIN/2 + i*HOP），
/// **不要**写 `pos / HOP`。曾经这里各写各的，导致控制环算出的「该修多少」与
/// 合成端施加的位置相差 WIN/2 ≈ 21ms，短促素材上等于每个音头都修错地方。
/// 空曲线一律 1.0（不修）。
fn ratio_at(curve: &[f32], pos: f32) -> f32 {
    if curve.is_empty() {
        return 1.0;
    }
    let fi = psola::frame_index(pos);
    if !fi.is_finite() || fi <= 0.0 {
        return curve[0];
    }
    let idx = fi.floor() as usize;
    if idx >= curve.len() {
        return *curve.last().unwrap();
    }
    if idx + 1 >= curve.len() {
        return curve[idx];
    }
    let frac = fi - idx as f32;
    curve[idx] * (1.0 - frac) + curve[idx + 1] * frac
}

/// Planar 多通道离线自动修音：通道 0 检测 F0 并驱动控制环，所有通道共享同一套
/// marks / ratio 曲线 / blend mask（立体声声像保持），时长 1:1。
///
/// 合成走 [`psola::synth_curve`] —— 与变调路径 `psola::apply_planar` 是**同一个**
/// 颗粒编排内核：输出时间轴铺颗粒 + nearest-mark 吸附 + onset anchor + Σw 归一
/// + 局部增益匹配。两条路径只差「ratio 是常量还是逐帧曲线」。
///
/// 这里曾经另有一条自动修音专用合成路径（psola 里那个旧的 `synth_curve`）：
/// 逐 mark 手动铺点、`lerp` 线性插值采样、不做吸附/锚定/增益匹配。后果是修音的
/// 音质比变调差一档 —— 颗粒与源的合成相位任意错开，于是每个 voiced run 起点都
/// 和原声不对齐，且没有局部增益匹配去补升调丢失的 3dB。现在两条路共用内核。
///
/// mask 语义与变调路径同一规则：只有**长**清音段（≥24 帧 ≈ 240ms 的完整呼吸或
/// 静音）放行原声，短清音缺口继续合成（避免每个音符缝上切一刀）。
/// 修音不改时长（time≡1），mask 的「输出帧中心 → 源帧」回查退化为恒等映射，
/// 放行原声也只是逐样本取回。
///
/// # 已知极限（与 hajimi_tx_run mode=1 同源，非本模块引入）
///
/// 修正比钳死在 2.0 附近并持续不变时，重叠颗粒可能互相抵消、输出电平塌陷：
/// 严格周期的合成信号实测 ratio 1.682 → 1.00、1.888 → 0.22、2.000 → 0.00。
/// **但损失量对信号的严格周期性极其敏感**（同一内核换成 f32 相位的合成元音
/// 就是 1.0001），真实素材必须实测。详见 psola 模块头的「已知极限」一节。
///
/// 可操作的结论：把低音素材整段锁到高八度是需要单独验证的用法；锁定目标与
/// 素材原音的距离控制在 ±9 半音内是安全的。
pub fn apply_planar(planar: &[&[f32]], sr: f32, p: &AtParams) -> Vec<Vec<f32>> {
    if planar.is_empty() {
        return Vec::new();
    }
    let sr = if sr > 0.0 { sr } else { 48000.0 };
    let total = planar[0].len();
    if total == 0 {
        return planar.iter().map(|s| s.to_vec()).collect();
    }

    let frames_t = psola::track_pitch(planar[0], sr);
    let curve = control_loop(&frames_t, sr, p);
    let marks = psola::detect_marks(planar[0], &frames_t, sr);
    let mask = psola::build_blend_mask(&frames_t, 1.0, total);

    planar
        .iter()
        .map(|src| {
            // 控制环曲线按源帧索引（见 control_loop / ratio_at 的帧栅格约定），
            // 而内核回传的正是颗粒读源的位置 —— 直接查表，无需再折算。
            let ratio_fn = |pos: f64| ratio_at(&curve, pos as f32) as f64;
            let (synth, _env) =
                psola::synth_curve(src, &marks, &frames_t, sr, &ratio_fn, total);
            (0..total)
                .map(|i| {
                    let m = mask.get(i).copied().unwrap_or(1.0);
                    if m >= 1.0 - 1e-6 {
                        synth[i]
                    } else if m <= 1e-6 {
                        src[i]
                    } else {
                        synth[i] * m + src[i] * (1.0 - m)
                    }
                })
                .collect()
        })
        .collect()
}

// ---------------------------------------------------------------------------
// extern "C" 导出（结果暂存，JS 按指针读回 —— 与 hajimi_tx_* 同一 ABI 风格）
// ---------------------------------------------------------------------------

struct AtOut {
    channels: Vec<Vec<f32>>,
    frames: usize,
}

thread_local! {
    static AT: RefCell<Option<AtOut>> = const { RefCell::new(None) };
}

/// 离线自动修音。in_ptr 处 ch 段 × frames 连续（planar f32）。返回输出帧数（<=0 失败）。
///
/// target_midi > 0 → ABSOLUTE 模式（全曲锁到该 MIDI，哈吉米场景）；
/// target_midi <= 0 → SCALE 模式（逐帧吸附 scale_mask 内最近音）。
/// amount <= 0 → 原样拷贝（与 JS 包装层直通语义互为保险）。
#[no_mangle]
pub extern "C" fn hajimi_at_run(
    in_ptr: *const f32,
    frames: u32,
    ch: u32,
    sr: f32,
    target_midi: f32,
    scale_mask: u32,
    retune_ms: f32,
    transition_ms: f32,
    tolerance_cents: f32,
    amount: f32,
    ref_hz: f32,
) -> i32 {
    if in_ptr.is_null() || frames == 0 || ch == 0 {
        return -1;
    }
    let total = frames as usize * ch as usize;
    let flat = unsafe { std::slice::from_raw_parts(in_ptr, total) };
    let nch = ch as usize;
    let mut planar: Vec<&[f32]> = Vec::with_capacity(nch);
    for c in 0..nch {
        let begin = c * frames as usize;
        planar.push(&flat[begin..begin + frames as usize]);
    }
    let p = AtParams {
        target_midi,
        scale_mask,
        retune_ms,
        transition_ms,
        tolerance_cents,
        amount,
        ref_hz,
    };
    let sr_eff = if sr > 0.0 { sr } else { 48000.0 };
    let outs: Vec<Vec<f32>> = if !(p.amount > 0.0) {
        planar.iter().map(|v| v.to_vec()).collect()
    } else {
        apply_planar(&planar, sr_eff, &p)
    };

    let min_len = outs.iter().map(|v| v.len()).min().unwrap_or(0);
    if min_len == 0 {
        return -2;
    }
    let channels: Vec<Vec<f32>> = outs
        .into_iter()
        .map(|mut v| {
            v.truncate(min_len);
            v
        })
        .collect();
    AT.with(|t| *t.borrow_mut() = Some(AtOut { channels, frames: min_len }));
    min_len as i32
}

#[no_mangle]
pub extern "C" fn hajimi_at_channels() -> i32 {
    AT.with(|t| t.borrow().as_ref().map(|o| o.channels.len() as i32).unwrap_or(0))
}

#[no_mangle]
pub extern "C" fn hajimi_at_frames() -> i32 {
    AT.with(|t| t.borrow().as_ref().map(|o| o.frames as i32).unwrap_or(0))
}

#[no_mangle]
pub extern "C" fn hajimi_at_channel_ptr(c: usize) -> *const f32 {
    AT.with(|t| match t.borrow().as_ref() {
        Some(o) => o.channels.get(c).map(|v| v.as_ptr()).unwrap_or(std::ptr::null()),
        None => std::ptr::null(),
    })
}

#[no_mangle]
pub extern "C" fn hajimi_at_free() {
    AT.with(|t| *t.borrow_mut() = None);
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::yin;
    use std::f32::consts::PI;

    const TWO_PI: f32 = 2.0 * PI;

    /// 相位积分合成器：freq(i) 给出每样本瞬时频率，扫频/定频通用且无相位跳变。
    fn oscillator(n: usize, sr: f32, freq: impl Fn(usize) -> f32) -> Vec<f32> {
        let mut x = Vec::with_capacity(n);
        let mut phase = 0.0f32;
        for i in 0..n {
            x.push((TWO_PI * phase).sin());
            phase += freq(i) / sr;
        }
        x
    }

    /// 区间中点频率下的检测音分误差（对 YIN 取中段，避开头尾淡出/收敛区）。
    fn cents_error(slice: &[f32], sr: f32, want_hz: f32) -> f32 {
        let hz = yin::detect_pitch(slice, sr as u32);
        assert!(hz > 0.0, "YIN detected nothing");
        1200.0 * (hz / want_hz).log2()
    }

    fn rms(x: &[f32]) -> f32 {
        (x.iter().map(|s| s * s).sum::<f32>() / x.len() as f32).sqrt()
    }

    fn params_abs(target: f32) -> AtParams {
        AtParams { target_midi: target, ..Default::default() }
    }

    // ---- (a) 扫频 + ABSOLUTE 锁定：两端都必须被拉到 440Hz（±40 音分内）。
    //
    // 注：任务描述给的 300→200Hz 端点与规格第 5 条「修正钳位 ±1200 音分」冲突
    // （200→440 需 +1394 音分，钳位后只能到 400Hz），故主测试改用全程修正量
    // 均在 ±1200 内的 320→230Hz 扫频；300→200 另立钳位行为测试（见下）。
    #[test]
    fn absolute_lock_pulls_glissando_to_target() {
        let sr = 48000.0f32;
        let n = (2.0 * sr) as usize;
        // 320Hz → 230Hz 线性扫频（对应修正量 +568c → +1124c，均 <1200c）
        let x = oscillator(n, sr, |i| 320.0 + (230.0 - 320.0) * i as f32 / n as f32);
        let out = apply_planar(&[&x], sr, &params_abs(69.0));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].len(), n, "修音不变时长");
        assert!(out[0].iter().all(|s| s.is_finite()));

        let a = (0.5 * sr) as usize;
        let b = (0.75 * sr) as usize;
        let c0 = cents_error(&out[0][a..b], sr, 440.0);
        let c1 = cents_error(&out[0][n - (b - a)..n], sr, 440.0);
        assert!(c0.abs() < 40.0, "head f0 cents err {} (want 440Hz)", c0);
        assert!(c1.abs() < 40.0, "tail f0 cents err {} (want 440Hz)", c1);
    }

    /// 超出 ±1200 音分修正能力时控制环按钳位处理（ratio 钉死 ≤2.0）；
    /// 钳位边缘（恰 ×2 且恒定不变）的合成质量是 PSOLA 引擎固有极限——常量
    /// 路径 pitch=2 同样退化（实测近静音），非本模块引入。故只断言安全属性
    /// （不越界、不 NaN、时长保持）与钳位内区段（300→440 = +1006c）修准。
    #[test]
    fn absolute_lock_clamps_beyond_octave() {
        let sr = 48000.0f32;
        let n = (2.0 * sr) as usize;
        let x = oscillator(n, sr, |i| 300.0 + (200.0 - 300.0) * i as f32 / n as f32);
        let p = params_abs(69.0);
        // 控制环层面：200Hz 端需要 +1394 音分，曲线必须钳在 ratio=2.0、绝不越界。
        let curve = control_loop(&psola::track_pitch(&x, sr), sr, &p);
        assert!(curve.iter().all(|r| (0.5..=2.0).contains(r)));
        assert!(
            (*curve.last().unwrap() - 2.0).abs() < 0.02,
            "tail ratio should clamp at 2.0, got {}",
            curve.last().unwrap()
        );
        // 合成层面：安全属性 + 钳位内区段修准（×2 钉死区不断言，见函数注释）。
        let out = apply_planar(&[&x], sr, &p);
        assert_eq!(out[0].len(), n);
        assert!(out[0].iter().all(|s| s.is_finite()));
        assert!(rms(&out[0][n / 2..n / 2 + 24000]).is_normal(), "输出必须有正常能量");
        let head = cents_error(
            &out[0][(0.5 * sr) as usize..(0.75 * sr) as usize],
            sr,
            440.0,
        );
        assert!(head.abs() < 40.0, "300Hz 端可修到 440，err {}", head);
    }

    // ---- (b) 已在目标音上：ratio≈1，输出≈「PSOLA pitch=1 直通」的重建（无额外
    // 痕迹），时长不变、音高不漂、全有限。注意 PSOLA 重合成本身有固定的窗归一
    // 化增益（纯音约 ×1.33），所以对照基准取同引擎直通输出，而不是原始输入。
    #[test]
    fn already_on_target_is_noop() {
        let sr = 48000.0f32;
        let n = (2.0 * sr) as usize;
        let x = oscillator(n, sr, |_| 440.0);
        let out = apply_planar(&[&x], sr, &params_abs(69.0));
        assert!(out[0].iter().all(|s| s.is_finite()));
        assert_eq!(out[0].len(), n);

        let curve = control_loop(&psola::track_pitch(&x, sr), sr, &params_abs(69.0));
        for (i, r) in curve.iter().enumerate() {
            assert!((r - 1.0).abs() < 0.02, "frame {} ratio {} should be ≈1", i, r);
        }

        let mid = (0.5 * sr) as usize..(1.5 * sr) as usize;
        // 基准：原始信号。x 本身是 440Hz，修音到 A4 时应是"轻加工"。
        // PSOLA 窗归一化有固定增益（约 1.33×），阈值覆盖它但不允许明显偏差。
        // 0.7 下限能检测"几乎无声"，1.6 上限能检测"爆炸/DC 偏置"。
        let r_x = rms(&x[mid.clone()]);
        let rout = rms(&out[0][mid]);
        let gain = rout / r_x;
        assert!(
            (0.7..1.6).contains(&gain),
            "gain {:.3} out of expected range (r_x={:.3}, rout={:.3})",
            gain, r_x, rout
        );
        let err = cents_error(&out[0][(0.6 * sr) as usize..(0.9 * sr) as usize], sr, 440.0);
        assert!(err.abs() < 40.0, "output drift {} cents", err);
    }

    // ---- (c) 白噪声：不崩、全有限、时长保持。
    #[test]
    fn white_noise_is_safe() {
        let sr = 48000.0f32;
        let n = (1.5 * sr) as usize;
        // 确定性 LCG 白噪声（免引入 rand 依赖）
        let mut st = 0x1234_5678u32;
        let x: Vec<f32> = (0..n)
            .map(|_| {
                st = st.wrapping_mul(1664525).wrapping_add(1013904223);
                (st as f32 / u32::MAX as f32) * 2.0 - 1.0
            })
            .collect();
        let out = apply_planar(&[&x, &x], sr, &params_abs(60.0));
        assert_eq!(out.len(), 2);
        for ch in &out {
            assert_eq!(ch.len(), n);
            assert!(ch.iter().all(|s| s.is_finite()));
        }
    }

    // ---- (d) SCALE 模式：midi 62.5（D 与 D# 之间偏 D）+ C 大调掩码 → 吸附 62。
    #[test]
    fn scale_mode_snaps_to_nearest_note() {
        assert_eq!(find_nearest_scale_midi(62.5, 0xAD5), 62); // D(62) 距离 0.5 < E(64)
        assert_eq!(find_nearest_scale_midi(63.9, 0xAD5), 64); // 过半吸到 E
        assert_eq!(find_nearest_scale_midi(56.6, 0xAD5), 57); // A(57) 最近
        assert_eq!(find_nearest_scale_midi(62.5, 0x000), 63); // 空掩码退化为 round

        let sr = 48000.0f32;
        let n = (2.0 * sr) as usize;
        let f_in = 440.0 * 2f32.powf((62.5 - 69.0) / 12.0); // ≈304.2Hz
        let x = oscillator(n, sr, move |_| f_in);
        let p = AtParams { target_midi: -1.0, scale_mask: 0xAD5, ..Default::default() };
        let out = apply_planar(&[&x], sr, &p);
        assert!(out[0].iter().all(|s| s.is_finite()));

        let want = 440.0 * 2f32.powf((62.0 - 69.0) / 12.0); // D4 ≈293.66
        let a = (0.6 * sr) as usize;
        let b = (0.9 * sr) as usize;
        let err = cents_error(&out[0][a..b], sr, want);
        assert!(err.abs() < 40.0, "scale mode: {} cents off D4", err);
    }

    // ---- 清音/静音段：hold+fade 语义——ratio 先保持后回落到 1。
    #[test]
    fn unvoiced_holds_then_fades() {
        let sr = 48000.0f32;
        let mut x = oscillator((1.0 * sr) as usize, sr, |_| 220.0);
        x.extend(std::iter::repeat(0.0f32).take((1.0 * sr) as usize)); // 后半静音
        let curve = control_loop(&psola::track_pitch(&x, sr), sr, &params_abs(69.0));
        // 220→440 需 +1200c → 稳态 ratio 钳在 2.0。静音后先 hold（保持峰值）再指数淡出。
        // >= 取「最后一个峰值帧」：即 hold 期末端（淡出起点附近）。
        let (idx_max, held) = curve
            .iter()
            .enumerate()
            .fold((0usize, 1.0f32), |acc, (i, &v)| if v >= acc.1 { (i, v) } else { acc });
        assert!(held > 1.9, "稳态/hold 期 ratio 应保持 ≈2.0，got {}", held);
        assert!(idx_max + 40 < curve.len(), "曲线长度应覆盖淡出区");
        assert!(
            curve[idx_max + 40] < held - 0.3,
            "hold 期满（≤18 帧）后 40 帧应已明显淡出"
        );
        let tail = *curve.last().unwrap();
        assert!((tail - 1.0).abs() < 0.05, "淡出末期 ratio 应回 1，got {}", tail);
    }

    // ---- 起音：接上新内核后不许再有咔哒 ----

    /// 自动修音与变调共用同一个颗粒编排内核，所以每段 voiced run 的第一颗颗粒
    /// 同样会吸附到它的 pitch mark 上（onset anchor），合成相位在音头与原声对齐。
    ///
    /// 这条曾经不成立：自动修音另有一条专用合成路径（逐 mark 手动铺点、无锚定、
    /// 也不做互相关精修），颗粒与源的相位任意错开 —— 每个音头都带咔哒。
    /// 现在两条路径只差「ratio 是常量还是逐帧曲线」。
    #[test]
    fn autotune_onsets_do_not_click() {
        let sr = 48000.0f32;
        let f0 = 220.0f32;
        let note_len = (sr * 0.2) as usize;
        let gap_len = (sr * 0.12) as usize;
        let notes = 12usize;
        let mut x = vec![0.0f32; notes * (note_len + gap_len)];
        for k in 0..notes {
            let off = k * (note_len + gap_len);
            let seg = oscillator(note_len, sr, |_| f0);
            for i in 0..note_len {
                let attack = (i as f32 / (sr * 0.004)).min(1.0);
                let release = ((note_len - i) as f32 / (sr * 0.01)).min(1.0);
                x[off + i] = seg[i] * attack * release;
            }
        }

        let jump = |y: &[f32]| -> f32 {
            let mut dmax = 0.0f32;
            let mut e = 0.0f64;
            for i in 1..y.len() {
                dmax = dmax.max((y[i] - y[i - 1]).abs());
                e += (y[i] as f64) * (y[i] as f64);
            }
            let rms = (e / y.len() as f64).sqrt() as f32;
            if rms > 1e-9 {
                dmax / rms
            } else {
                0.0
            }
        };

        let src_jump = jump(&x);
        // A3（220Hz = midi 57）锁到 D4（62）= +5 半音，在 ±1200 音分钳位内。
        let out = apply_planar(&[&x], sr, &params_abs(62.0));
        assert_eq!(out[0].len(), x.len());
        let j = jump(&out[0]);
        assert!(
            j < src_jump * 2.5,
            "起音跳变峰 {:.2} vs 源 {:.2} —— 自动修音在音头留了咔哒",
            j,
            src_jump
        );
    }

    /// glissando 的**全程**都必须落在新目标音上，而不是只有两端。
    /// 控制环曲线逐帧驱动颗粒几何，任何一段掉队都说明曲线没有真的接进内核。
    #[test]
    fn autotune_tracks_glissando_across_whole_sweep() {
        let sr = 48000.0f32;
        let n = (2.0 * sr) as usize;
        // 320→230Hz 线性扫频：全程修正量 +568c → +1124c，都在 ±1200 内。
        let x = oscillator(n, sr, |i| 320.0 + (230.0 - 320.0) * i as f32 / n as f32);
        let out = apply_planar(&[&x], sr, &params_abs(69.0));
        assert_eq!(out[0].len(), n);
        let q = n / 4;
        for k in 0..4 {
            let s = k * q + q / 4;
            let e = s + q / 2;
            let c = cents_error(&out[0][s..e], sr, 440.0);
            assert!(c.abs() < 40.0, "第 {} 段偏离 A4 {:.1} 音分", k + 1, c);
        }
    }

    /// ≥240ms 的长清音段整段放行原声（blend mask=0 的那一段逐样本取回源），
    /// 不做任何合成 —— 自动修音不该去动气口、呼吸与噪声。
    #[test]
    fn autotune_passes_long_unvoiced_through() {
        let sr = 48000.0f32;
        let tone_n = (sr * 0.4) as usize;
        let noise_n = (sr * 0.6) as usize;
        let mut x = oscillator(tone_n, sr, |_| 220.0);
        let mut st = 0x9E37_79B9u32;
        x.extend((0..noise_n).map(|_| {
            st = st.wrapping_mul(1664525).wrapping_add(1013904223);
            (st as f32 / u32::MAX as f32) * 0.5 - 0.25
        }));
        x.extend(oscillator(tone_n, sr, |_| 220.0));

        let out = apply_planar(&[&x], sr, &params_abs(62.0));
        assert_eq!(out[0].len(), x.len());

        // 两端各留 0.1s，避开 mask 在段边界处的 512 样本交叉淡化斜坡。
        let a = tone_n + (sr * 0.1) as usize;
        let b = tone_n + noise_n - (sr * 0.1) as usize;
        let mut maxd = 0.0f32;
        for i in a..b {
            maxd = maxd.max((out[0][i] - x[i]).abs());
        }
        assert_eq!(maxd, 0.0, "长清音段应逐样本放行原声，实测最大偏差 {}", maxd);
    }

    // ---- ABI 冒烟：hajimi_at_run 直通 + getters + free（amount=0 原样拷贝）。
    #[test]
    fn abi_passthrough_and_getters() {
        let sr = 48000.0f32;
        let n = 24000usize;
        let x = oscillator(n, sr, |_| 330.0);
        let rc = hajimi_at_run(x.as_ptr(), n as u32, 1, sr, 69.0, 0xFFF, 15.0, 120.0, 0.0, 0.0, 440.0);
        assert_eq!(rc, n as i32);
        assert_eq!(hajimi_at_channels(), 1);
        assert_eq!(hajimi_at_frames(), n as i32);
        let ptr = hajimi_at_channel_ptr(0);
        assert!(!ptr.is_null());
        let got = unsafe { std::slice::from_raw_parts(ptr, n) };
        assert_eq!(got, &x[..], "amount=0 必须逐字节直通");
        hajimi_at_free();
        assert_eq!(hajimi_at_frames(), 0);
        assert!(hajimi_at_channel_ptr(0).is_null());
    }
}
