/// <reference lib="webworker" />
/**
 * 临时探针 worker：与 src/engine/pitch-worker.ts 逐条同构，
 * 额外回报 tfjs 后端、各阶段耗时与原始错误，用于定位 AI 检测「坏掉」的真实原因。
 * 用完即删。
 */
(self as unknown as { window: typeof self }).window = self;

const post = (payload: unknown) => (self as unknown as Worker).postMessage(payload);

const MODEL_URL = '/model.json';

type BasicPitchModule = typeof import('@spotify/basic-pitch');
let aiModule: BasicPitchModule | null = null;
let aiModel: InstanceType<BasicPitchModule['BasicPitch']> | null = null;

const resampleToAi = (input: Float32Array, fromSr: number): Float32Array => {
  const AI_TARGET_SR = 22050;
  if (fromSr === AI_TARGET_SR) return input;
  const ratio = fromSr / AI_TARGET_SR;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const t = src - i0;
    out[i] = input[i0] * (1 - t) + input[i1] * t;
  }
  return out;
};

self.onmessage = async (e: MessageEvent) => {
  const req = e.data as { id: number; data: ArrayBuffer; sampleRate: number };
  const t0 = Date.now();
  try {
    let backendProbe = 'n/a';
    let backendAfterReady = 'n/a';

    // ---- 阶段 1：动态 import tfjs / basic-pitch ----
    const tImport = Date.now();
    if (!aiModule) aiModule = await import('@spotify/basic-pitch');
    const importMs = Date.now() - tImport;

    // ---- 阶段 2：探测 tfjs 全局环境（真实 worker 里这些值决定后端选择） ----
    let tfInfo: Record<string, unknown> = {};
    try {
      const tfMod = await import('@tensorflow/tfjs');
      const tf = tfMod.default ?? tfMod;
      const env = tf.env();
      tfInfo = {
        typeofDocument: typeof document,
        typeofWindow: typeof window,
        typeofOffscreenCanvas: typeof OffscreenCanvas,
        typeofWorkerGlobalScope: typeof WorkerGlobalScope,
        IS_BROWSER: env.get('IS_BROWSER'),
        IS_NODE: env.get('IS_NODE'),
        backendNames: (() => {
          try {
            return tf.engine().backendNames();
          } catch (err) {
            return String(err);
          }
        })(),
      };
      const tReady = Date.now();
      try {
        await (tf as unknown as { ready: () => Promise<void> }).ready();
        backendAfterReady = (tf as unknown as { getBackend: () => string }).getBackend();
      } catch (err) {
        backendAfterReady = 'ready() threw: ' + String(err);
      }
      tfInfo.readyMs = Date.now() - tReady;
      backendProbe = String(backendAfterReady);
    } catch (err) {
      tfInfo.error = String(err);
    }

    // ---- 阶段 3：模型加载 ----
    const tModel = Date.now();
    if (!aiModel) {
      const model = new aiModule.BasicPitch(MODEL_URL);
      aiModel = model;
      await (model as unknown as { model: Promise<unknown> }).model;
    }
    const modelMs = Date.now() - tModel;

    // ---- 阶段 4：推理（与真实 worker 完全一致） ----
    const tInfer = Date.now();
    const resampled = resampleToAi(new Float32Array(req.data), req.sampleRate);
    const frames: number[][] = [];
    const onsets: number[][] = [];
    const contours: number[][] = [];
    await aiModel.evaluateModel(
      resampled,
      (f, o, c) => {
        for (const x of f) frames.push(x);
        for (const x of o) onsets.push(x);
        for (const x of c) contours.push(x);
      },
      () => {},
    );
    const inferMs = Date.now() - tInfer;

    const notes = aiModule.noteFramesToTime(
      aiModule.addPitchBendsToNoteEvents(
        contours,
        aiModule.outputToNotesPoly(frames, onsets, 0.25, 0.25, 5),
      ),
    );
    let best = notes[0];
    for (const n of notes) if ((n.amplitude ?? 0) > (best?.amplitude ?? 0)) best = n;

    post({
      kind: 'ok',
      id: req.id,
      totalMs: Date.now() - t0,
      importMs,
      modelMs,
      inferMs,
      backend: backendAfterReady !== 'n/a' ? backendAfterReady : backendProbe,
      inSec: (req.data.byteLength / 4 / req.sampleRate).toFixed(2),
      resampledSec: (resampled.length / 22050).toFixed(2),
      notes: notes.length,
      hz: best ? 440 * Math.pow(2, (best.pitchMidi - 69) / 12) : null,
      tfInfo,
    });
  } catch (err) {
    post({
      kind: 'error',
      id: req.id,
      totalMs: Date.now() - t0,
      name: err instanceof Error ? err.name : typeof err,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? (err.stack ?? '').split('\n').slice(0, 4).join(' | ') : '',
    });
  }
};
