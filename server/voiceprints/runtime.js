import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MODEL = Object.freeze({ id: 'funasr/campplus', revision: 'e4b6ede7ce16997aff4ae69fbca1f0175e2afede', sha256: '3388cf5fd3493c9ac9c69851d8e7a8badcfb4f3dc631020c4961371646d5ada8', dimensions: 192, sampleRate: 16000, license: 'Apache-2.0' });
const worker = fileURLToPath(new URL('./worker.py', import.meta.url));

export function createVoiceprintRuntime({ dataDir, runtimeDir = process.env.WORKBENCH_VOICEPRINT_RUNTIME || path.join(dataDir, 'voiceprint-runtime'), timeoutMs = 120000 } = {}) {
  const python = path.join(runtimeDir, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  function status() {
    let manifest;
    try { manifest = JSON.parse(readFileSync(path.join(runtimeDir, 'manifest.json'), 'utf8')); } catch { /* An optional runtime may not be installed. */ }
    const available = Boolean(existsSync(python) && existsSync(path.join(runtimeDir, 'campplus_cn_common.bin')) && manifest?.verifiedAt && manifest?.model?.sha256 === MODEL.sha256 && manifest?.model?.revision === MODEL.revision);
    return { available, model: MODEL, device: 'cpu', threads: 2, runtimeDir, verifiedAt: manifest?.verifiedAt || null, message: available ? '本地声纹运行时已就绪。' : '尚未安装本地声纹运行时，仍可手动标记说话人。' };
  }
  async function extract(paths, { signal } = {}) {
    if (!status().available) throw new Error('本地声纹运行时尚未安装或验证，请运行 scripts/setup-voiceprints.py。');
    return new Promise((resolve, reject) => {
      let output = '', errors = '', settled = false;
      const child = spawn(python, [worker, '--runtime-dir', runtimeDir], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1', OMP_NUM_THREADS: '2', MKL_NUM_THREADS: '2' }, windowsHide: true });
      const finish = (error, value) => {
        if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
      };
      const abort = () => { child.kill('SIGKILL'); finish(Object.assign(new Error('声纹任务已取消。'), { name: 'AbortError' })); };
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('本地声纹处理超时，仍可手动标记说话人。')); }, timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) return abort();
      child.on('error', () => finish(new Error('无法启动本地声纹运行时，仍可手动标记说话人。')));
      child.stdout.on('data', data => { output += data.toString(); if (output.length > 1024 * 1024) { child.kill('SIGKILL'); finish(new Error('声纹运行时返回异常。')); } });
      child.stderr.on('data', data => { errors = (errors + data.toString()).slice(-2000); });
      child.stdin.on('error', () => { /* Process completion reports its failure. */ });
      child.on('close', code => {
        if (code !== 0) return finish(new Error(`本地声纹处理失败${errors.trim() ? '，请检查运行时依赖与音频格式' : ''}。仍可手动标记说话人。`));
        try { const value = JSON.parse(output); if (!Array.isArray(value.embeddings) || value.embeddings.length !== paths.length) throw new Error(); finish(null, value.embeddings); }
        catch { finish(new Error('声纹运行时没有返回有效特征。')); }
      });
      child.stdin.end(JSON.stringify({ paths }));
    });
  }
  return { status, extract };
}
