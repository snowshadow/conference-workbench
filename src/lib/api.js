export async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || data.message || `请求失败（${response.status}）`);
  }
  return data;
}

export function uploadRecording({ file, title, goal }, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/meetings/import');
    request.responseType = 'json';
    request.upload.onprogress = event => {
      if (event.lengthComputable) onProgress?.(Math.round(event.loaded / event.total * 100));
    };
    request.onerror = () => reject(new Error('上传连接中断。请检查本地服务，并从会议列表核对是否已创建会议。'));
    request.onload = () => {
      const result = request.response || {};
      if (request.status >= 200 && request.status < 300) resolve(result);
      else reject(new Error(typeof result.error === 'string' ? result.error : result.error?.message || result.message || `上传失败（${request.status}）`));
    };
    const form = new FormData();
    form.append('file', file);
    form.append('title', title);
    form.append('goal', goal);
    request.send(form);
  });
}

export const meetingPath = (id, suffix = '') => `/api/meetings/${encodeURIComponent(id)}${suffix}`;

export function formatTime(ms = 0) {
  const seconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const hours = Math.floor(seconds / 3600);
  return `${hours ? `${hours}:` : ''}${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function formatDate(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

export function downloadText(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
