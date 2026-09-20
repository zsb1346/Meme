//! PSOLA 人声变调/时长变换模块 —— 零 FFT，音高准确，无 phasiness。
//!
//! 合成内核逐行对照 PitchNet `Source/Audio/Synthesis/PsolaSynthesizer.cpp`
//! （AGPLv3 参考实现，Rust 重写）。
//!
//! # 全链路帧栅格约定（唯一，不许手写 pos/HOP）
//!
//! 第 i 帧的分析窗是 `[i*HOP, i*HOP + WIN)`，**帧中心 = WIN/2 + i*HOP**。
//! 任何「样本位置 ↔ 帧号」换算必须走 [`frame_index`] / [`frame_centre`]。
//!
//! 这条约定曾经是错的：`track_pitch` 从 `c = WIN/2` 起帧（中心 1024+480i），
//! 但下游的帧查找（`f0_at`、段边界、mark 判清浊）全部按 `pos/HOP` 反推，
//! 于是 pitch mark 用的是**未来 21ms** 的 F0、段边界落在**过去 21ms**——
//! 两个反向错误叠加，每个 voiced run 起点都取到辅音/静音。稳态长音上测不出来
//! （F0 本来就不变），一遇短促素材的起音就变成咔哒 + 音色突变。
//!
//! # 结构
//!
//! - 逐帧 YIN 音高检测 + 轨迹后处理（去异常 / 中值 / 平滑 / 八度纠错 / 清音插值）
//! - [`detect_marks`]：PitchNet `detectPitchMarks` —— voiced run 内取能量最强点做
//!   种子，然后逐周期预测 + 在 ±p/4 内做归一化互相关校正（比拾取峰值稳：
//!   某个谐波比基频更响时不会跳八度）
//! - [`render_track`]：PitchNet `render` —— **沿输出时间轴铺颗粒**，每颗颗粒独立
//!   问时间映射「读源哪里」，再吸附到最近的 pitch mark。于是「拉伸 = 重复颗粒、
//!   压缩 = 跳过颗粒」，音高与时长统一处理，不需要任何特例分支
//! - Σw 归一（floor 0.3）+ 局部增益匹配 + **输出时间轴** blend mask
//! - 两个入口共用上面这一整套内核，只差变调比从哪来：
//!   [`apply_planar`]（`hajimi_tx_run` mode=1）传常量，[`synth_curve`]
//!   （`hajimi_at_run` 离线自动修音）传控制环产出的逐帧曲线
//!
//! # 三个曾经的合成几何错误（都直接听成颤/噗噗/嗡嗡）
//!
//! ① 归一化除以 **Σw²** 而不是 PitchNet 的 **Σw**，且沿用同一个 floor 0.3。
//!    50% 重叠时 Σw≡1（Hann 的正交性和），而 Σw² = 0.5(1+cos²θ) 在 0.5~1 之间摆，
//!    于是输出被除以一个随相位摆动 2 倍的量 = **2×f0 速率的振幅调制**。
//!    重叠不是整数倍时更糟：r=0.5（降八度）恰好让颗粒首尾相贴、重叠为 0，
//!    Σw² 在接缝归零 → 输出被直接清零 + 局部增益匹配最多放大 4 倍去补残段。
//!
//! ② blend mask 建在**源时间轴**（`i*HOP`）却拿去索引**输出**样本。τ>1 时
//!    mask 只覆盖输出前半段，后半段恒 0 → 走原声直通分支，也就是把原音频
//!    线性插值慢放。结果前半段是 PSOLA、后半段是未变调的慢放，两头音高不同
//!    还硬切——这正是「拉伸像放屁」的直接机制（实测 1.5× 拉伸后半段音高垮 1902 音分）。
//!
//! ③ Σw 归一**把 floor 当成闸门**而不是除数下限：`if w > 0.3 { padded/w } else { 0 }`。
//!    这一行是从 PitchNet 逐字抄来的，但 PitchNet 自己的注释描述的是
//!    「用 floor 留下**平滑的幅度凹陷**」——它写下的行为却是满幅 ↔ 精确 0 的硬跳变。
//!    触发条件完全由几何决定：接缝处 Σw = 2·Hann(A/2)，voiced 路径 A/grain_half = 1/ratio，
//!    所以 ratio < 2/3（**-7.02 半音**）起每周期跳一次，-12 半音时约 23% 样点被置零。
//!    实测 41 真素材「每素材新增咔哒簇数」中位：-5 → +1、-7 → **+11**、-9 → **+30**、
//!    -12 → **+24**（单素材最大 +753），阶梯精确落在 -7，与推导一致。
//!    改为给除数下下限（`padded / max(w, floor)`）后：-7 → **0**、-9 → **4**、
//!    -12 → **6**（最大 753 → 138），精确 0 样点 23.06% → 1.51%（源基线 0.23%），
//!    而**全部升调档与 unity 逐样本不变**（ratio ≳ 0.67 时 Σw ≥ 0.3，`max` 不介入）。
//!    回归探针：`scripts/_probe-clickcount.mjs`（新增，逐素材数咔哒簇）。
//!
//! # 已知极限：变调比趋近 2.0 时可能出现的相干抵消（尚未解决）
//!
//! 颗粒按 `period/ratio` 的间距排放，内容取自 mark 上的 2 个分析周期。颗粒在
//! 输出时间轴上的相位随 ratio 变化，重叠部分可能互相抵消。**是否抵消、抵消多少，
//! 取决于颗粒叠加得有多相干**，而这对信号的严格周期性极其敏感。
//!
//! 实测（48000Hz，200Hz 源，`hajimi_tx_run` mode=1，中段 RMS 比）：
//!
//! | 输入信号 | ≤+9 半音 | +11 半音 | +12 半音 | +12.9 半音 |
//! |---|---|---|---|---|
//! | 逐样本相位积分的谐波堆（严格周期） | 0.997 | 0.221 | **0.000** | 0.096 |
//! | 单频正弦（`make_sine`） | — | — | **0.0001** | — |
//! | `make_vowel`（逐谐波 `sin(2π f i / sr + φ)`，高次谐波相位已越过 f32 精度） | — | — | **1.0001** |
//!
//! 最后两行是同一个内核、同一段名义内容差出来的四个数量级：所谓「抵消」不是
//! 某个固定比例的电平损失，而是一个**相干性**现象 —— 波形越严格周期、能量在
//! 周期内越分散，颗粒越容易整体反相；只要信号自身有些许非周期性（真实录音的
//! 抖动、噪声、声门脉冲的尖锐激励，甚至纯粹是数值量化），抵消就被削弱。
//!
//! 因此：**真实素材的损失介于这两个极端之间，必须实测，不能外推。**
//!
//! 这不是移植错误：PitchNet 的 `applyLocalGainMatch` 同样是 `clamp(0.25, 4.0)`
//! （最多补 12dB，补不回 20 倍的缺口），同样的输入在它那里也会掉。
//!
//! 所以**不要用纯正弦 / 合成元音验收 ±10 半音以上的电平** —— 那正好落在最坏
//! 的抵消区，量到的是合成信号的数值巧合，不是算法的实际表现。
//!
//! # 真素材实测（已做，结论与合成信号相反）
//!
//! `scripts/_probe-material-level.mjs`（41 个真素材，中段 RMS(输出)/RMS(源)，
//! mode=1，time=1）：
//!
//! | 档位 | 中位 | 最差 | <0.70 的素材数 | 质心比中位（括号内是 pitch 比） |
//! |---|---|---|---|---|
//! | +5 半音 | 1.001 | 0.858 | 0 | 1.050（1.335） |
//! | +7 半音 | 1.000 | 0.904 | 0 | 1.054（1.498） |
//! | +12 半音 | 0.999 | 0.832 | 0 | 1.034（2.000） |
//! | -5 半音 | 1.000 | 0.980 | 0 | 1.012（0.749） |
//! | -7 半音 | 1.000 | 0.981 | 0 | 1.016（0.667） |
//! | -12 半音 | 1.000 | 0.959 | 0 | 1.023（0.500） |
//!
//! **真实素材在 ±12 半音内电平无损**（中位 1.000，最差 0.83，没有一个薄到 0.70
//! 以下）。也就是说上面那张合成信号的表**不代表真实听感** —— 真实录音里的抖动、
//! 噪声与声门脉冲的尖锐激励足以打断颗粒间的相干性，抵消起不来。
//!
//! 质心比远小于 pitch 比（+12 半音处 1.034 vs 2.000）还顺带证明了另一件事：
//! 这些素材走的**确实是颗粒重排路径**（共振峰没动、不是花栗鼠），而不是退化成
//! 按时间映射的重采样。
//!
//! 所以这个「已知极限」现在的定位是：**它约束的是验收信号的选择，不是真实素材**。
//! 已钉住的只有纯正弦这一支：`tests::near_octave_up_phase_cancellation_is_pinned`
//! —— 它守的是内核几何本身（一旦有人改动颗粒编排，纯正弦这一支会最先变红），
//! 不是一条真实场景的回归线。
//!
//! 可能的出路（都还没做，任一都需要单独听感回归）：把「变调」改写成
//! 「先按 ratio 重采样、再以 ratio=1 做时长变换」（重采样式变调会连带移动
//! 共振峰，与 PSOLA 保共振峰的初衷冲突）；或给颗粒做显式相位对齐后再叠加
//! （phase-locked PSOLA，已经偏离 PitchNet 的参考实现）。

use std::cell::Cell;
use std::f64::consts::PI as PI64;

// ---------------------------------------------------------------------------
// 上次渲染的「有没有周期可同步」诊断计数
// ---------------------------------------------------------------------------

thread_local! {
    /// 上一次 mode=1 渲染得到的 `(voiced 帧数, pitch mark 数)`。
    ///
    /// 存在的唯一理由是修掉一个**静默失效**：
    ///
    /// 对非周期素材（噪声、打击乐、短到只有一个辅音的切片），逐帧 YIN 一帧都过不了
    /// 阈值 → `frames` 全为 unvoiced → 每颗颗粒都落到固定颗粒路径，而固定颗粒的推进量
    /// 是**常量**（不随 ratio 变）→ 输出就是「按时间映射重采样原声」，**音高完全不移动**。
    ///
    /// 问题在于它照样返回一段合法音频、不抛异常。调用方 `playSample` 的降级链
    /// （PSOLA → SOLA → 原声）是靠 catch 推进的，于是永远认为 mode=1 成功了 ——
    /// 用户看到的就是「装配面板 Shift+↑ 在部分素材上完全没反应」。
    /// 实测真素材：**13/41 静默不变调**（输出与源逐样本相同，频谱质心比恰好 1.000）。
    ///
    /// 调用方读这个计数：`voiced == 0 && pitch != 1` 就是上面那种「成功但没做事」，
    /// 应当降级到 SOLA。计数只用于诊断，不参与任何合成计算。
    static LAST_VOICED: Cell<(usize, usize)> = const { Cell::new((0, 0)) };
}

/// 上一次 mode=1 渲染的 `(voiced 帧数, pitch mark 数)`。见 [`LAST_VOICED`]。
pub fn last_voiced_stats() -> (usize, usize) {
    LAST_VOICED.with(|c| c.get())
}

/// 每次 `hajimi_tx_run` 开头由调用方清零，避免读到上一次 mode=1 的陈旧值。
pub(crate) fn reset_last_voiced_stats() {
    LAST_VOICED.with(|c| c.set((0, 0)));
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

pub(crate) const HOP: usize = 480; // 10ms @48k（autotune 控制循环的帧栅格同源）
const WIN: usize = 2048; //    ~43ms 分析窗

/// YIN 的搜索范围。刻意比颗粒周期范围窄：min_tau 越小越容易咬到某个谐波，
/// 上限 900Hz 已覆盖加速/夹音后的人声；下限 50Hz 是 WIN=2048 能可靠支撑的极限
/// （YIN 要求 WIN ≈ 2×max_tau）。
const YIN_MIN_HZ: f32 = 50.0;
const YIN_MAX_HZ: f32 = 900.0;

/// 颗粒周期钳位 —— 照搬 PitchNet kMinPeriodHz / kMaxPeriodHz。只防野帧造出
/// 荒谬的颗粒，不参与检测。
const PERIOD_MIN_HZ: f32 = 25.0;
const PERIOD_MAX_HZ: f32 = 2200.0;

const CONF_TH: f32 = 0.12;
const OCTAVE_TH: f32 = 0.7; // 八度纠错阈值（≈8 半音）
const MEDIAN_WINDOW: usize = 5;

/// 清音颗粒半宽（秒）—— 照搬 PitchNet kUnvoicedGrainSeconds。
/// 固定颗粒的半宽直接在 [`render_track`] 里按它算成样本，不再另存窗/跳常量。
const UNVOICED_GRAIN_SEC: f32 = 0.006;

/// Σw 归一的**除数下限** —— 数值照搬 PitchNet `kMinEnvelope`（0.3），语义见
/// [`synth_channel`]：它是「除数不小于它」，不是「低于它就置零」。
/// 降调时颗粒被摊开、重叠趋零，除以下限而不是硬除，留下的平滑凹陷是
/// 「要的周期比源里有的多」的诚实代价。
const MIN_ENVELOPE: f32 = 0.3;

// ---------------------------------------------------------------------------
// 数据结构
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Default)]
pub struct PitchFrame {
    pub f0: f32,
    pub conf: f32,
    pub voiced: bool,
}

#[derive(Clone, Copy)]
pub struct Mark {
    pub pos: f32,
}

// ---------------------------------------------------------------------------
// 帧栅格约定（全链路唯一入口）
// ---------------------------------------------------------------------------

/// 样本位置 → 帧号（可为小数）。第 i 帧的中心样本 = WIN/2 + i*HOP。
#[inline]
pub fn frame_index(pos: f32) -> f32 {
    (pos - WIN as f32 * 0.5) / HOP as f32
}

/// 帧号 → 帧中心样本位置 —— [`frame_index`] 的逆。
///
/// 生产路径目前只用到正向（`frame_index`，控制环曲线查表与 mark 判清浊）；
/// 这个逆函数留在原处，是因为约定本身要有往返自证：删掉它，「帧 i 的中心 =
/// WIN/2 + i*HOP」就没人能对着代码验证，只能靠口口相传（曾经正是这样错的）。
/// 帧栅格往返一致由 `frame_grid_is_round_trip` 测试守着。
#[allow(dead_code)]
#[inline]
pub fn frame_centre(frame: f32) -> f32 {
    WIN as f32 * 0.5 + frame * HOP as f32
}

/// 该样本位置落在哪一帧（最邻近帧，越界夹到首/末帧）。
#[inline]
fn frame_round(pos: f32) -> usize {
    let fi = frame_index(pos);
    if fi <= 0.0 {
        0
    } else {
        fi.round() as usize
    }
}

// ---------------------------------------------------------------------------
// 模块 A：逐帧 F0 轨迹
// ---------------------------------------------------------------------------

use crate::yin_core;

/// 单帧 YIN 音高检测——薄包装 yin_core，适配 center/sr 参数风格。
/// 返回 (f0_hz, confidence)；无过阈帧返回 (0.0, 0.0)
fn yin_frame(x: &[f32], center: usize, sr: f32) -> (f32, f32) {
    let n = x.len();
    // 窗最多占 2/3 缓冲：剩下 1/3 必须留给最大 lag。差分函数要 offset + win + tau <= n，
    // 而 YIN 的可靠上限是 tau <= win/2，两条合起来正好给出 win <= 2n/3。
    //
    // 曾经的写法是「窗放不下就返回无音高」，于是 <WIN（43ms）的切片一帧都取不到
    // → 整段被判无音高 → 只走固定颗粒直通 → **变调静默失效**。鬼畜素材里 30~40ms
    // 的切片并不罕见，这不该静默变成「不处理」。
    let win = WIN.min(n * 2 / 3);
    if win < 256 {
        return (0.0, 0.0);
    }

    let min_tau = (sr / YIN_MAX_HZ).ceil().max(2.0) as usize;
    let mut max_tau = (sr / YIN_MIN_HZ)
        .floor()
        .min((WIN - 2) as f32) as usize;
    max_tau = max_tau.min(win / 2).min(n - win);
    if max_tau <= min_tau {
        return (0.0, 0.0);
    }

    // 窗居中。长素材里 center + half <= n - max_tau 恒成立（track_pitch 保证），所以
    // offset = center - half，帧栅格约定原样成立；只有尾窗/短窗才会被夹回来 —— 那里
    // 复用最后一个装得下的完整窗，起到「尾部保持」的作用。
    let half = win / 2;
    let offset = center.saturating_sub(half).min(n - win - max_tau);
    // 靠近缓冲末尾时按实际余量收窄搜索范围，而不是整帧判无效 —— 否则每段尾部
    // 约 60ms 会被误判成清音，短素材上直接吃掉整段。
    let avail = n - offset - win;
    if max_tau > avail {
        max_tau = avail;
    }
    if max_tau <= min_tau {
        return (0.0, 0.0);
    }

    match yin_core::yin_frame(x, offset, win, min_tau, max_tau, CONF_TH, sr) {
        Some(r) => (r.freq, r.conf),
        // YIN 的 CMND 阈值对「短切片 / 带音效」素材偏严 —— 实测真素材 41 个里有
        // 13 个一帧都过不了，于是整段落到固定颗粒路径、**音高完全不动**，而且不抛
        // 异常（调用方的降级链永远以为成功）。兜底走自相关 + 谐波性：它不会像
        // 「放宽阈值」那样咬到二次谐波。
        //
        // 允许个别野帧漏过来也没关系：track_pitch 后面还有去异常 / 中值 / 八度纠错
        // 三道后处理，专门压这种噪声帧。置信度直接回传周期性分数（0..1）。
        None => match yin_core::autocorr_frame(x, offset, win, min_tau, max_tau, sr) {
            Some(r) => (r.freq, r.score),
            None => (0.0, 0.0),
        },
    }
}

/// 逐帧 F0 轨迹提取 + 后处理
pub fn track_pitch(x: &[f32], sr: f32) -> Vec<PitchFrame> {
    let mut frames = Vec::new();
    let n = x.len();
    if n < 256 {
        return frames;
    }
    let mut c = WIN / 2;
    // 只要求帧中心落在缓冲内：短于 WIN 的素材也能得到帧（窗已在 yin_frame 内收缩）。
    // 长素材上末尾多出的 2~3 帧复用最后一个完整窗，起到「尾部保持」的作用。
    while c < n {
        let (f0, conf) = yin_frame(x, c, sr);
        let voiced = conf >= CONF_TH && f0 > 0.0;
        frames.push(PitchFrame { f0, conf, voiced });
        c += HOP;
    }

    // 后处理：5 步流水线（照搬 PitchNet F0Smoother）
    remove_outliers(&mut frames, 1.5);
    median_filter_f0(&mut frames);
    smooth_transitions(&mut frames, 3);
    octave_correct(&mut frames);
    interp_unvoiced(&mut frames);

    frames
}

/// ① 去异常：相邻帧音高比 > max_ratio 或 < 1/max_ratio 视为八度错误，
/// 用前后帧均值修复。PitchNet 默认 max_ratio = 1.5（约 7 半音）。
fn remove_outliers(frames: &mut [PitchFrame], max_ratio: f32) {
    let len = frames.len();
    if len < 3 {
        return;
    }
    for i in 1..len {
        if !frames[i].voiced || frames[i].f0 <= 0.0 {
            continue;
        }
        if !frames[i - 1].voiced || frames[i - 1].f0 <= 0.0 {
            continue;
        }
        let ratio = frames[i].f0 / frames[i - 1].f0;
        if ratio > max_ratio || ratio < 1.0 / max_ratio {
            if i + 1 < len && frames[i + 1].voiced && frames[i + 1].f0 > 0.0 {
                frames[i].f0 = (frames[i - 1].f0 + frames[i + 1].f0) * 0.5;
            } else {
                frames[i].f0 = frames[i - 1].f0;
            }
        }
    }
}

/// ③ 高斯加权平滑：只对 voiced 帧操作，window 为奇数。
fn smooth_transitions(frames: &mut [PitchFrame], window: usize) {
    let len = frames.len();
    if len == 0 || window < 1 {
        return;
    }
    let half = window / 2;
    let mut weights = vec![0.0f32; 2 * half + 1];
    for (j, w) in weights.iter_mut().enumerate() {
        let jj = j as f32 - half as f32;
        *w = (-0.5 * jj * jj / (half as f32 * half as f32 + 1.0)).exp();
    }

    let mut smoothed = vec![0.0f32; len];
    for i in 0..len {
        if !frames[i].voiced || frames[i].f0 <= 0.0 {
            smoothed[i] = frames[i].f0;
            continue;
        }
        let mut sum = 0.0f32;
        let mut wsum = 0.0f32;
        let lo = i.saturating_sub(half);
        let hi = (i + half).min(len - 1);
        for j in lo..=hi {
            if frames[j].voiced && frames[j].f0 > 0.0 {
                let w = weights[j - lo + (half - (i - lo))];
                sum += frames[j].f0 * w;
                wsum += w;
            }
        }
        smoothed[i] = if wsum > 0.0 { sum / wsum } else { frames[i].f0 };
    }
    for (i, f) in frames.iter_mut().enumerate() {
        if f.voiced {
            f.f0 = smoothed[i];
        }
    }
}

/// 5 点中值滤波，只在 voiced 帧上做
fn median_filter_f0(frames: &mut [PitchFrame]) {
    let len = frames.len();
    if len < MEDIAN_WINDOW {
        return;
    }

    let mut f0s: Vec<f32> = frames.iter().map(|f| f.f0).collect();
    let half = MEDIAN_WINDOW / 2;

    for i in half..len - half {
        if !frames[i].voiced {
            continue;
        }
        let mut window: Vec<f32> = Vec::with_capacity(MEDIAN_WINDOW);
        for j in i - half..=i + half {
            if frames[j].voiced && frames[j].f0 > 0.0 {
                window.push(frames[j].f0);
            }
        }
        if !window.is_empty() {
            window.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            f0s[i] = window[window.len() / 2];
        }
    }

    for (i, frame) in frames.iter_mut().enumerate() {
        if frame.voiced {
            frame.f0 = f0s[i];
        }
    }
}

/// 八度纠错：若 |log2(f0[t]/f0_prev_voiced)| > OCTAVE_TH，尝试 ×2/÷2/×3/÷3
fn octave_correct(frames: &mut [PitchFrame]) {
    let mut prev_f0 = 0.0f32;

    for frame in frames.iter_mut() {
        if !frame.voiced || frame.f0 <= 0.0 {
            continue;
        }

        if prev_f0 > 0.0 {
            let ratio = frame.f0 / prev_f0;
            let log2_ratio = ratio.log2().abs();

            if log2_ratio > OCTAVE_TH {
                let candidates = [
                    frame.f0 * 2.0,
                    frame.f0 / 2.0,
                    frame.f0 * 3.0,
                    frame.f0 / 3.0,
                ];
                let mut best = frame.f0;
                let mut best_dist = log2_ratio;
                for &cand in &candidates {
                    if cand >= YIN_MIN_HZ && cand <= YIN_MAX_HZ {
                        let dist = (cand / prev_f0).log2().abs();
                        if dist < best_dist {
                            best_dist = dist;
                            best = cand;
                        }
                    }
                }
                frame.f0 = best;
            }
        }

        prev_f0 = frame.f0;
    }
}

/// 清音帧线性插值出连续 F0（仅供 mark 生成参考，不改 voiced 标志）
fn interp_unvoiced(frames: &mut [PitchFrame]) {
    let len = frames.len();
    if len == 0 {
        return;
    }

    let first_voiced = frames.iter().position(|f| f.voiced);
    let last_voiced = frames.iter().rposition(|f| f.voiced);

    match (first_voiced, last_voiced) {
        (Some(first), Some(last)) => {
            let first_f0 = frames[first].f0;
            for i in 0..first {
                frames[i].f0 = first_f0;
            }
            let last_f0 = frames[last].f0;
            for i in last + 1..len {
                frames[i].f0 = last_f0;
            }
            let mut prev_voiced = first;
            for i in first + 1..last {
                if frames[i].voiced {
                    prev_voiced = i;
                } else {
                    let mut next_voiced = prev_voiced;
                    for j in i + 1..=last {
                        if frames[j].voiced {
                            next_voiced = j;
                            break;
                        }
                    }
                    let prev_f0 = frames[prev_voiced].f0;
                    let next_f0 = frames[next_voiced].f0;
                    let t = (i - prev_voiced) as f32 / (next_voiced - prev_voiced) as f32;
                    frames[i].f0 = prev_f0 + t * (next_f0 - prev_f0);
                }
            }
        }
        _ => {
            for frame in frames.iter_mut() {
                frame.f0 = 0.0;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 帧级查询（PitchNet f0AtFrame / voicedAtFrame / periodAt 的对应物）
// ---------------------------------------------------------------------------

/// 在指定样本位置取 F0（线性插值；不跨越「一侧为 0」的边界）。
pub fn f0_at(pos: f32, frames: &[PitchFrame]) -> f32 {
    if frames.is_empty() {
        return 0.0;
    }
    let fi = frame_index(pos);
    if fi <= 0.0 {
        return frames[0].f0;
    }
    let idx = fi.floor() as usize;
    let frac = fi - idx as f32;
    if idx + 1 >= frames.len() {
        return frames[frames.len() - 1].f0;
    }
    let a = frames[idx].f0;
    let b = frames[idx + 1].f0;
    if a <= 0.0 {
        return b;
    }
    if b <= 0.0 {
        return a;
    }
    a * (1.0 - frac) + b * frac
}

/// 该样本位置是否 voiced（取最邻近帧，越界夹到首/末帧）。
///
/// 越界必须**夹**而不是判 false：末帧中心之后还有最多 HOP 的样本，短切片上更是
/// 大半个缓冲。判 false 等于凭空造出一段清音尾巴，让本该合成的尾部走直通。
pub fn voiced_at_sample(pos: f32, frames: &[PitchFrame]) -> bool {
    if frames.is_empty() {
        return false;
    }
    frames[frame_round(pos).min(frames.len() - 1)].voiced
}

/// 该样本位置处的周期（样本数）。返回 0 表示无可用 F0。
/// hz 钳位照搬 PitchNet periodAt 的 kMinPeriodHz/kMaxPeriodHz。
pub fn period_at_sample(pos: f32, frames: &[PitchFrame], sr: f32) -> f32 {
    let f0 = f0_at(pos, frames);
    if !(f0 > 0.0) || !f0.is_finite() {
        return 0.0;
    }
    sr / f0.clamp(PERIOD_MIN_HZ, PERIOD_MAX_HZ)
}

// ---------------------------------------------------------------------------
// 模块 B：Pitch marks（PitchNet detectPitchMarks）
// ---------------------------------------------------------------------------

/// 归一化互相关 —— 两段等长窗口的相关系数，范围 [-1, 1]
fn normalised_correlation(x: &[f32], a_center: isize, b_center: isize, half: isize) -> f32 {
    let mut dot = 0.0f64;
    let mut ea = 0.0f64;
    let mut eb = 0.0f64;
    let n = x.len() as isize;
    for off in -half..half {
        let ia = a_center + off;
        let ib = b_center + off;
        let va = if ia >= 0 && ia < n { x[ia as usize] as f64 } else { 0.0 };
        let vb = if ib >= 0 && ib < n { x[ib as usize] as f64 } else { 0.0 };
        dot += va * vb;
        ea += va * va;
        eb += vb * vb;
    }
    let denom = (ea * eb).sqrt();
    if denom > 1e-12 {
        (dot / denom) as f32
    } else {
        0.0
    }
}

/// 在 mark 序列里找最接近 `pos` 的那一颗；离得超过一个周期就返回 None
/// （段前导、段尾、以及短到没被标记的 voiced 段，调用方应退回直通路径，
/// 而不是把同一颗远处的脉冲反复盖章）。
fn nearest_mark(marks: &[Mark], pos: f32, period: f32) -> Option<usize> {
    if marks.is_empty() || !(period > 0.0) {
        return None;
    }
    let upper = marks.partition_point(|m| m.pos < pos);
    let mut idx = upper.min(marks.len() - 1);
    if idx > 0 && (marks[idx - 1].pos - pos).abs() < (marks[idx].pos - pos).abs() {
        idx -= 1;
    }
    if (marks[idx].pos - pos).abs() > period {
        None
    } else {
        Some(idx)
    }
}

/// 在 `[from, to)` 内生成 pitch marks —— 照搬 PitchNet PsolaSynthesizer::detectPitchMarks
fn detect_marks_range(
    x: &[f32],
    from: usize,
    to: usize,
    frames: &[PitchFrame],
    sr: f32,
) -> Vec<Mark> {
    let mut marks: Vec<Mark> = Vec::new();
    let n = x.len();
    let end = to.min(n);
    if end <= from || frames.is_empty() {
        return marks;
    }

    let mut sample = from;
    while sample < end {
        while sample < end && !voiced_at_sample(sample as f32, frames) {
            sample += 1;
        }
        if sample >= end {
            break;
        }
        let run_start = sample;
        while sample < end && voiced_at_sample(sample as f32, frames) {
            sample += 1;
        }
        let run_end = sample;

        // 照搬 PitchNet：run 必须够 2 个周期才值得标；否则交给 OLA 路径
        let seed_period = period_at_sample(run_start as f32, frames, sr);
        if seed_period <= 0.0 {
            continue;
        }
        if ((run_end - run_start) as f32) < seed_period * 2.0 {
            continue;
        }

        // 种子：第一个周期内能量最强点，让 run 从声门脉冲起，而不是从
        // voiced 标志恰好翻起来的地方起
        let seed_end = ((run_start as f32 + seed_period).round() as usize).min(run_end);
        let mut seed = run_start;
        let mut best = -1.0f32;
        for i in run_start..seed_end.max(run_start + 1) {
            let mag = x[i].abs();
            if mag > best {
                best = mag;
                seed = i;
            }
        }
        marks.push(Mark { pos: seed as f32 });

        // 逐周期前进，让互相关修正预测值。这能自纠略偏的 F0，而且不像
        // 裸峰值拾取那样在某个谐波比基频更响时跳八度。
        let mut current = seed;
        for _ in 0..100_000 {
            let period = period_at_sample(current as f32, frames, sr);
            if period <= 0.0 {
                break;
            }
            let predicted = current + period.round().max(1.0) as usize;
            if predicted >= run_end {
                break;
            }
            let search_radius = ((period * 0.25) as isize).max(2);
            let half = ((period * 0.5) as isize).max(4);

            let first = (current as isize + 2).max(predicted as isize - search_radius);
            let last = ((run_end as isize) - 1).min(predicted as isize + search_radius);
            if first > last {
                break;
            }
            let mut best_candidate = predicted;
            let mut best_score = -2.0f32;
            for cand in first..=last {
                let score = normalised_correlation(x, current as isize, cand, half);
                if score > best_score {
                    best_score = score;
                    best_candidate = cand as usize;
                }
            }
            if best_candidate >= run_end {
                break;
            }
            marks.push(Mark { pos: best_candidate as f32 });
            current = best_candidate;
        }
    }

    marks.sort_by(|a, b| a.pos.partial_cmp(&b.pos).unwrap_or(std::cmp::Ordering::Equal));
    marks.dedup_by(|a, b| (a.pos - b.pos).abs() < 1.0);
    marks
}

/// 全曲 pitch marks —— 变调路径的唯一入口。
pub fn detect_marks(x: &[f32], frames: &[PitchFrame], sr: f32) -> Vec<Mark> {
    detect_marks_range(x, 0, x.len(), frames, sr)
}

// ---------------------------------------------------------------------------
// 模块 C：合成内核（PitchNet render）
// ---------------------------------------------------------------------------

/// 颗粒外套的零padding —— 照搬 PitchNet：颗粒跨骑在落点上，两端都要能放下一颗。
fn grain_pad(sr: f32) -> usize {
    (2.0 * sr as f64 / PERIOD_MIN_HZ as f64).round() as usize
}

/// 时间映射：输出样本位置 → 源样本位置。常量参数下就是 `o / time`。
#[inline]
fn src_pos_of(out_pos: f64, time: f64) -> f64 {
    out_pos / time
}

/// 变调比的取值域 —— 与 mode=1 的对外钳位一致（stretch.rs `clamp(0.25, 4.0)`，
/// 即 ±24 半音）。曲线闭包给出 NaN/非正值时一律退化为 1.0：宁可原样通过，
/// 不可产出爆音。
const MIN_RATIO: f64 = 0.25;
const MAX_RATIO: f64 = 4.0;

/// 该颗粒的变调比 —— PitchNet `ratioAt(...)` 的对应物。
///
/// 传进来的是**这颗颗粒要读的源位置**（不是输出位置）：曲线在源内容上定义 ——
/// 变调路径给常量闭包 `|_| pitch`，自动修音的控制环曲线本来就是逐帧分析源得来的。
/// 时长变换恒等（time≡1）时源位置与输出位置重合，两种用法等价。
/// 每颗粒一次闭包调用，常量路径没有可测的开销。
#[inline]
fn ratio_lookup(src_pos: f64, ratio: &dyn Fn(f64) -> f64) -> f64 {
    let r = ratio(src_pos);
    if r.is_finite() && r > 0.0 {
        r.clamp(MIN_RATIO, MAX_RATIO)
    } else {
        1.0
    }
}

/// 「一段 voiced run 从该输出位置开始」时，第一颗颗粒要挪多少才能落在
/// 它的 pitch mark 上（单位：输出样本）。无 run / 附近无 mark 时为 0。
///
/// 吸附误差是**源**样本，除以局部 d(source)/d(output) 才回到输出样本。
fn anchor_correction_at(
    out_pos: f64,
    time: f64,
    frames: &[PitchFrame],
    marks: &[Mark],
    sr: f32,
) -> f64 {
    let source = src_pos_of(out_pos, time);
    let period = period_at_sample(source as f32, frames, sr);
    if period <= 0.0 || !voiced_at_sample(source as f32, frames) {
        return 0.0;
    }
    let idx = match nearest_mark(marks, source as f32, period) {
        Some(i) => i,
        None => return 0.0,
    };
    let delta = 0.5 * HOP as f64;
    let slope = (src_pos_of(out_pos + delta, time) - src_pos_of(out_pos - delta, time)) / (2.0 * delta);
    if slope <= 1.0e-3 {
        return 0.0;
    }
    (marks[idx].pos as f64 - source) / slope
}

/// 沿输出时间轴铺颗粒 —— PitchNet `PsolaSynthesizer::render` 的 Rust 移植。
///
/// 每颗颗粒独立去问时间映射「我该读源哪里」，再吸附到最近的 pitch mark。
/// 于是**拉伸就是重复颗粒、压缩就是跳过颗粒，不需要任何特例**，任意重定时
/// 也无需额外机制。
///
/// `ratio` 在**颗粒的源位置**上取变调比：常量路径传 `|_| pitch`，
/// 自动修音传逐帧控制环曲线 —— 两条路走的是同一段编排代码。
///
/// 返回 (padded_acc, padded_env)，长度 = out_len + 2*grain_pad。
fn render_track(
    x: &[f32],
    marks: &[Mark],
    frames: &[PitchFrame],
    sr: f32,
    ratio: &dyn Fn(f64) -> f64,
    time: f64,
    out_len: usize,
) -> (Vec<f32>, Vec<f32>) {
    let pad = grain_pad(sr);
    let padded_len = out_len + 2 * pad;
    let mut padded = vec![0.0f32; padded_len];
    let mut env = vec![0.0f32; padded_len];

    // 这里**不能**因为 marks 为空就提前返回零缓冲。
    //
    // 没有 marks 只意味着「没有可同步的周期」（噪声、打击乐、太短或检测失败的素材），
    // 不意味着「不该处理」。那种情况下逐颗粒判清浊会全部落到固定颗粒路径 —— 也就是
    // 照时间映射重采样原声，正是 PitchNet 对清音的做法。提前返回零缓冲会让这些素材
    // 输出整段静音（mask 默认 1.0 = 取合成结果 = 全零）。
    if out_len == 0 {
        return (padded, env);
    }

    let sr_f64 = sr as f64;
    let unvoiced_half = ((UNVOICED_GRAIN_SEC as f64) * sr_f64).round().max(8.0);
    let min_advance = 4.0f64;
    let max_advance = 2.0 * sr_f64 / PERIOD_MIN_HZ as f64;

    let output_end = out_len as f64 + pad as f64;
    let mut output_pos = -(pad as f64);
    let mut needs_anchor = true;
    // 纯防跑飞：下面 clamp 允许的最小推进是 4 样本，所以这是任何合法渲染
    // 所需颗粒数的上限。按典型推进量来定会悄悄把高音区尾部截成静音。
    let guard_limit = padded_len / 4 + 1024;
    let mut guard = 0usize;

    while output_pos < output_end && guard < guard_limit {
        guard += 1;

        let source_pos = src_pos_of(output_pos, time);
        let mut voiced =
            voiced_at_sample(source_pos as f32, frames) && !marks.is_empty();

        let mut grain_centre = 0.0f32;
        // 两个分支都会赋值；不预置初始值，免得「初始化后立刻被覆盖」的无用告警。
        let mut grain_half: f32;
        let mut advance: f64;
        let mut mark_idx: Option<usize> = None;

        if voiced {
            let period = period_at_sample(source_pos as f32, frames, sr);
            match nearest_mark(marks, source_pos as f32, period) {
                Some(i) => {
                    mark_idx = Some(i);
                    grain_centre = marks[i].pos;
                }
                None => voiced = false,
            }
        }

        if voiced {
            let i = mark_idx.unwrap();
            // 局部周期取自 marks 本身而不是 F0：marks 已被互相关精修，是更好的估计。
            // 但只在两者相差一个八度以内时采信 —— voiced run 末颗 mark 的邻居属于
            // 下一段，其「间距」是中间整口气（上千样本）。照字面用会造出一颗巨大颗粒，
            // 把单个脉冲抹到整段间隙上还盖过后一个音符，听上去就是前一个音在原音高上叠影。
            let f0_period = period_at_sample(grain_centre, frames, sr);
            let mut period = f0_period as f64;
            if marks.len() >= 2 && f0_period > 0.0 {
                let neighbour = if i + 1 < marks.len() { i + 1 } else { i.saturating_sub(1) };
                if neighbour != i {
                    let spacing = (marks[neighbour].pos - grain_centre).abs() as f64;
                    if spacing > 1.0
                        && spacing > 0.5 * period
                        && spacing < 2.0 * period
                    {
                        period = spacing;
                    }
                }
            }
            advance = period / ratio_lookup(source_pos, ratio);
            // 窗宽恒为 2 个**分析**周期，永远不用合成周期。窗的零点正好落在相邻
            // 脉冲上，这就是「每颗粒一个脉冲」的全部机制：把这些脉冲以新间距排放，
            // 音高就移动，而脉冲内部的波形（也就是共振峰）完全没动。
            //
            // 靠加宽窗来保证降调时的重叠看起来诱人但是错的：相邻脉冲会从零点跑出来，
            // 下面的包络除法把它们还原成满幅，变调就悄悄消失了（实测降八度读回来
            // 等于没变）。所以降调时接受包络上的平滑凹陷。
            grain_half = (period.round() as f32).max(4.0);
        } else {
            // 没有周期可同步：固定颗粒，直接按时间映射取源。恒等映射 + ratio=1
            // 时这就是一次纯拷贝，辅音和呼吸就是这么保住的。
            grain_centre = source_pos.round() as f32;
            grain_half = unvoiced_half as f32;
            advance = unvoiced_half;

            // 把下一段 voiced 的锚定**提前花在这里**，而不是在起音点上。
            //
            // 锚定把一段 run 的第一颗颗粒挪到它的 pitch mark 上。在起音点上直接挪会
            // 让输出时间轴跳一下，而前跳会空出一段谁都不覆盖的区间：实测输出在音符
            // 起音前几毫秒掉到源的 0.6，听上去就是咔哒 —— 而且它正好落在 blend mask
            // 于合成/原声之间做斜坡的地方。
            //
            // 这条路径上颗粒位置是自由的（内容由时间映射决定落在哪，与颗粒坐在哪无关），
            // 所以把修正吸收进这次推进是**挪边界**而不是在边界上撕个洞，
            // 于是 voiced run 一开始就已经对齐，后面没有可跳的东西。
            let correction = anchor_correction_at(output_pos + advance, time, frames, marks, sr);
            if correction != 0.0 {
                let max_a = 1.5 * unvoiced_half;
                advance = (advance + correction).clamp(min_advance, max_a);
            }

            // 把颗粒宽度撑到至少等于它即将跨出的 hop。拷贝路径上宽度是自由的，
            // 而宽度 >= hop 才能保持相邻颗粒 50% 以上重叠，OLA 的包络就不会下凹。
            // 少了这一步，上面吸收修正会把 hop 拉过窗宽，两个窗在尾巴上相接而不是
            // 在肩膀上相接，包络掉到 ~0.2（低于下面的 floor），输出在几毫秒里
            // 掉到源的 0.6 —— 正是这里要消除的那个咔哒。
            grain_half = grain_half.max(advance.ceil() as f32);
        }

        advance = advance.clamp(min_advance, max_advance);

        // 每个 voiced run 的开头设一次相位，之后就撒手。
        //
        // 吸附到最近 mark 会把颗粒在源里挪最多半个周期；不在起音点把它还回去，
        // 整段 run 就会整体滑一个亚周期偏移 —— 单听不出来，但这段音频要在区域
        // 边缘和未改动的原声交叉淡化，那里一个偏移就把拼接缝梳状滤波了。
        //
        // 但**只在起音点上**：颗粒间距偏离分析 mark 不是误差，它就是变调本身。
        // 每颗都校正会把输出时间轴钉死在源上，变调完全消失。所以：锚定一次，
        // 之后累加。ratio=1 时累加恰好等于 mark 间距，对齐免费成立，整趟退化成拷贝。
        let mut placement = output_pos;
        if voiced && needs_anchor {
            let correction = anchor_correction_at(output_pos, time, frames, marks, sr);
            // 只在颗粒确实靠近 mark 时才消费这次锚定。前导里、第一颗 mark 之前，
            // 最近的一颗可能在几千样本之外；在那上面花掉锚定会让整段 run 永久偏着。
            // 标记区内最近 mark 必在半个周期内，所以这会在第一颗该锚的颗粒上触发。
            if correction != 0.0 && correction.abs() <= grain_half as f64 {
                placement = output_pos + correction;
                needs_anchor = false;
            }
        } else if !voiced {
            // 下一个 voiced 起音点重新锚定，让呼吸/辅音之后的 run 仍与原声对齐。
            needs_anchor = true;
        }

        // Hann 颗粒，长度 2*grain_half，盖在输出位置上。
        // phase 里的 +0.5 让窗样点落在 (k+0.5)/(2N) 而不是 k/(2N) 上，
        // 端点不取到 0（PitchNet 同款；直接影响 Σw 的精确性）。
        let gh = grain_half.round() as isize;
        let denom = (2 * gh) as f64;
        let placement_i = placement.round() as isize + pad as isize;
        let centre_i = grain_centre.round() as isize;
        for offset in -gh..gh {
            let dest = placement_i + offset;
            if dest < 0 || dest >= padded_len as isize {
                continue;
            }
            let si = centre_i + offset;
            if si < 0 || si >= x.len() as isize {
                continue;
            }
            let phase = (offset + gh) as f64 + 0.5;
            let w = (0.5 - 0.5 * (2.0 * PI64 * phase / denom).cos()) as f32;
            padded[dest as usize] += x[si as usize] * w;
            env[dest as usize] += w;
        }

        output_pos = placement + advance;
    }

    (padded, env)
}

/// 单声道 PSOLA 渲染 + Σw 归一。返回 `(synth, env)`，两者长度都是 out_len。
fn synth_channel(
    x: &[f32],
    marks: &[Mark],
    frames: &[PitchFrame],
    sr: f32,
    ratio: &dyn Fn(f64) -> f64,
    time: f64,
    out_len: usize,
) -> (Vec<f32>, Vec<f32>) {
    let pad = grain_pad(sr);
    let (padded, env) = render_track(x, marks, frames, sr, ratio, time, out_len);

    // 颗粒重叠多少取决于新周期与旧周期差多少，所以窗和并非常数。除以它让幅度
    // 对任意 ratio 都精确 —— 包括 1.0，那里本式退化成重建原始样本，不需要事后补偿。
    // floor 而不是仅防零：降调把颗粒摊到几乎不重叠，八度降调时首尾相贴、包络在每条
    // 缝上触零；除以此处残留会把「几乎没有」放大成「听得见」。用 floor 留下平滑的
    // 幅度凹陷，是要的周期比源里有的多这件事的诚实代价。重叠良好的区域 Σw 在 1.0
    // 附近或以上，所以这个 floor 在温和 ratio 下永不介入，也从不碰 unity 情况。
    let mut synth = vec![0.0f32; out_len];
    let env_kept: Vec<f32> = (0..out_len).map(|i| env[i + pad]).collect();
    // 除数的**下限** —— 不是「低于下限就置零」。
    //
    // PitchNet 的注释把它自己的意图写得很清楚：用 floor「留下平滑的幅度凹陷，
    // 这是要的周期比源里有的多这件事的诚实代价」。但它的代码是
    //   `if (weight > kMinEnvelope) output = padded / weight;`   // output 初值 0
    // —— 于是在 Σw 跌破下限的那一瞬，输出从**满幅**直接跳到**精确 0**。
    // 那是一个人为阶跃，不是「平滑凹陷」；我们逐行照抄，于是把它一起抄了过来。
    //
    // Σw 在颗粒接缝处的值只取决于「推进量 A / 半窗宽 grain_half」：
    // 接缝处 Σw = 2·Hann(A/2)，而 voiced 路径 A/grain_half = 1/ratio。
    // A = 1.5·grain_half ⟺ ratio = 2/3 = **-7.02 半音**，此处 Σw = 0.293，
    // 刚好跌破 0.3 —— 所以这个阶跃从 -7 半音开始，**每个周期一次**；
    // 到 -12 半音（ratio 0.5）时颗粒首尾相贴、Σw 在每条缝上归零，
    // 约 23% 的样点被置零，听感就是「嗡嗡的撕裂感」而不是干净的低音。
    //
    // 实测（41 真素材，`scripts/_probe-clickcount.mjs` 的「增簇中位」，越小越好）：
    //   -5 → +1（未触发）  -7 → +11  -9 → +30  -12 → +24（单素材最大 +753）
    // 阶梯正好落在 -7，与上面的几何推导一致。
    //
    // 给除数下下限即可修掉：w = 0.3 两侧都是 padded/w = x，天然连续；
    // w → 0 时输出按 w 平滑收敛到 0，正是注释里说的那个凹陷。
    // Σw ≥ 0.3 的区域（ratio ≳ 0.67，即全部升调与 unity）逐样本不变 ——
    // unity 的逐位精确重建不受影响。
    for i in 0..out_len {
        synth[i] = padded[i + pad] / env_kept[i].max(MIN_ENVELOPE);
    }
    (synth, env_kept)
}

/// 窗口 RMS
fn window_rms(x: &[f32], center: usize, half: usize) -> f32 {
    let lo = center.saturating_sub(half);
    let hi = (center + half).min(x.len());
    if hi <= lo {
        return 0.0;
    }
    let sum: f32 = x[lo..hi].iter().map(|s| s * s).sum();
    (sum / (hi - lo) as f32).sqrt()
}

/// 局部增益匹配 —— 照搬 PitchNet applyLocalGainMatch。
///
/// 升调让每颗颗粒以更近的间距重复，而重复体是偏移副本而不是真正周期性的内容，
/// 所以远离脉冲的部分会部分抵消 —— 八度处约 3dB。窗和除法看不见这个损失，
/// 因为损失在内容里而不在权重里。下游还要与未改动的原声交叉淡化，所以两侧的
/// 局部响度必须一致。
///
/// `time` 必须传进来：源侧的采样中心要经时间映射回查。曾经直接用输出中心当源
/// 中心，τ≠1 时两边比的是**不同区段**的 RMS，于是 τ≠1 会算出一个 0.25~4 倍的
/// 假增益并按帧来回摆 —— 听上去就是抽吸/pumping。
pub(crate) fn apply_local_gain_match(out: &mut [f32], src: &[f32], time: f64, out_len: usize) {
    let hop = HOP;
    let num_frames = (out_len + hop - 1) / hop;
    if num_frames == 0 {
        return;
    }
    const MIN_RMS: f32 = 1e-6;
    const MIN_GAIN: f32 = 0.25;
    const MAX_GAIN: f32 = 4.0;
    const SMOOTH_RADIUS: usize = 2;

    let half_width = 2 * hop;
    let mut gain = vec![1.0f32; num_frames];
    for frame in 0..num_frames {
        let out_centre = frame * hop + hop / 2;
        // PitchNet: sourceCentre = round(sourceFrame[frame] * hop) - sourceStart + hop/2
        let src_centre = (((frame * hop + hop / 2) as f64) / time).round() as usize;
        let rms_out = window_rms(out, out_centre, half_width);
        let rms_src = window_rms(src, src_centre, half_width);
        if rms_out > MIN_RMS && rms_src > MIN_RMS {
            gain[frame] = (rms_src / rms_out).clamp(MIN_GAIN, MAX_GAIN);
        } else if rms_src <= MIN_RMS {
            gain[frame] = 0.0;
        }
    }

    let mut smoothed = vec![1.0f32; num_frames];
    for frame in 0..num_frames {
        let lo = frame.saturating_sub(SMOOTH_RADIUS);
        let hi = (frame + SMOOTH_RADIUS).min(num_frames - 1);
        let sum: f32 = gain[lo..=hi].iter().sum();
        smoothed[frame] = sum / (hi - lo + 1) as f32;
    }

    for (sample, s) in out.iter_mut().enumerate() {
        let pos = (sample as f32 - 0.5 * hop as f32) / hop as f32;
        let left = (pos.floor().max(0.0) as usize).min(num_frames - 1);
        let right = (left + 1).min(num_frames - 1);
        let t = (pos - left as f32).clamp(0.0, 1.0);
        *s *= smoothed[left] * (1.0 - t) + smoothed[right] * t;
    }
}

// ---------------------------------------------------------------------------
// 模块 D：时变 ratio 曲线合成（autotune / 离线自动修音入口）
// ---------------------------------------------------------------------------

/// 时变 ratio 曲线的 PSOLA 合成 —— 自动修音专用，时长恒 1:1。
///
/// 与 [`apply_planar`]（变调路径）走**同一个**颗粒编排内核：
/// [`render_track`] 的输出时间轴铺颗粒 + nearest-mark 吸附 + onset anchor，
/// 加上 Σw 归一与 [`apply_local_gain_match`] 的局部增益匹配。
/// 两条路径的差别只有「ratio 是常量闭包还是逐帧曲线」这一点。
///
/// 这里曾经是另一条独立实现（旧 `synth_curve`，逐 mark 手动铺点）：
/// 线性插值采样、无吸附、无锚定、不做增益匹配。后果是自动修音的音质与变调路径
/// 不是一回事 —— 短促素材在音头带咔哒（颗粒与源相位任意错开）、长音包络随周期
/// 起伏、拉伸/压缩语义与主路径不一致。现在共用内核后，修音与变调的听感同源。
///
/// ratio 闭包收到的是**颗粒读源的位置**：控制环曲线按 `psola::frame_index`
/// 索引源帧，所以调用方直接用源样本位置查表即可（time≡1，源位置 = 输出位置）。
pub(crate) fn synth_curve(
    x: &[f32],
    marks: &[Mark],
    frames: &[PitchFrame],
    sr: f32,
    ratio: &dyn Fn(f64) -> f64,
    out_len: usize,
) -> (Vec<f32>, Vec<f32>) {
    let sr = if sr > 0.0 { sr } else { 48000.0 };
    let (mut synth, env) = synth_channel(x, marks, frames, sr, ratio, 1.0, out_len);
    // 源侧采样中心按 time=1 直接回查，与变调路径同一套逻辑。
    apply_local_gain_match(&mut synth, x, 1.0, out_len);
    (synth, env)
}

// ---------------------------------------------------------------------------
// 模块 E：完整变换流程（planar 多通道入口）
// ---------------------------------------------------------------------------

/// 线性插值取源样本
fn lerp(x: &[f32], pos: f32) -> f32 {
    if pos <= 0.0 {
        return x.first().copied().unwrap_or(0.0);
    }
    let idx = pos.floor() as usize;
    let frac = pos - idx as f32;
    if idx >= x.len() {
        return 0.0;
    }
    if idx + 1 >= x.len() {
        return x[idx];
    }
    x[idx] * (1.0 - frac) + x[idx + 1] * frac
}

/// Blend mask —— 输出时间轴。
///
/// PitchNet `IncrementalSynthesizer::generateBlendMask` 的语义，但**修正了时基**：
/// 它原来在输出帧上直接索引源 voiced mask（对 PitchNet 那种以变调为主的编辑足够
/// 近似），我们要支持大倍率拉伸，所以按时间映射`输出帧中心 → 源样本 → 源帧`回查。
///
/// 规则：
///   - 默认合成（避免音符交界处出现内部「原声/合成」梳状）
///   - 只有**长**清音段（≥24 帧 ≈ 240ms，比如完整的呼吸或静音）才放行原声
///   - 短清音缺口继续合成，避免每个音符缝上切一刀
pub fn build_blend_mask(
    frames: &[PitchFrame],
    time: f64,
    out_len: usize,
) -> Vec<f32> {
    const KEEP_ORIGINAL_FRAMES: usize = 24;
    let hop = HOP;
    let n_src = frames.len();
    if out_len == 0 {
        return Vec::new();
    }

    // Step 1：源帧级 mask
    let mut src_mask = vec![1.0f32; n_src];
    let mut i = 0usize;
    while i < n_src {
        if frames[i].voiced {
            i += 1;
            continue;
        }
        let s = i;
        while i < n_src && !frames[i].voiced {
            i += 1;
        }
        if i - s >= KEEP_ORIGINAL_FRAMES {
            for k in s..i {
                src_mask[k] = 0.0;
            }
        }
    }

    // Step 2：映射到输出帧
    let n_out = (out_len + hop - 1) / hop;
    let mut frame_mask = vec![1.0f32; n_out];
    if n_src > 0 {
        for (of, m) in frame_mask.iter_mut().enumerate() {
            let out_centre = of as f64 * hop as f64 + hop as f64 * 0.5;
            let src_sample = src_pos_of(out_centre, time) as f32;
            let idx = frame_round(src_sample).min(n_src - 1);
            *m = src_mask[idx];
        }
    }

    // Step 3：展开到样本（sample-and-hold）
    let mask_len = n_out * hop;
    let mut mask = vec![0.0f32; mask_len];
    for (of, &m) in frame_mask.iter().enumerate() {
        let ss = of * hop;
        let se = (ss + hop).min(mask_len);
        for s in ss..se {
            mask[s] = m;
        }
    }

    // Step 4：帧边界处线性斜坡
    const MIN_RAMP: usize = 512;
    let ramp = (hop * 2).max(MIN_RAMP);
    for i in 0..n_out.saturating_sub(1) {
        if (frame_mask[i] - frame_mask[i + 1]).abs() < 1e-6 {
            continue;
        }
        let centre = (i + 1) * hop;
        let rs = centre.saturating_sub(ramp / 2);
        let re = (centre + ramp / 2).min(mask_len);
        if re <= rs {
            continue;
        }
        let from = frame_mask[i];
        let to = frame_mask[i + 1];
        for s in rs..re {
            let t = (s - rs) as f32 / (re - rs) as f32;
            mask[s] = from + (to - from) * t;
        }
    }

    mask.truncate(out_len);
    mask
}

/// Planar 多通道变调 + 时长变换 —— `hajimi_tx_run` mode=1 的唯一调用点。
///
/// 通道 0 做 pitch track 与 marks，所有通道共享同一套（立体声声像保持）。
// ---------------------------------------------------------------------------
// 模块 E：谐波/噪声分离（`hajimi_tx_run` mode 3）
// ---------------------------------------------------------------------------
//
// 为什么需要它 —— 这是「降调越深越沙」的机制，逐条都是实测出来的：
//
// 颗粒间距 = period/ratio，而窗半宽恒 = period，于是输出重合率 = 1 - 1/(2·ratio)：
// ratio 1.0 → 50%，0.75 → 33%，0.62 → **19%**，0.50 → **0%**。
//
// 重合区里相邻两颗颗粒读的是**源里相隔 (1-ratio)·period 的材料**。源严格周期时
// 两者逐样本相同、叠加完全相干（实测：把严格周期成分喂进同一套颗粒内核，
// HNR 14.0dB / 周期性 0.991，比源本身还干净）；源里的**非周期成分**（气声、
// 录制噪声、抖动）则互不相干地叠加，再被 Σw 除法放大 —— 接缝处 Σw 只有 0.19，
// 也就是噪声被抬了约 5 倍（+14dB），而这个放大量随 ratio 下降单调增长。
//
// 于是「降调越深、沙沙越重」不是巧合，是几何。
//
// 另一条同源的机制：降调时源推进量 advance/period = 1/ratio 不是整数
// （ratio 0.62 → 1.61），吸附到整数 mark 后相邻颗粒的源推进量在 1 与 2 个周期
// 之间摆动 → 交汇处的相位关系逐颗变化 → 变成宽带噪声。1/ratio 恰为整数
// （ratio 0.5，即 -12 半音）时这一项消失，这也是 -12 在闸门修好之后干净的原因。
//
// 拆分的收益（真素材，`scripts/_probe-hnsep.mjs`）：
//   龙.001 @ -8.23 半音：现有 PSOLA HNR 9.07dB，拆分后 10.79dB（源 10.72）→ +1.72dB
//   真·PitchNet 导出（PC-NSF-HiFiGAN）的 HF 分档比源低 2~3dB —— β≈0.5 落在同一区间。
//
// 拆分的代价：抽掉非周期成分会让气声变少，抽得太干会发闷，所以 β 有 0.35 的地板。

/// 分析栅格 = 4 个 HOP（40ms @48k）。
///
/// 谐波包络随时间变化很慢，不需要 10ms 那么密；粗一档直接把
/// O(分析点数 × 谐波数 × 窗长) 降 4 倍。锚在 `WIN/2` 上，于是第 m 个分析点
/// 正好落在 pitch 帧 4m 的中心 —— 复用已有的 F0 轨迹，不另建一套检测。
const HN_HOP: usize = HOP * 4;

/// 谐波分析上限（Hz）。再高的谐波能量极低，留在残余里也听不出来。
const HN_FREQ_HI: f32 = 12000.0;

/// 谐波数上限（成本闸门）。
const HN_KMAX: usize = 96;

/// 分析窗长 = 该数量个**源**周期。4 个周期让相邻谐波落在主瓣外（分辨率 = f0/4）。
const HN_WIN_PERIODS: f32 = 4.0;

/// 分析窗长上下限（样本）。上限同时是成本闸门：低音素材的 4 个周期可能上千样本。
const HN_WIN_MIN: usize = 32;
const HN_WIN_MAX: usize = 2048;

/// 单周期波形表的分辨率。
///
/// 合成侧的成本全在这里被摊平：一个分析点内谐波系数近似恒定，于是重建出来的
/// 谐波和就是**相位 φ 的周期函数**（周期 1），可以预先采样成一张表。
/// 每样本只剩一次查表 + 一次线性插值 —— 比「每样本 × 每谐波」跑 Chebyshev 递推
/// 便宜一个数量级，而且连三角函数都不用调（φ 直接就是表索引）。
///
/// 512 点对 12kHz 上限足够（一次谐波最多 96，远低于表的奈奎斯特 256）。
const HN_TABLE: usize = 512;

/// 单个分析点的谐波模型：`Σ_k [a_k·cos(2πkφ) + b_k·sin(2πkφ)]` 采样成
/// 一个周期的波形表（长度 [`HN_TABLE`]）。类型别名只为让签名读起来清楚。
type HarmTable = Vec<f32>;

/// 按相位（单位：周期）查表，循环线性插值。
#[inline]
fn table_at(t: &[f32], phi: f64) -> f32 {
    let n = t.len();
    let p = phi - phi.floor(); // [0,1)
    let x = p * n as f64;
    let i0 = (x as usize).min(n - 1);
    let i1 = if i0 + 1 == n { 0 } else { i0 + 1 };
    (x - i0 as f64) as f32 * (t[i1] - t[i0]) + t[i0]
}

/// 拆分启用线（≈ -2 半音）。
///
/// **这条线及以上完全不动** —— 升调、unity、以及轻微降调走的还是 mode 1 那条路，
/// 逐样本不变。理由有两条：
/// ① 用户实测升调侧（+5/+7/+12）比 PitchNet 干净，不能碰；
/// ② 轻微降调实测本来就比源干净（慢米 -1.8 半音：源 9.27dB → 我们 10.35dB）。
///
/// **类型必须是 f32，且比较也必须留在 f32**（踩过一次，见
/// `noise_retention_only_kicks_in_on_downshift` 与 `_probe-hnsep.mjs` 的【契约】段）：
/// `hajimi_tx_run` 的 pitch 参数是 f32，而 `0.89f32 = 0.88999998569…` 比 `0.89f64` **小一个 ULP**。
/// 常量若写成 f64，传 0.89 的那一档就会满足 `pitch < 线` → 分离比「启用线」**提前一个 ULP 打开**，
/// 于是「启用线及以上逐样本相同」这条契约在恰好 0.89 上失效（实测差异 0.61×源RMS）。
/// host 单测用 f64 字面量比较，**测不出这个坑** —— 只有走 wasm ABI 的探针能看见。
/// 留在 f32 后，「线」正好落在 API 能表达的那个值上。
const HN_ENABLE_MAX_RATIO: f32 = 0.89;

/// β 的地板。抽到 0 会把气声一起抽干、听感发闷。
const HN_BETA_MIN: f64 = 0.35;

/// 非周期残余的保留量 β —— 通道级的「净化量」。
///
/// 抽干（β→0）最干净，但气声也一起没了，听感发闷；全留（β=1）等于不拆分。
/// 按变调比自适应，因为要压掉的那个放大量本来就是 ratio 的函数：
///
/// | ratio | 半音 | β | 说明 |
/// |---|---|---|---|
/// | ≥0.89 | ≥-2 | 1.00 | **不启用拆分**，与 mode 1 逐样本相同 |
/// | 0.75 | -5.0 | 0.74 | 交叠还有 33%，轻压 |
/// | 0.62 | -8.2 | **0.50** | 交叠 19%（用户实测出问题的那一档） |
/// | 0.50 | -12.0 | 0.35 | 交叠归零，压到地板 |
///
/// 标定依据（`scripts/_probe-hnsep.mjs`，龙.001 @0.6216，HF 分档相对源 dB）：
/// β=1.0 → -0.2/-0.2/-1.3/-1.4，β=0.5 → -0.3/-0.5/-1.8/-2.8；
/// 真·PitchNet 导出（PC-NSF-HiFiGAN）落在 -2.0/-3.3/-2.8，所以 β(0.62)=0.5。
fn noise_retention(ratio: f32) -> f32 {
    // 与调用点同精度比较（见 HN_ENABLE_MAX_RATIO 的说明）。
    if !(ratio > 0.0) || ratio >= HN_ENABLE_MAX_RATIO {
        return 1.0;
    }
    let r = ratio as f64;
    let line = HN_ENABLE_MAX_RATIO as f64;
    // 过 (0.89, 1.00) 与 (0.62, 0.50) 两点，再落到地板。
    let b = 1.0 - (1.0 - 0.50) / (line - 0.62) * (line - r);
    b.clamp(HN_BETA_MIN, 1.0) as f32
}

/// 调用点的启用判据 —— 单独抽出来是为了能测「ABI 精度下的边界」
/// （见 `enable_line_is_exact_in_f32_abi_precision`）。
#[inline]
fn hn_split_enabled(pitch: f32) -> bool {
    pitch < HN_ENABLE_MAX_RATIO
}

/// 把一个分析点的 4 个周期 Hann 窗内、对 k·f0 做正交相关，返回单周期波形表。
///
/// 相位定义与 [`split_harmonic`] 的累计一致（单位：周期）：
/// `φ(i) = phi0 + (i - c) / p`。
///
/// 分析侧用 Chebyshev 递推（`cos(kθ)`/`sin(kθ)` 由前一对推出来）而不是对每个 (k,i)
/// 调 trig：每样本只算一次 `θ` 的 cos/sin，之后每谐波 6 次乘法。合成侧靠
/// [`HN_TABLE`] 把这一步整体摊掉。
fn analyse_at(x: &[f32], c: usize, p: f32, phi0: f64, sr: f32) -> Option<HarmTable> {
    let w = ((HN_WIN_PERIODS * p).round() as usize).clamp(HN_WIN_MIN, HN_WIN_MAX);
    let half = w / 2;
    let lo = c.saturating_sub(half);
    let hi = (c + half).min(x.len());
    if hi <= lo + 8 {
        return None;
    }
    let f0 = sr / p;
    // 谐波数 = 频率上限，再被「每分析点 k·w 工作量」的预算压一道，
    // 最后不越过表本身的奈奎斯特（HN_TABLE/2）。
    let k_work = (120_000 / w).max(8);
    let k = ((HN_FREQ_HI / f0).floor() as usize)
        .min(HN_KMAX)
        .min(k_work)
        .min(HN_TABLE / 2 - 1)
        .max(1);

    let mut acc_a = vec![0.0f64; k + 1];
    let mut acc_b = vec![0.0f64; k + 1];
    let dw = 2.0 * PI64 / w as f64;
    let dbase = 2.0 * PI64 / p as f64;
    let base = phi0 * 2.0 * PI64;
    let mut wsum = 0.0f64;

    for i in lo..hi {
        let win = 0.5 - 0.5 * ((i - lo) as f64 * dw).cos();
        wsum += win;
        let xv = x[i] as f64 * win;
        let th = base + (i as f64 - c as f64) * dbase;
        let (c1, s1) = (th.cos(), th.sin());
        let (mut ck, mut sk) = (1.0f64, 0.0f64);
        for kk in 1..=k {
            let cn = ck * c1 - sk * s1;
            let sn = sk * c1 + ck * s1;
            ck = cn;
            sk = sn;
            acc_a[kk] += xv * ck;
            acc_b[kk] += xv * sk;
        }
    }
    if wsum < 1e-9 {
        return None;
    }
    let g = 2.0 / wsum;

    // 把谐波模型预采样成一个周期的波形表（φ = j/HN_TABLE）。
    // 合成侧于是只剩「一次查表 + 一次线性插值」，既省掉每样本 × 每谐波的递推，
    // 也省掉三角函数 —— φ 本身就是表索引。
    let mut table = vec![0.0f32; HN_TABLE];
    for j in 0..HN_TABLE {
        let th = 2.0 * PI64 * j as f64 / HN_TABLE as f64;
        let (c1, s1) = (th.cos(), th.sin());
        let (mut ck, mut sk) = (1.0f64, 0.0f64);
        let mut v = 0.0f64;
        for kk in 1..=k {
            let cn = ck * c1 - sk * s1;
            let sn = sk * c1 + ck * s1;
            ck = cn;
            sk = sn;
            v += acc_a[kk] * g * ck + acc_b[kk] * g * sk;
        }
        table[j] = v as f32;
    }
    Some(table)
}

/// 把单声道信号拆成 `(谐波成分, 非周期残余)`，两者相加逐样本还原原信号。
///
/// 方法是**按谐波频率做窗内正交相关**，而不是「±K 个周期的同步平均」。
/// 后者对 f0 误差极敏感：13 抽头均匀平均的频率响应是 Dirichlet 核，f0 差 1% 时
/// 第 10 次谐波只剩 3.6% —— 漏出来的谐波混进残余、又**不跟着变调**，
/// 回加后与主路打架。实测那一版比不做拆分还差 1.33dB（9.07 → 7.74）。
///
/// 相位用**逐样本周期积分**（τ 从各分析点起累计），而不是「帧中心 + 局部相位」：
/// 前者在 f0 漂移下全局一致，后者会让相邻分析点的谐波对不齐。
///
/// 未判为 voiced 的分析点返回 `None`，那里 `harm = x`、`noise = 0`（原样透传）；
/// 过渡处按 `tot` 线性混合，所以辅音和呼吸不受影响。
fn split_harmonic(x: &[f32], frames: &[PitchFrame], sr: f32) -> (Vec<f32>, Vec<f32>) {
    let n = x.len();
    if n == 0 || frames.is_empty() {
        return (x.to_vec(), vec![0.0f32; n]);
    }
    let c0 = WIN / 2;
    let m_count = if n > c0 { (n - c0) / HN_HOP + 2 } else { 1 };

    let mut coeff: Vec<Option<HarmTable>> = Vec::with_capacity(m_count);
    let mut invp: Vec<f32> = Vec::with_capacity(m_count); // 1/周期，样本
    let mut phi: Vec<f64> = Vec::with_capacity(m_count); // 该分析点处的累积相位（周期数）
    let mut last_inv = 0.0f32;
    let mut acc = 0.0f64;

    for m in 0..m_count {
        let c = c0 + m * HN_HOP;
        let cs = (c.min(n - 1)) as f32;
        let p = if voiced_at_sample(cs, frames) {
            period_at_sample(cs, frames, sr)
        } else {
            0.0
        };
        let inv = if p > 1.0 { 1.0 / p } else { 0.0 };
        // 相位用梯形法累计 ∫1/P —— 与合成侧同一套插值，保证两侧相位完全一致。
        let prev = if m == 0 { last_inv } else { invp[m - 1] };
        let pv = if prev > 0.0 { prev } else { last_inv };
        let cv = if inv > 0.0 { inv } else { last_inv };
        if m == 0 {
            phi.push(0.0);
        } else {
            acc += HN_HOP as f64 * 0.5 * (pv + cv) as f64;
            phi.push(acc);
        }
        invp.push(cv);
        if inv > 0.0 {
            last_inv = inv;
        }
        coeff.push(if p > 1.0 {
            analyse_at(x, c, p, phi[m], sr)
        } else {
            None
        });
    }

    let mut harm = x.to_vec();
    let mut noise = vec![0.0f32; n];
    for i in 0..n {
        let rel = i as isize - c0 as isize;
        let (m, u) = if rel <= 0 {
            (0usize, 0.0f32)
        } else {
            let q = rel as usize;
            (
                (q / HN_HOP).min(m_count - 1),
                (q % HN_HOP) as f32 / HN_HOP as f32,
            )
        };
        let m2 = (m + 1).min(m_count - 1);
        let uu = if m == m2 { 0.0 } else { u };
        let ta = coeff[m].as_ref();
        let tb = coeff[m2].as_ref();
        let w_a = if ta.is_some() { 1.0 - uu } else { 0.0 };
        let w_b = if tb.is_some() { uu } else { 0.0 };
        let tot = w_a + w_b;
        if tot <= 0.0 {
            continue; // harm 已是原样、noise 保持 0
        }
        // 相位（单位：周期）——与分析侧同一个积分
        let iv0 = invp[m] as f64;
        let iv1 = invp[m2] as f64;
        let ivi = iv0 + uu as f64 * (iv1 - iv0);
        let ph = phi[m] + (i as f64 - (c0 + m * HN_HOP) as f64) * 0.5 * (iv0 + ivi);
        // 两张表都按**同一个全局相位**取值，所以混合就是两次查表的线性插值；
        // 不足 1 的权重（某一侧非 voiced）由原信号补齐。
        let v = match (ta, tb) {
            (Some(a), Some(b)) => w_a * table_at(a, ph) + w_b * table_at(b, ph),
            (Some(a), None) => w_a * table_at(a, ph),
            (None, Some(b)) => w_b * table_at(b, ph),
            (None, None) => continue,
        };
        harm[i] = v + (1.0 - tot) * x[i];
        noise[i] = x[i] - harm[i];
    }
    (harm, noise)
}

pub fn apply_planar(planar: &[&[f32]], sr: f32, pitch: f32, time: f32) -> Vec<Vec<f32>> {
    apply_planar_inner(planar, sr, pitch, time, false)
}

/// 谐波/噪声分离版变调 —— 见 [`split_harmonic`] 与 [`noise_retention`]。
///
/// 只在**降调**时与 [`apply_planar`] 有区别；升调与 unity 走的是同一条路。
pub fn apply_planar_harmonic(planar: &[&[f32]], sr: f32, pitch: f32, time: f32) -> Vec<Vec<f32>> {
    apply_planar_inner(planar, sr, pitch, time, true)
}

fn apply_planar_inner(
    planar: &[&[f32]],
    sr: f32,
    pitch: f32,
    time: f32,
    split: bool,
) -> Vec<Vec<f32>> {
    if planar.is_empty() {
        return Vec::new();
    }
    // 比例恒等时逐样本拷贝（保证 bit-exact，不引入 OLA 染色）
    if (pitch - 1.0).abs() < 1e-6 && (time - 1.0).abs() < 1e-6 {
        return planar.iter().map(|s| s.to_vec()).collect();
    }
    let sr = if sr > 0.0 { sr } else { 48000.0 };
    let total = planar[0].len();
    if total == 0 {
        return planar.iter().map(|s| s.to_vec()).collect();
    }
    let timef = time as f64;
    let out_len = ((total as f64) * timef).round().max(1.0) as usize;

    // 通道 0 做逐帧 F0 轨迹；marks 覆盖全曲 voiced run
    let frames = track_pitch(planar[0], sr);
    let marks = detect_marks(planar[0], &frames, sr);
    // 记录「这段素材到底有没有周期可同步」——调用方据此判断本次变调是不是静默空转。
    LAST_VOICED.with(|c| {
        c.set((frames.iter().filter(|f| f.voiced).count(), marks.len()));
    });
    let mask = build_blend_mask(&frames, timef, out_len);
    // 变调路径：ratio 是常量 —— 同一个内核，只是曲线退化成一条水平线。
    let ratio = |_: f64| pitch as f64;
    // 启用线以上完全不动：升调 / unity / 轻微降调与 mode 1 逐样本相同。
    // 比较留在 f32 —— 见 HN_ENABLE_MAX_RATIO 的说明（f64 常量会让线偏一个 ULP）。
    let split = split && hn_split_enabled(pitch);
    let beta = if split { noise_retention(pitch) } else { 1.0 };

    planar
        .iter()
        .map(|src| {
            // 拆分只影响「喂给颗粒内核的是什么、残余怎么加回来」，
            // 后续的 Σw 归一 / 增益匹配 / blend 全部原样复用。
            let folded = if split {
                Some(split_harmonic(src, &frames, sr))
            } else {
                None
            };
            let reference: &[f32] = match &folded {
                Some((h, _)) => h,
                None => src,
            };
            let residual: &[f32] = match &folded {
                Some((_, r)) => r,
                None => &[],
            };

            let (mut synth, _env) =
                synth_channel(reference, &marks, &frames, sr, &ratio, timef, out_len);

            // 局部增益匹配：源侧位置按时间映射回查。
            // 拆分开启时参照物必须是**谐波成分**（残余还没加回来），否则会把
            // 「噪声被抽掉多少」误当成电平损失而整体补回来，净化量被抵消掉。
            apply_local_gain_match(&mut synth, reference, timef, out_len);

            if split {
                if (timef - 1.0).abs() < 1e-6 {
                    for i in 0..out_len.min(residual.len()) {
                        synth[i] += beta * residual[i];
                    }
                } else {
                    for i in 0..out_len {
                        synth[i] += beta * lerp(residual, src_pos_of(i as f64, timef) as f32);
                    }
                }
            }

            // blend：mask=1 → 合成，mask=0 → 原声（按时间映射读 i/time）
            (0..out_len)
                .map(|i| {
                    let m = mask.get(i).copied().unwrap_or(0.0);
                    if m >= 1.0 - 1e-6 {
                        return synth[i];
                    }
                    let orig = lerp(src, src_pos_of(i as f64, timef) as f32);
                    if m <= 1e-6 {
                        return orig;
                    }
                    synth[i] * m + orig * (1.0 - m)
                })
                .collect()
        })
        .collect()
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    fn make_sine(freq: f32, sr: f32, n: usize) -> Vec<f32> {
        (0..n).map(|i| (2.0 * PI * freq * i as f32 / sr).sin()).collect()
    }

    /// 类元音：谐波堆 + 共振峰包络（PSOLA 的行为对纯正弦与对谐波堆并不一样）。
    fn make_vowel(f0: f32, sr: f32, n: usize) -> Vec<f32> {
        let mut x = vec![0.0f32; n];
        let formants = [(500.0f32, 260.0f32, 1.0f32), (1500.0, 420.0, 0.55), (2600.0, 600.0, 0.22)];
        let mut k = 1;
        while k as f32 * f0 < sr * 0.45 {
            let f = k as f32 * f0;
            let mut a = 0.02f32;
            for &(fc, bw, g) in &formants {
                let d = (f - fc) / bw;
                a += g * (-(d * d)).exp();
            }
            a *= 1.0 / (1.0 + (f / 4000.0).powf(1.6));
            let ph = (k as f32 * 2.399963) % (2.0 * PI);
            for (i, s) in x.iter_mut().enumerate() {
                *s += a * (2.0 * PI * f * i as f32 / sr + ph).sin();
            }
            k += 1;
        }
        let peak = x.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        if peak > 0.0 {
            for s in x.iter_mut() {
                *s *= 0.7 / peak;
            }
        }
        x
    }

    /// YIN 测基频（与 wasm 内同一算法），用于验收音高精度。
    fn detect_f0(x: &[f32], sr: f32) -> f32 {
        use crate::yin_core;
        let min_tau = (sr / 1000.0).ceil().max(2.0) as usize;
        let max_tau = (sr / 60.0).ceil() as usize;
        if x.len() < max_tau + 256 {
            return 0.0;
        }
        let win = x.len() - max_tau;
        match yin_core::yin_frame(x, 0, win, min_tau, max_tau, 0.15, sr) {
            Some(r) => r.freq,
            None => 0.0,
        }
    }

    /// 周期对齐 RMS 的变异系数 —— 「颤/放屁」的直接度量。
    fn cycle_cv(x: &[f32], sr: f32, f0: f32) -> f32 {
        if !(f0 > 0.0) {
            return 0.0;
        }
        let period = (sr / f0).round() as usize;
        if period < 4 {
            return 0.0;
        }
        let mut vals = Vec::new();
        let mut s = 0;
        while s + period <= x.len() {
            let e: f32 = x[s..s + period].iter().map(|v| v * v).sum();
            vals.push((e / period as f32).sqrt());
            s += period;
        }
        if vals.len() < 4 {
            return 0.0;
        }
        let mean = vals.iter().sum::<f32>() / vals.len() as f32;
        if mean <= 1e-9 {
            return 0.0;
        }
        let var = vals.iter().map(|v| (v - mean) * (v - mean)).sum::<f32>() / vals.len() as f32;
        var.sqrt() / mean
    }

    const CENTS: f32 = 1200.0;

    #[test]
    fn yin_frame_tracks_sine() {
        let sr = 48000.0;
        let x = make_sine(440.0, sr, 4096);
        let (f0, conf) = yin_frame(&x, 2048, sr);
        assert!((f0 - 440.0).abs() < 1.0, "F0 should be ~440Hz, got {}", f0);
        assert!(conf > 0.5, "Confidence should be high, got {}", conf);
    }

    #[test]
    fn track_pitch_follows_sine() {
        let sr = 48000.0;
        let x = make_sine(440.0, sr, 48000);
        let frames = track_pitch(&x, sr);
        assert!(!frames.is_empty());
        let voiced: Vec<&PitchFrame> = frames.iter().filter(|f| f.voiced).collect();
        assert!(voiced.len() > frames.len() / 2);
        for f in &voiced {
            assert!((f.f0 - 440.0).abs() < 5.0, "got {}", f.f0);
        }
    }

    // ---- 帧栅格约定 ----

    #[test]
    fn frame_grid_is_round_trip() {
        for i in [0usize, 1, 7, 100, 511] {
            let c = frame_centre(i as f32);
            assert!(
                (frame_index(c) - i as f32).abs() < 1e-3,
                "frame {} centre {} -> index {}",
                i,
                c,
                frame_index(c)
            );
        }
        assert_eq!(frame_centre(0.0), WIN as f32 / 2.0);
    }

    // ---- 变调：音高精度 + 无颤 ----

    #[test]
    fn pitch_shift_hits_target_hz() {
        let sr = 48000.0;
        let f0 = 200.0f32;
        let x = make_vowel(f0, sr, 96000);
        for semis in [5.0f32, 7.0, 12.0, -5.0, -12.0] {
            let pitch = 2.0f32.powf(semis / 12.0);
            let out = apply_planar(&[&x], sr, pitch, 1.0);
            let expect = f0 * pitch;
            let lo = out[0].len() / 4;
            let hi = out[0].len() * 3 / 4;
            let got = detect_f0(&out[0][lo..hi], sr);
            let err_cents = CENTS * (got / expect).log2().abs();
            assert!(
                err_cents < 15.0,
                "{} 半音：期望 {:.1}Hz 得 {:.1}Hz（{:.1} 音分）",
                semis,
                expect,
                got,
                err_cents
            );
        }
    }

    /// Σw 归一的 floor 必须是**除数下限**，不能是闸门。
    ///
    /// 闸门版本（`if w > 0.3 { padded / w } else { 0 }`）在 ratio < 2/3
    /// （-7.02 半音）起，每个颗粒接缝都把一段样点**硬置零**：接缝处
    /// Σw = 2·Hann(A/2)，A/grain_half = 1/ratio，A = 1.5·grain_half 时
    /// Σw = 0.293 刚好跌破 0.3。输出于是变成一串被切断的脉冲，
    /// 听感是嗡嗡的撕裂（单素材实测新增咔哒簇最多 +753）。
    ///
    /// 判据用「连续精确 0 的样点数」而不是电平或 F0：源是严格周期元音、
    /// 全段有声，闸门版本会留下约半个周期的连续 0；除数下限版本在接缝处
    /// 只留下孤立的单点 0（Σw 恰好触零），两者差一个数量级。
    #[test]
    fn envelope_floor_is_a_divisor_not_a_gate() {
        let sr = 48000.0;
        let f0 = 200.0f32;
        let x = make_vowel(f0, sr, 96000);

        /// 输出中段最长的「连续精确 0」长度。
        fn longest_zero_run(x: &[f32]) -> usize {
            let mid = &x[x.len() / 4..x.len() * 3 / 4];
            let mut best = 0usize;
            let mut run = 0usize;
            for v in mid {
                if *v == 0.0 {
                    run += 1;
                    best = best.max(run);
                } else {
                    run = 0;
                }
            }
            best
        }

        for semis in [-5.0f32, -7.0, -9.0, -12.0] {
            let pitch = 2.0f32.powf(semis / 12.0);
            let out = apply_planar(&[&x], sr, pitch, 1.0);
            let run = longest_zero_run(&out[0]);
            assert!(
                run < 8,
                "{} 半音：输出中段有 {} 个连续精确 0 —— Σw floor 又被当成闸门了",
                semis,
                run
            );
        }
    }

    /// 降八度是 Σw² 归一化最坏的角落（颗粒首尾相贴、重叠为 0）：
    /// 那时包络在每条缝上触零、局部增益匹配再放大最多 4 倍，
    /// 输出变成 f0 速率的「噗噗噗」。Σw 归一化后周期 RMS 必须基本持平。
    #[test]
    fn down_octave_has_no_pitch_rate_warble() {
        let sr = 48000.0;
        let f0 = 200.0f32;
        let x = make_vowel(f0, sr, 96000);
        let src_cv = cycle_cv(&x, sr, f0);
        for semis in [-12.0f32, -5.0] {
            let pitch = 2.0f32.powf(semis / 12.0);
            let out = apply_planar(&[&x], sr, pitch, 1.0);
            let mid = &out[0][out[0].len() / 4..out[0].len() * 3 / 4];
            let cv = cycle_cv(mid, sr, f0 * pitch);
            assert!(
                cv < src_cv + 0.05,
                "{} 半音：周期 RMS 起伏 {:.4} 明显高于源的 {:.4}",
                semis,
                cv,
                src_cv
            );
        }
    }

    // ---- 拉伸：时长精度 + 全段音高一致 ----

    #[test]
    fn stretch_keeps_pitch_across_whole_output() {
        let sr = 48000.0;
        let f0 = 200.0f32;
        let x = make_vowel(f0, sr, 96000);
        for time in [1.5f32, 2.0, 0.75] {
            let out = apply_planar(&[&x], sr, 1.0, time);
            let expect = (x.len() as f32 * time).round() as usize;
            assert!(
                (out[0].len() as i32 - expect as i32).abs() <= 2,
                "time={}：输出 {} 帧，期望 {}",
                time,
                out[0].len(),
                expect
            );
            // 四段都必须保持源音高 —— 曾经只有前段对，后段是原声慢放。
            let seg = out[0].len() / 4;
            for q in 0..4 {
                let s = q * seg + seg / 8;
                let e = s + seg * 3 / 4;
                let got = detect_f0(&out[0][s..e], sr);
                let err_cents = CENTS * (got / f0).log2().abs();
                assert!(
                    err_cents < 40.0,
                    "time={} 第 {} 段：期望 {:.1}Hz 得 {:.1}Hz（{:.1} 音分）",
                    time,
                    q + 1,
                    f0,
                    got,
                    err_cents
                );
            }
        }
    }

    #[test]
    fn pitch_and_time_combined() {
        let sr = 48000.0;
        let f0 = 200.0f32;
        let x = make_vowel(f0, sr, 72000);
        let pitch = 2.0f32.powf(5.0 / 12.0);
        let out = apply_planar(&[&x], sr, pitch, 1.5);
        let expect = f0 * pitch;
        let seg = out[0].len() / 4;
        for q in 0..4 {
            let s = q * seg + seg / 8;
            let e = s + seg * 3 / 4;
            let got = detect_f0(&out[0][s..e], sr);
            let err_cents = CENTS * (got / expect).log2().abs();
            assert!(
                err_cents < 40.0,
                "第 {} 段：期望 {:.1}Hz 得 {:.1}Hz（{:.1} 音分）",
                q + 1,
                expect,
                got,
                err_cents
            );
        }
    }

    #[test]
    fn stretch_uses_synthesis_not_passthrough_in_tail() {
        // 曾经 τ>1 时 blend mask 只覆盖输出前半段，后半段恒 0 → 原声线性插值慢放。
        // 这里用「升调 + 拉伸」把两条路径的音高拉开：合成段是 f0*pitch，
        // 直通段是 f0/time。探最后一秒，必须落在合成那一侧。
        let sr = 48000.0;
        let f0 = 200.0f32;
        let x = make_vowel(f0, sr, 72000);
        let pitch = 2.0f32.powf(7.0 / 12.0);
        let time = 2.0f32;
        let out = apply_planar(&[&x], sr, pitch, time);
        let n = out[0].len();
        let got = detect_f0(&out[0][n - sr as usize..], sr);
        let synth_target = f0 * pitch;
        let passthrough_target = f0 / time;
        let d_synth = (CENTS * (got / synth_target).log2()).abs();
        let d_pass = (CENTS * (got / passthrough_target).log2()).abs();
        assert!(
            d_synth < d_pass,
            "尾段音高 {:.1}Hz 更接近直通目标 {:.1}Hz（{:.0} 音分）而不是合成目标 {:.1}Hz（{:.0} 音分）",
            got,
            passthrough_target,
            d_pass,
            synth_target,
            d_synth
        );
    }

    // ---- 起音：不许有咔哒 ----

    #[test]
    fn onsets_do_not_produce_clicks() {
        let sr = 48000.0;
        let f0 = 220.0f32;
        let note_len = (sr * 0.2) as usize;
        let gap_len = (sr * 0.12) as usize;
        let notes = 12usize;
        let mut x = vec![0.0f32; notes * (note_len + gap_len)];
        for k in 0..notes {
            let off = k * (note_len + gap_len);
            let seg = make_vowel(f0, sr, note_len);
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
        for (name, pitch, time) in [
            ("升 5 半音", 2.0f32.powf(5.0 / 12.0), 1.0f32),
            ("降 5 半音", 2.0f32.powf(-5.0 / 12.0), 1.0),
            ("拉伸 1.5x", 1.0, 1.5),
        ] {
            let out = apply_planar(&[&x], sr, pitch, time);
            let j = jump(&out[0]);
            // 起音处样点跳变不应显著超过源本身（源自带 4ms 起音斜坡）。
            assert!(
                j < src_jump * 2.5,
                "{}：跳变峰 {:.2} vs 源 {:.2} —— 起音处有咔哒",
                name,
                j,
                src_jump
            );
        }
    }

    // ---- 不变量 ----

    #[test]
    fn unity_ratio_is_bit_exact() {
        let sr = 48000.0;
        for freq in [300.0f32, 440.0] {
            let x = make_sine(freq, sr, 24000);
            let out = apply_planar(&[&x], sr, 1.0, 1.0);
            assert_eq!(out[0].len(), x.len());
            for i in 0..x.len() {
                assert!(
                    (out[0][i] - x[i]).abs() < 1e-9,
                    "sample {} differs: {} vs {}",
                    i,
                    out[0][i],
                    x[i]
                );
            }
        }
    }

    #[test]
    fn output_length_matches_time_factor() {
        let sr = 48000.0;
        let x = make_vowel(200.0, sr, 24000);
        for time in [0.5f32, 0.9, 1.0, 1.3, 2.5] {
            let out = apply_planar(&[&x], sr, 1.3, time);
            let expect = (x.len() as f64 * time as f64).round() as usize;
            assert_eq!(out[0].len(), expect, "time={}", time);
        }
    }

    #[test]
    fn extreme_ratios_stay_finite_and_sane() {
        let sr = 48000.0;
        let x = make_vowel(200.0, sr, 48000);
        let rms_in = (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt();
        for pitch in [0.25f32, 0.5, 0.8, 1.25, 2.0, 4.0] {
            for time in [0.25f32, 0.5, 1.0, 2.0, 4.0] {
                let out = apply_planar(&[&x], sr, pitch, time);
                assert!(
                    out[0].iter().all(|v| v.is_finite()),
                    "pitch={} time={} 出现 NaN/Inf",
                    pitch,
                    time
                );
                let rms = (out[0].iter().map(|v| v * v).sum::<f32>() / out[0].len() as f32).sqrt();
                assert!(
                    rms < rms_in * 4.0 && rms > rms_in * 0.1,
                    "pitch={} time={} rms={} (源 {})",
                    pitch,
                    time,
                    rms,
                    rms_in
                );
            }
        }
    }

    #[test]
    fn stereo_channels_share_marks_and_stay_aligned() {
        let sr = 48000.0;
        let a = make_vowel(200.0, sr, 48000);
        let b: Vec<f32> = a.iter().map(|v| v * 0.6).collect();
        let out = apply_planar(&[&a, &b], sr, 2.0f32.powf(4.0 / 12.0), 1.4);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].len(), out[1].len());
        for i in 0..out[0].len() {
            assert!((out[0][i] - out[1][i] / 0.6).abs() < 1e-3);
        }
    }

    /// 变调比趋近 2.0 时的相干抵消 —— 模块头「已知极限」那节的**金丝雀**。
    ///
    /// 不是在认可这个行为，而是把**纯正弦这一支**钉在可观测处：r ≤ 1.6 电平无损，
    /// r = 2.0 塌到近静音（实测 1e-4）。
    ///
    /// 为什么必须显式钉住：这条性质对信号的严格周期性极其敏感 —— 同一个内核下，
    /// `make_sine` 在 +12 半音掉到 1e-4，而 `make_vowel`（逐谐波用 f32 算相位，
    /// 高次谐波的相位参数早已越过 f32 精度）反而保持 1.0001，差四个数量级。
    /// 也就是说**其它测试里的合成元音给不出真实的人声结论**，它们的电平断言
    /// 只是数值巧合。这里用单频正弦（f·i 最大 1.9e7，f32 足够精确），是唯一
    /// 能稳定复现的、可断言的一支。
    ///
    /// 将来若有人改动颗粒几何（或换成重采样式变调 / 相位对齐 PSOLA）修好这个抵消，
    /// 这条会红 —— 那时请一并更新模块头的表，而不是把阈值放宽。
    #[test]
    fn near_octave_up_phase_cancellation_is_pinned() {
        let sr = 48000.0;
        let f0 = 200.0f32;
        let x = make_sine(f0, sr, 96000);
        let rms_in = (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt();
        let level = |pitch: f32| -> f32 {
            let out = apply_planar(&[&x], sr, pitch, 1.0);
            let mid = &out[0][out[0].len() / 4..out[0].len() * 3 / 4];
            (mid.iter().map(|v| v * v).sum::<f32>() / mid.len() as f32).sqrt() / rms_in
        };
        let safe = level(2.0f32.powf(8.0 / 12.0)); // +8 半音 → r = 1.587
        assert!(
            (0.9..1.15).contains(&safe),
            "+8 半音电平 {:.3} 不在 1.0 附近 —— 安全区已经退化",
            safe
        );
        let octave = level(2.0);
        assert!(
            octave < 0.15,
            "+12 半音电平 {:.3}：抵消塌陷消失了？是好事，但请同步更新 psola 模块头的已知极限表",
            octave
        );
    }

    #[test]
    fn noise_only_input_does_not_panic() {
        let sr = 48000.0;
        let mut state = 0x1234_5678u32;
        let x: Vec<f32> = (0..48000)
            .map(|_| {
                state = state.wrapping_mul(1664525).wrapping_add(1013904223);
                (state >> 8) as f32 / 8388608.0 - 1.0
            })
            .collect();
        let out = apply_planar(&[&x], sr, 1.5, 1.5);
        assert_eq!(out[0].len(), 72000);
        assert!(out[0].iter().all(|v| v.is_finite()));
    }

    #[test]
    fn very_short_input_does_not_panic() {
        let sr = 48000.0;
        for n in [1usize, 100, 1000, 4000] {
            let x = make_sine(300.0, sr, n);
            let out = apply_planar(&[&x], sr, 1.5, 1.5);
            assert!(out[0].iter().all(|v| v.is_finite()), "n={}", n);
        }
    }

    /// 30~120ms 的短切片也必须真的变调。
    ///
    /// 曾经 `yin_frame` 在窗放不下时直接返回「无音高」，而 `track_pitch` 的循环
    /// 条件又要求 `center + WIN/2 <= n`，于是短于 WIN（43ms）的切片一帧都取不到
    /// → 整段判无音高 → 只走固定颗粒直通 → **变调静默失效**（听起来就是没变）。
    /// 鬼畜里 30~40ms 的切片并不罕见，这不该悄悄变成「不处理」。
    ///
    /// 断言分两档：极短切片（30/40ms）只保证「链路真的走了变调」——它们只有
    /// 6~8 个周期，重叠颗粒的叠加谱本来就测不出单一稳定基频，拿 YIN 去断言会
    /// 误报；60ms 起才追加音高结论。
    #[test]
    fn short_slice_is_still_pitch_shifted() {
        let sr = 48000.0;
        let f0 = 200.0f32;
        let pitch = 2.0f32.powf(7.0 / 12.0);
        for ms in [30.0f32, 40.0, 60.0, 120.0] {
            let n = (sr * ms / 1000.0) as usize;
            let x = make_vowel(f0, sr, n);

            // ① 取到了帧，而且判为 voiced
            let frames = track_pitch(&x, sr);
            assert!(!frames.is_empty(), "{}ms 切片一帧 F0 都没取到", ms);
            let voiced_f0 = frames.iter().find(|f| f.voiced).map(|f| f.f0);
            let got_f0 = voiced_f0.unwrap_or_else(|| panic!("{}ms 切片没有 voiced 帧", ms));
            let f0_err = (CENTS * (got_f0 / f0).log2()).abs();
            assert!(f0_err < 100.0, "{}ms 切片源 F0 测得 {:.1}Hz（{:.0} 音分）", ms, got_f0, f0_err);

            // ② 生成了 pitch marks（有周期可同步，不是走直通）
            let marks = detect_marks(&x, &frames, sr);
            assert!(marks.len() >= 2, "{}ms 切片只生成 {} 颗 mark", ms, marks.len());

            // ③ 输出非静音，且确实被改动了（直通路径下二者相等）
            let out = apply_planar(&[&x], sr, pitch, 1.0);
            let rms = (out[0].iter().map(|v| v * v).sum::<f32>() / out[0].len() as f32).sqrt();
            assert!(rms > 1e-4, "{}ms 切片输出接近静音（rms={}）", ms, rms);
            let diff: f32 = x
                .iter()
                .zip(out[0].iter())
                .map(|(a, b)| (a - b) * (a - b))
                .sum::<f32>()
                / x.len() as f32;
            let rel = diff.sqrt() / rms;
            assert!(rel > 0.3, "{}ms 切片输出与源几乎一样（相对差 {:.3}）—— 变调没生效", ms, rel);

            // ④ 够长的切片再验音高结论
            if ms >= 60.0 {
                let got = detect_f0(&out[0], sr);
                assert!(got > 0.0, "{}ms 切片测不到基频", ms);
                let d_shift = (CENTS * (got / (f0 * pitch)).log2()).abs();
                let d_raw = (CENTS * (got / f0).log2()).abs();
                assert!(
                    d_shift < d_raw,
                    "{}ms 切片：测得 {:.1}Hz，离变调目标 {:.1}Hz（{:.0} 音分）比离原音 {:.1}Hz（{:.0} 音分）还远",
                    ms,
                    got,
                    f0 * pitch,
                    d_shift,
                    f0,
                    d_raw
                );
            }
        }
    }

    // -----------------------------------------------------------------------
    // 模块 E：谐波/噪声分离（mode 3）
    // -----------------------------------------------------------------------

    /// 拆分的正确性**定义**：谐波成分 + 残余必须逐样本还原源信号。
    /// 这一条挂了，后面所有「降噪」结论都无从谈起。
    #[test]
    fn harmonic_split_reconstructs_source() {
        let sr = 48000.0;
        let x = make_vowel(220.0, sr, 24000);
        let frames = track_pitch(&x, sr);
        assert!(frames.iter().any(|f| f.voiced), "合成元音应当有 voiced 帧");

        let (harm, noise) = split_harmonic(&x, &frames, sr);
        assert_eq!(harm.len(), x.len());
        assert_eq!(noise.len(), x.len());

        let mut max_err = 0.0f32;
        let mut nz = 0usize;
        for i in 0..x.len() {
            max_err = max_err.max((harm[i] + noise[i] - x[i]).abs());
            if noise[i].abs() > 1e-9 {
                nz += 1;
            }
        }
        println!("harm+noise 最大还原误差 = {max_err:.3e}   有残余的样点 = {nz}/{}", x.len());
        assert!(max_err < 1e-5, "harm + noise 必须还原源（最大误差 {max_err:.3e}）");
        assert!(nz > x.len() / 4, "voiced 素材上残余不该几乎全零（只有 {nz} 个样点）");
    }

    /// β 只在**明确降调**时介入。升调 / unity / 轻微降调必须完全不启用 ——
    /// 这是「升调侧不要动」这条要求的可执行形式。
    #[test]
    fn noise_retention_only_kicks_in_on_downshift() {
        for r in [1.0f32, 1.26, 1.5, 2.0, 4.0, 0.95, 0.90, 0.89] {
            assert_eq!(noise_retention(r), 1.0, "ratio {r} 不该启用拆分");
        }
        // 标定点：-8.2 半音处 β = 0.5 —— 真·PitchNet 的 HF 分档就是在这一档对齐的
        let b62 = noise_retention(0.62);
        assert!((b62 - 0.50).abs() < 0.02, "β(0.62) 应为 0.50，实测 {b62}");

        // 单调不增，且有地板（抽干会发闷）
        let mut prev = 1.0f32;
        for r in [0.88f32, 0.8, 0.7, 0.62, 0.55, 0.5, 0.45, 0.35, 0.25] {
            let b = noise_retention(r);
            assert!(b <= prev + 1e-6, "β 必须随降调单调不增（ratio {r} → {b}）");
            assert!(b >= 0.35 - 1e-6, "β 不得低于地板（ratio {r} → {b}）");
            prev = b;
        }
        assert!((noise_retention(0.25) - 0.35).abs() < 1e-6, "深降调应当压到地板");
    }

    /// 启用线必须落在 **f32 ABI 能表达的那个值**上。
    ///
    /// `hajimi_tx_run` 的 pitch 是 f32，而 `0.89f32 = 0.88999998569… < 0.89f64`。
    /// 常量若写成 f64，恰好传 0.89 的一档会满足 `pitch < 线` → 分离提前一个 ULP 打开，
    /// 「启用线及以上逐样本相同」在 0.89 上失效（探针实测差异 0.61×源RMS）。
    /// 这个坑**只有走 wasm ABI 的探针能看见** —— host 单测原先用 f64 字面量比较，
    /// 所以它是绿的时候线上是坏的。这条测试把它钉住。
    #[test]
    fn enable_line_is_exact_in_f32_abi_precision() {
        let abi_089 = 0.89f32;
        assert!(
            (abi_089 as f64) < 0.89f64,
            "前提：f32(0.89) 确实小于 f64 0.89（否则本测试失去意义）"
        );
        assert_eq!(
            abi_089, HN_ENABLE_MAX_RATIO,
            "0.89 经 ABI 转换后必须正好落在启用线上"
        );
        assert!(!hn_split_enabled(abi_089), "恰好 0.89 不该启用拆分");
        assert!(!hn_split_enabled(1.0));
        assert!(!hn_split_enabled(0.95));
        assert!(hn_split_enabled(0.8899), "线以下必须启用");
        assert!(hn_split_enabled(0.62));
    }

    /// 升调 / unity 侧必须**逐样本不变**：mode 3 与 mode 1 完全一致。
    ///
    /// 用户实测升调侧（+5/+7/+12）比 PitchNet 干净，这次改动绝不能碰到它。
    /// 0.89 也列进来 —— 启用线本身属于「不得改动」的一侧（见 ABI 精度那条）。
    #[test]
    fn harmonic_mode_leaves_upshift_bit_exact() {
        let sr = 48000.0;
        let x = make_vowel(200.0, sr, 24000);
        for pitch in [
            1.0f32,
            2.0f32.powf(5.0 / 12.0),
            2.0f32.powf(7.0 / 12.0),
            2.0,
            HN_ENABLE_MAX_RATIO,
        ] {
            let a = apply_planar(&[&x], sr, pitch, 1.0);
            let b = apply_planar_harmonic(&[&x], sr, pitch, 1.0);
            assert_eq!(a.len(), b.len());
            assert!(
                a[0] == b[0],
                "pitch={pitch} 时 mode 3 与 mode 1 出现了差异（应当逐样本相同）"
            );
        }
    }

    /// 降调时拆分要真的把宽带噪声压下去，同时不把电平抽干、不把高频占比抬上去。
    #[test]
    fn harmonic_mode_reduces_noise_on_downshift() {
        let sr = 48000.0;
        let n = 24000;
        let mut x = make_vowel(220.0, sr, n);
        let mut seed = 0x2545f491u32;
        for i in 0..n {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            x[i] += 0.10 * ((seed >> 8) as f32 / 8388608.0 - 1.0);
        }
        let rms = |v: &[f32]| (v.iter().map(|s| s * s).sum::<f32>() / v.len() as f32).sqrt();
        // 一阶差分能量 / 总能量 —— 高频占比的廉价代理
        let hf = |v: &[f32]| {
            let d: f32 = v.windows(2).map(|w| (w[1] - w[0]) * (w[1] - w[0])).sum::<f32>();
            let e: f32 = v.iter().map(|s| s * s).sum::<f32>();
            (d / e.max(1e-12)).sqrt()
        };

        // 0.62 ≈ -8.23 半音，正是用户实测出问题的那一档
        let plain = apply_planar(&[&x], sr, 0.62, 1.0);
        let split = apply_planar_harmonic(&[&x], sr, 0.62, 1.0);
        let (lp, ls) = (rms(&plain[0]), rms(&split[0]));
        let (hp, hs) = (hf(&plain[0]), hf(&split[0]));
        println!(
            "-8.2 半音：普通 rms={lp:.5} HF占比={hp:.4} | 拆分 rms={ls:.5} HF占比={hs:.4}"
        );

        assert!(ls.is_finite() && ls > 0.0, "拆分输出必须有限且非静音");
        assert!(ls < lp, "拆分应当压掉一部分噪声（{ls:.5} 未低于 {lp:.5}）");
        assert!(ls > 0.6 * lp, "拆分不应把电平抽干（{ls:.5} vs {lp:.5}）");
        assert!(hs < hp, "拆分不应让高频占比升高（{hs:.4} vs {hp:.4}）");
    }
}
