// hajimi-audio —— WASM 音频核心（解码 + 音高检测）。
//
// 设计（参照 openDAW 的 bare-wasm 思路）：
//  - 编译目标 wasm32-unknown-unknown，crate-type = cdylib，纯 extern "C" ABI，
//    不依赖 wasm-bindgen —— JS 侧只需 WebAssembly.instantiate + 手写胶水。
//  - 解码结果暂存于线程局部 LAST（wasm 单线程），JS 通过一组 getter 按指针
//    读取各声道 f32 平面，读完调用 hajimi_decode_free 释放。
//  - 音高检测（YIN）直接在暂存结果上跑，避免把百万级样本再传回 JS 降混。
//
// 内存协议：
//   hajimi_alloc(len) -> ptr            JS 分配输入字节缓冲
//   hajimi_dealloc(ptr, len)            JS 释放
//   hajimi_decode(ptr, len) -> nch      解码；nch<0 表示失败
//   hajimi_decode_channels() -> nch
//   hajimi_decode_frames() -> frames
//   hajimi_decode_sample_rate() -> hz
//   hajimi_decode_channel_ptr(c) -> ptr 第 c 声道 f32 首地址（长度 = frames）
//   hajimi_detect_pitch() -> hz         基频；0.0 = 未检出
//   hajimi_decode_free()                释放暂存结果
//
// 音高检测另有一个「对任意 f32 缓冲」的入口（不依赖暂存解码结果）：
//   hajimi_yin_f32(ptr, frames, sr, threshold, min_hz, max_hz) -> hz
// JS 侧的音高面板走这一个 —— 与 `hajimi_detect_pitch` 是**同一份实现**，
// 只是参数可调，避免出现第二套 YIN。

mod autotune;
mod psola;
mod stretch;
mod yin;
mod yin_core;

use std::cell::RefCell;

use symphonia::core::audio::{AudioBuffer, Signal};
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// 解码产物：planar f32（每声道一个 Vec）+ 原生采样率。
struct Decoded {
    channels: Vec<Vec<f32>>,
    sample_rate: u32,
}

thread_local! {
    static LAST: RefCell<Option<Decoded>> = const { RefCell::new(None) };
}

/// 安全上限：单素材最多约 20 分钟 @192kHz，防损坏文件把线性内存撑爆。
const MAX_FRAMES: usize = 192_000 * 60 * 20;

// ---------------------------------------------------------------------------
// 线性内存分配（JS 写入输入字节用）
// ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn hajimi_alloc(len: usize) -> *mut u8 {
    let mut buf: Vec<u8> = Vec::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

#[no_mangle]
pub extern "C" fn hajimi_dealloc(ptr: *mut u8, len: usize) {
    if ptr.is_null() {
        return;
    }
    unsafe {
        drop(Vec::from_raw_parts(ptr, 0, len));
    }
}

// ---------------------------------------------------------------------------
// 解码
// ---------------------------------------------------------------------------

/// 解码字节流为 planar f32。返回声道数（>0）；负值表示失败。
/// 成功后结果暂存于 LAST，由 getter 读取，最终 hajimi_decode_free 释放。
#[no_mangle]
pub extern "C" fn hajimi_decode(ptr: *const u8, len: usize) -> i32 {
    if ptr.is_null() || len == 0 {
        return -1;
    }
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    match do_decode(bytes) {
        Ok(d) => {
            let n = d.channels.len() as i32;
            LAST.with(|c| *c.borrow_mut() = Some(d));
            n
        }
        Err(_) => -2,
    }
}

fn do_decode(bytes: &[u8]) -> Result<Decoded, String> {
    // MediaSourceStream 要求 'static 源，故取得输入字节的所有权（一次拷贝，
    // 相对解码开销可忽略）。
    let owned = bytes.to_vec();
    let mss = MediaSourceStream::new(Box::new(std::io::Cursor::new(owned)), Default::default());
    let hint = Hint::new();
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| e.to_string())?;
    let mut format = probed.format;

    let track = format
        .default_track()
        .ok_or_else(|| "no audio track".to_string())?
        .clone();
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| e.to_string())?;

    let mut chans: Vec<Vec<f32>> = Vec::new();
    let mut sample_rate: u32 = track.codec_params.sample_rate.unwrap_or(44100);

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            // 流结束（含正常 EOF）或异常：停止，保留已解码部分
            Err(_) => break,
        };
        if packet.track_id() != track.id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            // 单包解码失败：跳过，不中断整体
            Err(_) => continue,
        };
        sample_rate = decoded.spec().rate;
        let mut f32buf: AudioBuffer<f32> = decoded.make_equivalent();
        decoded.convert(&mut f32buf);
        let nch = f32buf.spec().channels.count();
        while chans.len() < nch {
            chans.push(Vec::new());
        }
        for c in 0..nch {
            chans[c].extend_from_slice(f32buf.chan(c));
        }
        if chans.first().map(|v| v.len()).unwrap_or(0) > MAX_FRAMES {
            break;
        }
    }

    if chans.is_empty() || chans.iter().any(|v| v.is_empty()) {
        return Err("decoded nothing".to_string());
    }
    // 各声道长度对齐到最短（防个别解码器末包不齐）
    let min_len = chans.iter().map(|v| v.len()).min().unwrap_or(0);
    for v in chans.iter_mut() {
        v.truncate(min_len);
    }
    Ok(Decoded {
        channels: chans,
        sample_rate,
    })
}

#[no_mangle]
pub extern "C" fn hajimi_decode_channels() -> i32 {
    LAST.with(|c| {
        c.borrow()
            .as_ref()
            .map(|d| d.channels.len() as i32)
            .unwrap_or(0)
    })
}

#[no_mangle]
pub extern "C" fn hajimi_decode_frames() -> i32 {
    LAST.with(|c| {
        c.borrow()
            .as_ref()
            .and_then(|d| d.channels.first())
            .map(|v| v.len() as i32)
            .unwrap_or(0)
    })
}

#[no_mangle]
pub extern "C" fn hajimi_decode_sample_rate() -> i32 {
    LAST.with(|c| {
        c.borrow()
            .as_ref()
            .map(|d| d.sample_rate as i32)
            .unwrap_or(0)
    })
}

#[no_mangle]
pub extern "C" fn hajimi_decode_channel_ptr(c: usize) -> *const f32 {
    LAST.with(|cell| match cell.borrow().as_ref() {
        Some(d) => d
            .channels
            .get(c)
            .map(|v| v.as_ptr())
            .unwrap_or(std::ptr::null()),
        None => std::ptr::null(),
    })
}

#[no_mangle]
pub extern "C" fn hajimi_decode_free() {
    LAST.with(|c| *c.borrow_mut() = None);
}

// ---------------------------------------------------------------------------
// 音高检测（YIN）—— 在暂存解码结果上降混 + 检测，避免大数组回传 JS
// ---------------------------------------------------------------------------

/// 返回基频 Hz；0.0 表示未检出（纯噪声/静音/打击乐）。
#[no_mangle]
pub extern "C" fn hajimi_detect_pitch() -> f32 {
    LAST.with(|cell| match cell.borrow().as_ref() {
        Some(d) => {
            // 降混到单声道（取前 4 秒，与旧 TS 行为一致）
            let max_n = (d.sample_rate as usize).saturating_mul(4);
            let n = d
                .channels
                .first()
                .map(|v| v.len().min(max_n))
                .unwrap_or(0);
            if n == 0 {
                return 0.0;
            }
            let chcount = d.channels.len();
            let mut mono = vec![0f32; n];
            for ch in &d.channels {
                for i in 0..n {
                    mono[i] += ch[i];
                }
            }
            if chcount > 1 {
                let inv = 1.0 / chcount as f32;
                for v in mono.iter_mut() {
                    *v *= inv;
                }
            }
            yin::detect_pitch(&mono, d.sample_rate)
        }
        None => 0.0,
    })
}

/// 在 JS 传入的**任意**单声道 f32 缓冲上跑 YIN，返回基频 Hz（0.0 = 未检出）。
///
/// 为什么需要它：音高面板的三个参数（阈值 / 最低 Hz / 最高 Hz）要作用到检测上，
/// 而上面的 `hajimi_detect_pitch` 只能用默认参数、且只认暂存解码结果。
/// JS 侧原本自己实现了一份同算法的 YIN 来满足这两个需求 —— 结果两份实现各自
/// 演化，兜底逻辑只加在了 Rust 这边：41 个真素材上 wasm 未检出 2/41，
/// JS 版未检出 15/41，且 JS 的可用结果全被 wasm 覆盖
/// （`scripts/probe-ai/probe-yin-parity.html`）。
///
/// 所以把这个入口开出来，让面板用回同一份实现。**不要再往 JS 版里补算法**。
#[no_mangle]
pub extern "C" fn hajimi_yin_f32(
    ptr: *const f32,
    frames: usize,
    sample_rate: u32,
    threshold: f32,
    min_hz: f32,
    max_hz: f32,
) -> f32 {
    if ptr.is_null() || frames == 0 || sample_rate == 0 {
        return 0.0;
    }
    let data = unsafe { std::slice::from_raw_parts(ptr, frames) };
    yin::detect_pitch_opts(data, sample_rate, threshold, min_hz, max_hz)
}
