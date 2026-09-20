/**
 * 变调量的合理范围 —— **全项目唯一一份**。
 *
 * ── 为什么需要它（2026-09-20 用户实报「有些时候素材无声 / 变调后无声」）──
 *
 * 装配面板的 Shift+↑/↓ 是**按住会连发**的（组件里 `silent=true` 那一档就是
 * 为按键重复准备的）。而 `palette-reducer` 的 `AdjustPitch` 早先**不夹取**
 * —— 注释里还专门写着「pitch 无夹取」（τ 有 `clampTau`，半音没有）。
 * 于是按住几秒就能把 `semitoneDelta` 推到 ±60：
 *
 *   半音    ratio    实测（龙.001，立体声，见 probe-silence-lag.mjs）
 *   −60     1/32     `@audio/shift-sample` 输出 **−46.3dB**（听不见）；
 *                    三个 SoundTouch 引擎 **2900~5650ms**（0.72s 的素材！）
 *   +36     8        `ST-声码器` 输出长度 **0.704×**、电平 **+16.3dB**、峰值 **31.96**
 *   +48~60  16/32    `ST-声码器` 长度 0.352×、峰值 11.5~31.9（**爆表 30 倍**）
 *
 * 这些档位没有任何一个是用户想要的 —— 他想要的是「降调听听看」，而不是
 * 「按住方向键 3 秒把整段变成静音或 32 倍爆音」。而它一旦落进事件里就被
 * 持久化，之后回放/导出**永远是那个坏值**，看起来就像「这条素材坏了」。
 *
 * ── 为什么是 ±24 ──
 *
 * 这个数不是新发明的：`engine/pitch.ts::sampleSemitonesAtPitch` 早就用它当
 * 「自动音高看着像检测失败」的界（并在越界时退回手动模式）。也就是说
 * **±24 半音 = 两个八度 = 项目自己已经声明过的「超出这个范围就不是调教而是故障」**。
 * 这里只是把同一条界用到手动增量上，而不是另立一个数。
 *
 * ⚠️ 它不是「引擎的上限」。base（≤24）+ delta（≤24）仍能到 ±48，那时个别引擎
 * 还是会退化 —— 所以 `shift-output-guard.ts` 在出口处还有一道验收，
 * 做不到就让回我们的 wasm 内核（实测 ratio 32 下它仍然 1.000×/−0.2dB）。
 */
export const MAX_SEMITONE_SHIFT = 24;

/**
 * 夹取一次变调增量。非有限值一律归零（NaN 传下去会让 ratio 变 NaN，
 * 库会抛 `ratio must be a finite number > 0` —— 表现是「切了引擎没反应」）。
 *
 * 调用点必须成对出现：`palette-reducer` 的 `AdjustPitch`（改状态）与
 * `NotePalette::nudgePitch`（立刻试听）。两边算出的值**必须逐位相同**，
 * 否则会出现「听到的是 25 半音、提交下去的是 24 半音」这种对不上的错。
 */
export function clampSemitoneDelta(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(-MAX_SEMITONE_SHIFT, Math.min(MAX_SEMITONE_SHIFT, v));
}
