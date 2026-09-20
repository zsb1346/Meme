// verify-stretch —— hajimi-audio WASM 相位声码器「三模式」离线数值验收。
//
// 目的（清单第 5 项验收：Node 数值验证三模式干净）：
//   在 Node 里直接实例化 public/hajimi_audio.wasm，喂入合成信号，调用
//   hajimi_tx_run，验证统一公式 out = pv_stretch(resample(x, π), τ·π) 的
//   两条不变量成立、且输出「干净」（无 NaN/削顶、频谱纯净、幅度平稳）：
//     · 输出时长 ≈ 输入时长 × τ          （与 π 无关）
//     · 输出基频 ≈ 输入基频 × π          （与 τ 无关）
//
//   三模式：
//     1 变调不变时长   π=p,  τ=1     → 时长×1,  音高×p
//     2 变时长不变调   π=1,  τ=r     → 时长×r,  音高×1
//     3 变时长也变调   π=p,  τ=1/p   → 时长×1/p,音高×p （纯重采样）
//
// 运行：node scripts/verify-stretch.mjs   （退出码 0 = 全通过）

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const WASM_PATH = join(root, 'public', 'hajimi_audio.wasm');
const SR = 44100;

// ---------------------------------------------------------------------------
// WASM 加载 + 变换封装（严格对齐 src/engine/rush/transform.ts 的内存协议）
// ---------------------------------------------------------------------------
const bytes = readFileSync(WASM_PATH);
const { instance } = await WebAssembly.instantiate(bytes, {});
const ex = instance.exports;
const mem = () => ex.memory.buffer; // 每次重取：内存可能已增长

/** 单声道 Float32Array → 变换后 Float32Array。π=pitch, τ=time。 */
function transformMono(x, pitch, time, mode = 2) {
  const frames = x.length;
  const ch = 1;
  const allocBytes = ch * frames * 4;
  const ptr = ex.hajimi_alloc(allocBytes) >>> 0;
  new Float32Array(mem(), ptr, ch * frames).set(x);
  const outF = ex.hajimi_tx_run(ptr, frames, ch, pitch, time, mode, SR) | 0;
  ex.hajimi_dealloc(ptr, allocBytes);
  if (outF <= 0) throw new Error(`tx_run 失败 code=${outF}`);
  const outCh = ex.hajimi_tx_channels() | 0;
  if (outCh !== 1) throw new Error(`期望单声道，实得 ${outCh}`);
  const cp = ex.hajimi_tx_channel_ptr(0) >>> 0;
  const out = new Float32Array(mem(), cp, outF).slice(); // slice 拷出独立缓冲
  ex.hajimi_tx_free();
  return out;
}

/** 立体声一致性：左右通道分别变换，长度应相等。 */
function transformStereo(left, right, pitch, time, mode = 2) {
  const frames = left.length;
  const ch = 2;
  const total = ch * frames;
  const allocBytes = total * 4;
  const ptr = ex.hajimi_alloc(allocBytes) >>> 0;
  const view = new Float32Array(mem(), ptr, total);
  view.set(left, 0);
  view.set(right, frames);
  const outF = ex.hajimi_tx_run(ptr, frames, ch, pitch, time, mode, SR) | 0;
  ex.hajimi_dealloc(ptr, allocBytes);
  if (outF <= 0) throw new Error(`tx_run(stereo) 失败 code=${outF}`);
  const outCh = ex.hajimi_tx_channels() | 0;
  const L = new Float32Array(mem(), ex.hajimi_tx_channel_ptr(0) >>> 0, outF).slice();
  const R = new Float32Array(mem(), ex.hajimi_tx_channel_ptr(1) >>> 0, outF).slice();
  ex.hajimi_tx_free();
  return { L, R, outCh, outF };
}

// ---------------------------------------------------------------------------
// 度量工具
// ---------------------------------------------------------------------------
function makeSine(freq, durSec, amp = 0.5) {
  const n = Math.round(durSec * SR);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return x;
}

function finite(x) {
  for (let i = 0; i < x.length; i++) if (!Number.isFinite(x[i])) return false;
  return true;
}

function peakAbs(x) {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]));
  return m;
}

/** 估基频（纯正弦）：稳定中段线性插值过零率。相邻过零相隔半周期，
 *  f = (C-1) / (2·(t_last - t_first))，对纯音精确到亚样本级。 */
function estimateFreqSine(x) {
  const n = x.length;
  const a = Math.floor(n * 0.25), b = Math.floor(n * 0.75);
  const crossT = [];
  let prev = x[a];
  for (let i = a + 1; i < b; i++) {
    const cur = x[i];
    if (prev < 0 && cur >= 0) {
      const frac = -prev / (cur - prev); // 上升沿
      crossT.push(i - 1 + frac);
    } else if (prev >= 0 && cur < 0) {
      const frac = prev / (prev - cur); // 下降沿
      crossT.push(i - 1 + frac);
    }
    prev = cur;
  }
  if (crossT.length < 3) return 0;
  const C = crossT.length;
  const spanSamples = crossT[C - 1] - crossT[0];
  if (spanSamples <= 0) return 0;
  const periodSamples = (2 * spanSamples) / (C - 1);
  return SR / periodSamples;
}

/** Goertzel 在 freq 处的功率（相对全信号能量归一）。 */
function goertzel(x, freq) {
  const N = x.length;
  const k = (freq * N) / SR;
  const w = (2 * Math.PI * k) / N;
  const cw = Math.cos(w);
  const coeff = 2 * cw;
  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < N; i++) {
    s0 = x[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  let energy = 0;
  for (let i = 0; i < N; i++) energy += x[i] * x[i];
  return (2 * power) / (N * N) / (energy / N + 1e-12); // 归一到 [0,~1]
}

/** 分窗 RMS 的变异系数（越小越平稳）——检测相位声码器的幅度抽气/相消。 */
function rmsInstability(x, winSec = 0.05) {
  const w = Math.max(1, Math.round(winSec * SR));
  const vals = [];
  for (let start = 0; start + w <= x.length; start += w) {
    let s = 0;
    for (let i = start; i < start + w; i++) s += x[i] * x[i];
    vals.push(Math.sqrt(s / w));
  }
  if (vals.length < 3) return 0;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const varr = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
  return Math.sqrt(varr) / (mean + 1e-12);
}

/** 忽略首尾 50ms，统计本应连续有声的信号中近乎静音的 10ms 窗口。 */
function silentWindowRatio(x, winSec = 0.01) {
  const w = Math.max(1, Math.round(winSec * SR));
  const begin = Math.min(x.length, Math.round(0.05 * SR));
  const end = Math.max(begin, x.length - Math.round(0.05 * SR));
  let silent = 0, total = 0;
  for (let start = begin; start + w <= end; start += w) {
    let energy = 0;
    for (let i = start; i < start + w; i++) energy += x[i] * x[i];
    if (Math.sqrt(energy / w) < 1e-3) silent++;
    total++;
  }
  return total === 0 ? 0 : silent / total;
}

// ---------------------------------------------------------------------------
// 断言框架
// ---------------------------------------------------------------------------
let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`);
  } else {
    fail++;
    fails.push(name);
    console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`);
  }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------
console.log(`hajimi stretch 三模式数值验收  (wasm=${(bytes.length / 1024).toFixed(0)}KB, sr=${SR})\n`);

// --- PSOLA 连续性：连续有声输入不允许中途产生数字静音窗 ---
{
  console.log('[P] PSOLA 连续性  π=1.5 τ=1');
  const x = makeSine(220, 1.0);
  const y = transformMono(x, 1.5, 1, 1);
  const silentRatio = silentWindowRatio(y);
  check('无中途静音窗', silentRatio === 0, `silentRatio=${silentRatio.toFixed(3)}`);
}

// --- 默认 SOLA/FL Stretch 模式：连续、音高准确、时长独立且无明显抽气 ---
{
  console.log('[S] SOLA/FL Stretch  π=1.5 τ=1');
  const f0 = 220;
  const x = makeSine(f0, 1.0);
  const y = transformMono(x, 1.5, 1, 2);
  const f = estimateFreqSine(y);
  const silentRatio = silentWindowRatio(y);
  const instability = rmsInstability(y);
  check('时长不变', near(y.length / SR, 1.0, 0.02), `${(y.length / SR).toFixed(3)}s`);
  check('音高 ×π', near(f, f0 * 1.5, f0 * 1.5 * 0.02), `${f.toFixed(1)}Hz`);
  check('无中途静音窗', silentRatio === 0, `silentRatio=${silentRatio.toFixed(3)}`);
  check('无明显抽气', instability < 0.15, `cv=${instability.toFixed(3)}`);
}

{
  console.log('[S] SOLA/FL Stretch  π=1 τ=1.5');
  const f0 = 220;
  const x = makeSine(f0, 1.0);
  const y = transformMono(x, 1, 1.5, 2);
  const f = estimateFreqSine(y);
  check('时长 ×τ', near(y.length / SR, 1.5, 0.02), `${(y.length / SR).toFixed(3)}s`);
  check('音高不变', near(f, f0, f0 * 0.02), `${f.toFixed(1)}Hz`);
  check('无中途静音窗', silentWindowRatio(y) === 0);
}

// --- 0. 恒等：π=τ=1 应逐样本原样返回（transform_channel 短路，不拷贝失真） ---
{
  console.log('[0] 恒等 π=τ=1');
  const x = makeSine(300, 0.5);
  const y = transformMono(x, 1, 1);
  check('长度不变', y.length === x.length, `${y.length} vs ${x.length}`);
  let maxDiff = 0;
  for (let i = 0; i < x.length; i++) maxDiff = Math.max(maxDiff, Math.abs(x[i] - y[i]));
  check('逐样本一致', maxDiff < 1e-6, `maxDiff=${maxDiff.toExponential(2)}`);
}

// --- 1. 变调不变时长：π=p, τ=1 ---
for (const p of [1.5, 0.7, 2.0]) {
  console.log(`[1] 变调不变时长  π=${p} τ=1`);
  const f0 = 440;
  const x = makeSine(f0, 1.0);
  const y = transformMono(x, p, 1);
  check('无 NaN/Inf', finite(y));
  check('时长不变 (≈1.0s)', near(y.length / SR, 1.0, 0.02), `${(y.length / SR).toFixed(3)}s`);
  const f = estimateFreqSine(y);
  check('音高 ×π', near(f, f0 * p, f0 * p * 0.02), `实测 ${f.toFixed(1)}Hz 期望 ${(f0 * p).toFixed(1)}Hz`);
  const purity = goertzel(y, f0 * p);
  check('频谱纯净(基频占优)', purity > 0.5, `purity=${purity.toFixed(3)}`);
  const leak = goertzel(y, f0);
  check('原频点无残留(解耦干净)', leak < 0.2, `leak@${f0}Hz=${leak.toFixed(3)}`);
  check('幅度平稳(无相消抽气)', rmsInstability(y) < 0.15, `cv=${rmsInstability(y).toFixed(3)}`);
}

// --- 2. 变时长不变调：π=1, τ=r ---
for (const r of [1.5, 0.6, 2.0]) {
  console.log(`[2] 变时长不变调  π=1 τ=${r}`);
  const f0 = 330;
  const x = makeSine(f0, 1.0);
  const y = transformMono(x, 1, r);
  check('无 NaN/Inf', finite(y));
  check(`时长 ×τ (≈${r}s)`, near(y.length / SR, r, 0.02), `${(y.length / SR).toFixed(3)}s`);
  const f = estimateFreqSine(y);
  check('音高不变', near(f, f0, f0 * 0.02), `实测 ${f.toFixed(1)}Hz 期望 ${f0}Hz`);
  check('幅度平稳', rmsInstability(y) < 0.15, `cv=${rmsInstability(y).toFixed(3)}`);
}

// --- 3. 变时长也变调（纯重采样）：π=p, τ=1/p ---
for (const p of [1.5, 0.8]) {
  console.log(`[3] 纯重采样  π=${p} τ=${(1 / p).toFixed(4)}`);
  const f0 = 500;
  const x = makeSine(f0, 1.0);
  const y = transformMono(x, p, 1 / p);
  check('无 NaN/Inf', finite(y));
  check(`时长 ×(1/p) (≈${(1 / p).toFixed(3)}s)`, near(y.length / SR, 1 / p, 0.02), `${(y.length / SR).toFixed(3)}s`);
  const f = estimateFreqSine(y);
  check('音高 ×π', near(f, f0 * p, f0 * p * 0.02), `实测 ${f.toFixed(1)}Hz 期望 ${(f0 * p).toFixed(1)}Hz`);
}

// --- 4. 立体声：两通道长度一致、各自音高正确 ---
{
  console.log('[4] 立体声一致性  π=1.25 τ=1');
  const fL = 440, fR = 550;
  const L = makeSine(fL, 0.8);
  const R = makeSine(fR, 0.8);
  const { L: oL, R: oR, outCh, outF } = transformStereo(L, R, 1.25, 1);
  check('输出双声道', outCh === 2);
  check('两通道等长', oL.length === oR.length && oL.length === outF);
  check('左声道音高 ×1.25', near(estimateFreqSine(oL), fL * 1.25, fL * 1.25 * 0.02), `${estimateFreqSine(oL).toFixed(1)}Hz`);
  check('右声道音高 ×1.25', near(estimateFreqSine(oR), fR * 1.25, fR * 1.25 * 0.02), `${estimateFreqSine(oR).toFixed(1)}Hz`);
}

// --- 5. 谐波保真：双音 440+880 变调后两分量同步平移（音高结构不乱） ---
{
  console.log('[5] 谐波结构  π=1.5 τ=1 (440+880 → 660+1320)');
  const n = Math.round(1.0 * SR);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR) + 0.3 * Math.sin((2 * Math.PI * 880 * i) / SR);
  const y = transformMono(x, 1.5, 1);
  check('时长不变', near(y.length / SR, 1.0, 0.02), `${(y.length / SR).toFixed(3)}s`);
  const p660 = goertzel(y, 660);
  const p1320 = goertzel(y, 1320);
  const p440 = goertzel(y, 440);
  check('新基频 660 存在', p660 > 0.2, `p=${p660.toFixed(3)}`);
  check('新谐波 1320 存在', p1320 > 0.2, `p=${p1320.toFixed(3)}`);
  check('旧基频 440 已移走', p440 < 0.15, `p=${p440.toFixed(3)}`);
}

// ---------------------------------------------------------------------------
console.log(`\n结果： ${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('失败项：\n  - ' + fails.join('\n  - '));
  process.exit(1);
}
console.log('三模式全部干净 ✓');
