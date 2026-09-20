import JSZip from 'jszip';
import type { Project, SampleId } from './types';

/**
 * .hjm 工程包导入导出（计划 §2：zip = manifest.json + project.json + audio/*.bin）。
 * 纯静态实现，无后端。导出包含全部素材原始 Blob；导入还原为可水合的工程状态。
 */

const MANIFEST_PATH = 'manifest.json';
const PROJECT_PATH = 'project.json';
const AUDIO_DIR = 'audio/';

export interface HjmManifest {
  app: 'meme-studio';
  schemaVersion: number;
  exportedAt: string;
  projectName: string;
  /** sampleId → 包内路径 */
  audioFiles: Record<SampleId, string>;
}

export interface HjmPackage {
  project: Project;
  blobs: Record<SampleId, Blob>;
}

function extFor(mime: string): string {
  if (mime.includes('wav')) return '.wav';
  if (mime.includes('mpeg') || mime.includes('mp3')) return '.mp3';
  if (mime.includes('ogg')) return '.ogg';
  if (mime.includes('flac')) return '.flac';
  if (mime.includes('webm')) return '.webm';
  return '.bin';
}

/** 打包当前工程为 .hjm（zip Blob）。缺失 Blob 的素材会被跳过并在控制台告警。 */
export async function exportHjm(
  project: Project,
  blobs: Record<SampleId, Blob>,
): Promise<Blob> {
  const zip = new JSZip();
  const audioFiles: Record<SampleId, string> = {};
  for (const s of project.samples) {
    const blob = blobs[s.id];
    if (!blob) {
      console.warn(`[transfer] 素材 ${s.name}(${s.id}) 缺少 Blob，已跳过`);
      continue;
    }
    const path = `${AUDIO_DIR}${s.id}${extFor(blob.type)}`;
    audioFiles[s.id] = path;
    zip.file(path, blob);
  }
  const manifest: HjmManifest = {
    app: 'meme-studio',
    schemaVersion: project.schemaVersion,
    exportedAt: new Date().toISOString(),
    projectName: project.name,
    audioFiles,
  };
  zip.file(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  zip.file(PROJECT_PATH, JSON.stringify(project, null, 2));
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}

/** 解包 .hjm → 工程元数据 + 音频 Blob 表。 */
export async function importHjm(file: Blob): Promise<HjmPackage> {
  const zip = await JSZip.loadAsync(file);

  const projFile = zip.file(PROJECT_PATH);
  if (!projFile) throw new Error('.hjm 缺少 project.json，文件可能已损坏');
  const project: Project = JSON.parse(await projFile.async('string'));

  const blobs: Record<SampleId, Blob> = {};
  const manifestFile = zip.file(MANIFEST_PATH);
  if (manifestFile) {
    const manifest: HjmManifest = JSON.parse(await manifestFile.async('string'));
    for (const [id, path] of Object.entries(manifest.audioFiles)) {
      const entry = zip.file(path);
      if (entry) blobs[id] = await entry.async('blob');
    }
  } else {
    // 兼容无 manifest 的旧包：扫描 audio/ 目录，文件名主干即 sampleId
    const jobs: Array<Promise<void>> = [];
    zip.forEach((path, entry) => {
      if (entry.dir || !path.startsWith(AUDIO_DIR)) return;
      const id = path.slice(AUDIO_DIR.length).replace(/\.[^.]+$/, '');
      jobs.push(
        entry.async('blob').then((b) => {
          blobs[id] = b;
        }),
      );
    });
    await Promise.all(jobs);
  }

  return { project, blobs };
}

/** 触发浏览器下载（导出 wav/mp3/.hjm 共用）。 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
