import test from 'node:test';
import assert from 'node:assert/strict';
import { signedTosRequest, createTosStorage, TOS_PREFIX } from '../server/import/tos.js';

const config = { region: 'cn-beijing', bucket: 'test-bucket', accessKeyId: 'test-access-key', accessKeySecret: 'test-secret-key' };
const key = `${TOS_PREFIX}12345678-1234-1234-1234-123456789abc.wav`;

test('presigned download matches the official TOS Signature V4 reference', () => {
  // Reference: official ve-tos-js-sdk 2.9.1 SignersV4, region cn-beijing.
  const { url } = signedTosRequest({ config, key, now: new Date('2026-10-13T06:07:09Z') });
  const parsed = new URL(url);
  assert.equal(parsed.host, 'test-bucket.tos-cn-beijing.volces.com');
  assert.equal(parsed.searchParams.get('X-Tos-Signature'), '54b8ecfd1a08d545be64ee0fc45a2427f37587d9626ff01767ea593c85074adc');
  assert.equal(parsed.searchParams.get('X-Tos-Expires'), '86400');
  assert.ok(!url.includes(config.accessKeySecret));
});

test('uploads are private standard storage; delete is confined to the same random temporary object', async () => {
  const calls = [];
  const store = createTosStorage({ config, fetchImpl: async (url, request) => {
    calls.push(request.method);
    assert.equal(request.redirect, 'error');
    assert.equal(url, `https://test-bucket.tos-cn-beijing.volces.com/${key}`);
    assert.match(request.headers.Authorization, /Credential=test-access-key\/\d{8}\/cn-beijing\/tos\/request/);
    if (request.method === 'PUT') {
      assert.equal(request.headers['x-tos-acl'], 'private');
      assert.equal(request.headers['x-tos-storage-class'], 'STANDARD');
      assert.match(request.headers.Authorization, /SignedHeaders=host;x-tos-acl;x-tos-content-sha256;x-tos-date;x-tos-storage-class/);
      assert.equal(request.headers['Content-Type'], 'audio/wav');
      assert.deepEqual(request.body, Buffer.from('audio'));
    } else assert.equal(request.body, undefined);
    return new Response(null, { status: request.method === 'DELETE' ? 404 : 200 });
  } });
  await store.upload(key, Buffer.from('audio'));
  await store.remove(key);
  assert.deepEqual(calls, ['PUT', 'DELETE']);
  await assert.rejects(store.remove('../unrelated-object'), /存储记录无效/);
});

test('invalid endpoint inputs are rejected and provider bodies cannot leak credentials', async () => {
  for (const patch of [{ bucket: 'bucket/path' }, { region: 'cn-beijing.invalid/' }, { accessKeySecret: '' }]) {
    assert.throws(() => createTosStorage({ config: { ...config, ...patch } }), /TOS|存储/);
  }
  for (const fetchImpl of [async () => new Response(config.accessKeySecret, { status: 403 }), async () => { throw new Error(config.accessKeySecret); }]) {
    const store = createTosStorage({ config, fetchImpl });
    await assert.rejects(store.upload(key, Buffer.from('audio')), error => !error.message.includes(config.accessKeySecret) && /TOS/.test(error.message));
  }
});
