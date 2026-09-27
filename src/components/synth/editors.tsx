/**
 * 三个**专用编辑器** + 波表浏览器。
 *
 * 原型 `VFX.html` 里这三块都不是旋钮能表达的，各自是一段自定义控件：
 *
 *   · **32 谐波编辑器** —— 一条频谱曲线。用旋钮得排 32 个，改一次要点 32 下。
 *   · **FM 算法矩阵** —— 8 张连线图，每张要「一眼看出箭头方向」。
 *   · **调制矩阵** —— 4 槽 × (源 / 目标 / 深度)，横向排成行才读得出「哪槽在动什么」。
 *   · **波表浏览器** —— 一张表 16 帧，要能看见「从哪帧扫到哪帧」。
 *
 * ⚠️ 这些控件**直接读写同一个 patch**，不在本地留副本 ——
 * 和旋钮一样走面板的 `edit()`（立刻推引擎 + 防抖落库）。
 * 本地留副本的后果是「画面上是我刚画的、耳朵里是上一版」。
 */

import { useCallback, useRef } from 'react';
import { Knob } from '../ui/Knob';
import {
  ADD_HARMONICS,
  DEFAULT_HARM,
  MACRO_MAP,
  MOD_DST_OPTIONS,
  MOD_SRC_OPTIONS,
  type SynthPatch,
} from '../../engine/synth/patch';
import { getWavetable, WT_DEFS, wtTableName } from '../../engine/synth/wavetables';
import { fmAlgoCaption, fmAlgoGlyphAll, FM_GLYPH_H, FM_GLYPH_W } from './fm-algo';
import { frameWavePath, harmBarPercent, midLinePath } from './wave-preview';

// ---------------------------------------------------------------------------
// 32 谐波编辑器
// ---------------------------------------------------------------------------

/**
 * 32 条谐波，按住拖动直接画。
 *
 * 高度映射：柱高 = 振幅（0..1）。留 2% 底，全零时柱子也看得见（见 `harmBarPercent`）。
 * 拖动时 `onChange` 每帧都会调 —— 面板侧走的是「引擎实时 + 防抖落库」那条路，
 * 所以这里不需要自己做节流。
 */
export function HarmEditor({
  value,
  onChange,
  accent = '#a855f7',
}: {
  value: readonly number[];
  onChange(next: number[]): void;
  accent?: string;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const painting = useRef(false);

  const paintAt = useCallback(
    (clientX: number, clientY: number) => {
      const box = boxRef.current;
      if (!box) return;
      const r = box.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      const x = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      const y = Math.min(1, Math.max(0, 1 - (clientY - r.top) / r.height));
      const i = Math.min(ADD_HARMONICS - 1, Math.floor(x * ADD_HARMONICS));
      const next = Array.from({ length: ADD_HARMONICS }, (_, k) => {
        const cur = value[k];
        return Number.isFinite(cur) ? Math.max(0, Math.min(1, cur)) : 0;
      });
      next[i] = y;
      onChange(next);
    },
    [onChange, value],
  );

  const shapes: Array<[string, () => number[]]> = [
    ['清零', () => new Array(ADD_HARMONICS).fill(0)],
    ['1/n', () => Array.from({ length: ADD_HARMONICS }, (_, n) => (n === 0 ? 0 : 1 / n))],
    [
      '奇次',
      () => Array.from({ length: ADD_HARMONICS }, (_, n) => (n % 2 === 1 ? 1 / n : 0)),
    ],
    ['复位', () => DEFAULT_HARM.slice() as number[]],
  ];

  return (
    <div className="flex flex-col gap-1.5">
      <div
        ref={boxRef}
        role="group"
        aria-label="32 谐波编辑器"
        className="h-16 w-full cursor-crosshair touch-none rounded-sm border border-line bg-ink-950"
        onPointerDown={(e) => {
          painting.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          paintAt(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => {
          if (painting.current) paintAt(e.clientX, e.clientY);
        }}
        onPointerUp={(e) => {
          painting.current = false;
          if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
          }
        }}
        onPointerCancel={() => {
          painting.current = false;
        }}
      >
        <div className="flex h-full w-full items-stretch gap-px px-px">
          {Array.from({ length: ADD_HARMONICS }, (_, i) => (
            /*
              ⛔ 每一列都要先铺一条**轨道**，再在上面摞值柱。
              只画值柱的话，「振幅 = 0」的那一列高度只有 2%（≈1px），
              在深色底上等于不存在 —— 用户看到的是「右边一片空的」，
              会以为编辑器只有十几个谐波、或者那一半坏了点不上。
              有轨道之后 32 列始终可见，也才好按着往右拖。
            */
            <div
              key={i}
              className="relative min-w-0 flex-1 overflow-hidden rounded-t-[1px]"
              style={{ background: 'rgb(var(--ink-800) / 0.55)' }}
            >
              <div
                className="absolute inset-x-0 bottom-0 rounded-t-[1px]"
                style={{
                  height: `${harmBarPercent(value[i])}%`,
                  background: accent,
                  opacity: i >= 16 ? 0.5 : 0.9,
                }}
              />
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-micro text-label-muted">
          第 1 … 32 次谐波（右侧 16 条更弱，是刻意的）
        </span>
        <div className="ml-auto flex gap-1">
          {shapes.map(([label, gen]) => (
            <button
              key={label}
              type="button"
              onClick={() => onChange(gen())}
              className="h-6 rounded-sm border border-line bg-ink-800 px-2 text-micro font-medium text-label-muted transition-colors hover:bg-ink-700 hover:text-label-hi"
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FM 算法矩阵
// ---------------------------------------------------------------------------

const FM_BOX_LABEL_Y_OFFSET = 3.2;

/** 8 张算法图的选卡（点一下就换算法，主载波/箭头一眼可见） */
export function FmAlgoEditor({
  value,
  onChange,
  accent = '#ec4899',
}: {
  value: number;
  onChange(v: number): void;
  accent?: string;
}) {
  const cur = Math.max(0, Math.min(7, Math.round(Number.isFinite(value) ? value : 0)));
  const glyphs = fmAlgoGlyphAll();
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5">
        {glyphs.map((g, i) => {
          const on = i === cur;
          return (
            <button
              key={i}
              type="button"
              title={fmAlgoCaption(i)}
              aria-pressed={on}
              onClick={() => onChange(i)}
              className={`relative rounded-sm border p-0.5 transition-colors ${
                on ? 'bg-ink-800' : 'border-line bg-ink-950 hover:bg-ink-800'
              }`}
              style={on ? { borderColor: accent } : undefined}
            >
              <svg
                viewBox={`0 0 ${FM_GLYPH_W} ${FM_GLYPH_H}`}
                width={52}
                height={60}
                aria-hidden="true"
                style={{ color: on ? accent : 'rgb(var(--text-muted))' }}
              >
                {g.rails.map((d, k) => (
                  <path
                    key={`r${k}`}
                    d={d}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.15}
                    strokeOpacity={0.7}
                  />
                ))}
                {g.dots.map((c, k) => (
                  <circle key={`d${k}`} cx={c.cx} cy={c.cy} r={2.4} fill="currentColor" />
                ))}
                {g.edges.map((d, k) => (
                  <path
                    key={`e${k}`}
                    d={d}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.15}
                    strokeOpacity={0.85}
                  />
                ))}
                {g.arrows.map((d, k) => (
                  <path key={`a${k}`} d={d} fill="currentColor" />
                ))}
                {g.boxes.map((b) => (
                  <g key={`b${b.i}`}>
                    <rect
                      x={b.x}
                      y={b.y}
                      width={b.w}
                      height={b.h}
                      rx={3}
                      fill="rgb(var(--ink-950))"
                      stroke="currentColor"
                      strokeWidth={1.25}
                      strokeOpacity={b.isOut ? 1 : 0.5}
                    />
                    <text
                      x={32}
                      y={b.y + b.h / 2 + FM_BOX_LABEL_Y_OFFSET}
                      fontSize={7.5}
                      fontWeight={700}
                      textAnchor="middle"
                      fill="currentColor"
                      fillOpacity={b.isOut ? 1 : 0.55}
                    >
                      {b.i}
                    </text>
                  </g>
                ))}
              </svg>
              <span
                className="absolute bottom-0 right-0.5 text-[9px] font-semibold leading-none"
                style={{ color: on ? accent : 'rgb(var(--text-muted))' }}
              >
                {i + 1}
              </span>
            </button>
          );
        })}
      </div>
      <p className="text-micro leading-snug text-label-muted">
        {fmAlgoCaption(cur)}　｜　1 号恒为主载波；实心框为发声算子，箭头为调频方向
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 调制矩阵
// ---------------------------------------------------------------------------

const MOD_SLOTS = [1, 2, 3, 4] as const;

/**
 * 4 槽「源 → 目标 → 深度」。
 *
 * ⛔ 这里用原生 `<select>` 而不是面板的 `Seg`：`Seg` 会把 12 个源 / 13 个目标
 * 全部平铺成按钮，四个槽就是 100 个按钮 —— 实测在 1440 宽的弹层里每个按钮
 * 只剩 30px，中文全部竖排换行，整块糊成一团。原型用的也是 `<select>`。
 * 深度用旋钮（可以拖、可以双击回 0），比数字输入框快。
 */
export function ModMatrixEditor({
  patch,
  edit,
  accent = '#eab308',
}: {
  patch: SynthPatch;
  edit(p: keyof SynthPatch, value: unknown): void;
  accent?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-micro text-label-muted">
        <span>源 → 目标 → 深度</span>
        <span className="text-label-lo">（拖动旋钮调量；量 = 0 等于关掉这一槽）</span>
      </div>
      {MOD_SLOTS.map((i) => {
        const srcKey = `mod${i}Src` as keyof SynthPatch;
        const dstKey = `mod${i}Dst` as keyof SynthPatch;
        const amtKey = `mod${i}Amt` as keyof SynthPatch;
        const amt = Number(patch[amtKey]) || 0;
        const live =
          String(patch[srcKey]) !== 'none' && String(patch[dstKey]) !== 'none' && amt !== 0;
        const selectCls =
          'h-7 min-w-0 rounded-sm border border-line bg-ink-800 px-1.5 text-small text-label-hi outline-none focus-visible:ring-2 focus-visible:ring-flame-400/60';
        return (
          <div
            key={i}
            className={`flex items-center gap-2 rounded-sm border px-2 py-1.5 ${
              live ? 'border-transparent bg-ink-900' : 'border-line bg-ink-950/50'
            }`}
            style={live ? { boxShadow: `inset 2px 0 0 0 ${accent}` } : undefined}
          >
            <span className="w-3 shrink-0 text-center text-micro font-semibold text-label-muted">
              {i}
            </span>
            <select
              aria-label={`槽 ${i} 源`}
              value={String(patch[srcKey])}
              onChange={(e) => edit(srcKey, e.target.value)}
              className={`${selectCls} w-[9.5rem] shrink-0`}
            >
              {MOD_SRC_OPTIONS.map(([v, l]) => (
                <option key={String(v)} value={String(v)}>
                  {l}
                </option>
              ))}
            </select>
            <span className="shrink-0 text-micro text-label-lo">→</span>
            <select
              aria-label={`槽 ${i} 目标`}
              value={String(patch[dstKey])}
              onChange={(e) => edit(dstKey, e.target.value)}
              className={`${selectCls} w-[9.5rem] shrink-0`}
            >
              {MOD_DST_OPTIONS.map(([v, l]) => (
                <option key={String(v)} value={String(v)}>
                  {l}
                </option>
              ))}
            </select>
            <div className="ml-auto shrink-0">
              <Knob
                label={`深度 ${i}`}
                value={amt}
                min={-1}
                max={1}
                step={0.001}
                def={0}
                size={36}
                accent={accent}
                formatText={(v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`}
                onChange={(v) => edit(amtKey, v)}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 波表浏览器
// ---------------------------------------------------------------------------

/** 缩略图尺寸 */
const THUMB_W = 34;
const THUMB_H = 26;

/**
 * 一张波表的 16 帧缩略图 + 当前帧位置指示。
 *
 * 为什么要缩略图而不是只有一个「帧位置」旋钮：波表音色的本质是**在表内扫动**，
 * 看不清「从哪帧扫到哪帧」就只是在盲拧。当前帧用高亮框标出，相邻那帧也标出来
 * ——引擎实际是「相邻两帧交叉淡化」，只高亮一帧会让人以为切换是硬切。
 */
export function WtBrowser({
  cat,
  table,
  pos,
  onPickTable,
  accent = '#8b5cf6',
}: {
  cat: SynthPatch['wtCat'];
  table: number;
  pos: number;
  onPickTable(i: number): void;
  accent?: string;
}) {
  const tables = WT_DEFS[cat]?.tables ?? [];
  const frames = getWavetable(cat, table);
  const f = Math.max(0, Math.min(1, Number.isFinite(pos) ? pos : 0)) * (frames.length - 1);
  const i0 = Math.min(frames.length - 2, Math.floor(f));
  const idx = Math.round(f);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {tables.map((t, i) => {
          const on = i === Math.round(table);
          return (
            <button
              key={t.name}
              type="button"
              aria-pressed={on}
              onClick={() => onPickTable(i)}
              className={`h-7 rounded-sm border px-2 text-small font-medium transition-colors ${
                on
                  ? 'border-transparent bg-ink-800 text-label-hi'
                  : 'border-line bg-ink-950 text-label-muted hover:bg-ink-800 hover:text-label-hi'
              }`}
              style={on ? { boxShadow: `inset 0 -2px 0 0 ${accent}` } : undefined}
            >
              {t.name}
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-end gap-1">
        {frames.map((fr, i) => {
          const near = i === idx || i === i0 || i === i0 + 1;
          return (
            <div
              key={i}
              className="rounded-sm border"
              style={{
                borderColor: near ? accent : 'rgb(var(--line))',
                opacity: near ? 1 : 0.55,
                background: 'rgb(var(--ink-950))',
              }}
              title={`第 ${i + 1} 帧`}
            >
              <svg viewBox={`0 0 ${THUMB_W} ${THUMB_H}`} width={THUMB_W} height={THUMB_H}>
                <path
                  d={midLinePath(THUMB_W, THUMB_H)}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={0.5}
                  strokeOpacity={0.18}
                />
                <path
                  d={frameWavePath(fr.imag, THUMB_W, THUMB_H, 40)}
                  fill="none"
                  stroke={near ? accent : 'rgb(var(--text-muted))'}
                  strokeWidth={1}
                  strokeLinejoin="round"
                />
              </svg>
            </div>
          );
        })}
      </div>
      <p className="text-micro text-label-muted">
        表「{wtTableName(cat, table)}」· 共 {frames.length} 帧 · 当前落在第 {i0 + 1}–
        {i0 + 2} 帧之间（相邻两帧交叉淡化）
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 宏的联动说明
// ---------------------------------------------------------------------------

/** 旋钮中文名（宏的联动清单要读得懂；缺省回落到参数名） */
const MACRO_TARGET_LABEL: Record<string, string> = {
  fmDepth: 'FM 深度',
  wtPos: '波表帧位置',
  noiseLevel: '噪声',
  filterReso: '共振',
  filterDrive: '前级驱动',
  granRand: '粒化随机',
  filterCutoff: '截止',
  drive: '过载',
  reverbDamp: '混响阻尼',
  unison: '齐奏声部',
  unisonDetune: '失谐',
  chorusMix: '合唱深度',
  stereoWidth: '立体声宽度',
  reverbMix: '混响干湿',
  reverbSize: '混响空间',
  delayMix: '延迟干湿',
  delayFb: '延迟反馈',
};

/** 宏旋钮下的联动清单（正本在 `patch.ts::MACRO_MAP`，这里只做展示） */
export function MacroLegend() {
  return (
    <div className="flex flex-col gap-1 text-micro leading-snug text-label-muted">
      {(
        [
          ['macroComplex', '复杂度'],
          ['macroBright', '亮度'],
          ['macroThick', '厚度'],
          ['macroSpace', '空间'],
        ] as const
      ).map(([key, label]) => (
        <div key={key}>
          <b className="text-label-hi">{label}</b>
          <span aria-hidden="true"> → </span>
          {MACRO_MAP[key].map((t) => MACRO_TARGET_LABEL[t.p] ?? t.p).join(' · ')}
        </div>
      ))}
    </div>
  );
}
