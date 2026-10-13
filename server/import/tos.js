import { createHash, createHmac } from 'node:crypto';

export const TOS_PREFIX = 'conference-workbench/transcription/';
export const TOS_URL_TTL = 24 * 60 * 60;
const hash = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const fail = (message, code = 'TOS_NOT_CONFIGURED') => Object.assign(new Error(message), { publicMessage: message, code, status: 400 });

export function validateTosConfig(config = {}, { credentials = true } = {}) {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket || '')) throw fail('请在连接设置中填写有效的 TOS 存储桶名称。');
  if (!/^[a-z]{2}-[a-z]+(?:-[a-z]+)?(?:-\d)?$/.test(config.region || '')) throw fail('请在连接设置中填写有效的 TOS 地域，例如 cn-beijing。');
  if (credentials && (!config.accessKeyId?.trim() || !config.accessKeySecret?.trim())) throw fail('请在连接设置中填写 TOS AccessKey ID 和 Secret；豆包语音 API Key 不能用于对象存储。');
}

function objectUrl(config, key) {
  validateTosConfig(config);
  // Only the application's random temporary objects can be read or removed.
  if (!new RegExp(`^${TOS_PREFIX}[a-f0-9-]{36}\\.wav$`).test(key)) throw fail('临时音频的存储记录无效。', 'TOS_INVALID_OBJECT');
  return new URL(`https://${config.bucket}.tos-${config.region}.volces.com/${key.split('/').map(encode).join('/')}`);
}

// TOS Signature V4: date/region/tos/request, with the secret itself as the
// initial HMAC key (unlike AWS's AWS4 prefix). Matches the official JS SDK:
// https://github.com/volcengine/ve-tos-js-sdk/blob/main/src/signatureV4.ts
function signature(config, date, scope, canonical) {
  let key = hmac(config.accessKeySecret, date.slice(0, 8));
  for (const part of [config.region, 'tos', 'request']) key = hmac(key, part);
  return hmac(key, `TOS4-HMAC-SHA256\n${date}\n${scope}\n${hash(canonical)}`).toString('hex');
}

export function signedTosRequest({ config, key, method = 'GET', expires = TOS_URL_TTL, now = new Date() }) {
  const url = objectUrl(config, key);
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const scope = `${date.slice(0, 8)}/${config.region}/tos/request`;
  if (method === 'GET') {
    const query = {
      'X-Tos-Algorithm': 'TOS4-HMAC-SHA256', 'X-Tos-Content-Sha256': 'UNSIGNED-PAYLOAD',
      'X-Tos-Credential': `${config.accessKeyId}/${scope}`, 'X-Tos-Date': date,
      'X-Tos-Expires': String(expires), 'X-Tos-SignedHeaders': 'host',
    };
    const canonicalQuery = Object.keys(query).sort().map(name => `${encode(name)}=${encode(query[name])}`).join('&');
    const canonical = `GET\n${url.pathname}\n${canonicalQuery}\nhost:${url.host}\n\nhost\nUNSIGNED-PAYLOAD`;
    url.search = `${canonicalQuery}&X-Tos-Signature=${signature(config, date, scope, canonical)}`;
    return { url: url.href, headers: {} };
  }
  if (!['PUT', 'DELETE'].includes(method)) throw fail('不支持的临时存储操作。', 'TOS_INVALID_METHOD');
  const headers = { host: url.host, 'x-tos-date': date, 'x-tos-content-sha256': 'UNSIGNED-PAYLOAD' };
  if (method === 'PUT') Object.assign(headers, { 'x-tos-acl': 'private', 'x-tos-storage-class': 'STANDARD' });
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map(name => `${name}:${headers[name]}`).join('\n');
  const canonical = `${method}\n${url.pathname}\n\n${canonicalHeaders}\n\n${names.join(';')}\n${headers['x-tos-content-sha256']}`;
  headers.Authorization = `TOS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature(config, date, scope, canonical)}`;
  delete headers.host; // fetch derives Host from the validated URL.
  if (method === 'PUT') headers['Content-Type'] = 'audio/wav';
  return { url: url.href, headers };
}

export function createTosStorage({ config, fetchImpl = globalThis.fetch, requestTimeoutMs = 300000 }) {
  validateTosConfig(config);
  async function send(method, key, audio, signal) {
    const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(method === 'DELETE' ? Math.min(requestTimeoutMs, 30000) : requestTimeoutMs)]);
    try {
      const { url, headers } = signedTosRequest({ config, key, method });
      const response = await fetchImpl(url, { method, headers, body: audio, signal: requestSignal, redirect: 'error' });
      await response.body?.cancel();
      if (!response.ok && !(method === 'DELETE' && response.status === 404)) {
        const message = response.status === 403 ? 'TOS 访问被拒绝，请检查存储密钥及存储桶读写、删除权限。' : response.status === 404 ? '找不到 TOS 存储桶，请检查桶名称和地域。' : 'TOS 临时音频处理失败，请稍后重试。';
        throw fail(message, `TOS_HTTP_${response.status}`);
      }
    } catch (error) {
      if (signal?.aborted) throw Object.assign(fail('文件转录已暂停，录音保留在本机。', 'TOS_ABORTED'), { name: 'AbortError' });
      if (error.code?.startsWith('TOS_')) throw error;
      throw fail('无法连接 TOS 临时存储，请检查网络和存储配置后重试。', 'TOS_NETWORK_ERROR');
    }
  }
  return {
    upload: (key, audio, signal) => send('PUT', key, audio, signal),
    remove: key => send('DELETE', key),
    downloadUrl: key => signedTosRequest({ config, key }).url,
  };
}
