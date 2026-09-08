import zlib from "node:zlib";
const MAX_PAYLOAD_BYTES = 1_048_576;

export function buildAsrHeaders(config, connectId) {
  const headers = {
    "X-Api-Resource-Id": config.resourceId,
    "X-Api-Connect-Id": connectId,
  };
  if (config.apiKey) headers["X-Api-Key"] = config.apiKey;
  else {
    headers["X-Api-App-Key"] = config.appKey;
    headers["X-Api-Access-Key"] = config.accessKey;
  }
  return headers;
}

export function buildFullClientRequest() {
  const payload = {
    user: { uid: "meeting-workbench", platform: "web" },
    audio: { format: "pcm", codec: "raw", rate: 16000, bits: 16, channel: 1 },
    request: {
      model_name: "bigmodel",
      enable_nonstream: true,
      enable_itn: true,
      enable_punc: true,
      enable_ddc: false,
      show_utterances: true,
      result_type: "single",
      enable_speaker_info: true,
      ssd_version: "200",
      end_window_size: 800,
    },
  };
  return buildClientMessage({
    messageType: 0x1,
    flags: 0x0,
    serialization: 0x1,
    compression: 0x1,
    payload: Buffer.from(JSON.stringify(payload), "utf8"),
  });
}

export function buildAudioRequest(audioBuffer, isFinal) {
  // PCM 帧每 100ms 一发且几乎不可压缩，逐帧 gzip 只浪费 CPU；
  // 协议头按消息声明压缩方式，音频帧走 0x0（不压缩）。
  return buildClientMessage({
    messageType: 0x2,
    flags: isFinal ? 0x2 : 0x0,
    serialization: 0x0,
    compression: 0x0,
    payload: audioBuffer,
  });
}

function buildClientMessage({ messageType, flags, serialization, compression, payload }) {
  const compressedPayload = compression === 0x1 ? zlib.gzipSync(payload) : payload;
  const header = Buffer.from([
    0x11,
    (messageType << 4) | flags,
    (serialization << 4) | compression,
    0x00,
  ]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(compressedPayload.length);
  return Buffer.concat([header, size, compressedPayload]);
}

export function parseServerMessage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) throw new Error("ASR response is too short");
  const headerSize = (buffer[0] & 0x0f) * 4;
  const messageType = buffer[1] >> 4;
  const flags = buffer[1] & 0x0f;
  const serialization = buffer[2] >> 4;
  const compression = buffer[2] & 0x0f;
  let offset = headerSize;
  if (headerSize < 4 || offset + 4 > buffer.length) throw new Error("Invalid ASR response header");

  if (messageType === 0xf) {
    if (offset + 8 > buffer.length) throw new Error("Invalid ASR error response");
    const code = buffer.readUInt32BE(offset);
    offset += 4;
    const size = buffer.readUInt32BE(offset);
    offset += 4;
    if (offset + size > buffer.length) throw new Error("Invalid ASR error payload size");
    if (size > MAX_PAYLOAD_BYTES) throw new Error("ASR payload exceeds 1MB");
    return { type: "error", code, message: buffer.subarray(offset, offset + size).toString("utf8") };
  }
  if (messageType !== 0x9) return { type: "unknown", messageType };

  let sequence = null;
  if (flags === 0x1 || flags === 0x3) {
    if (offset + 4 > buffer.length) throw new Error("Invalid ASR sequence");
    sequence = buffer.readInt32BE(offset);
    offset += 4;
  }
  if (offset + 4 > buffer.length) throw new Error("Invalid ASR payload header");
  const size = buffer.readUInt32BE(offset);
  offset += 4;
  if (offset + size > buffer.length) throw new Error("Invalid ASR payload size");
  if (size > MAX_PAYLOAD_BYTES) throw new Error("ASR payload exceeds 1MB");
  let payload = buffer.subarray(offset, offset + size);
  if (compression === 0x1) {
    try {
      payload = zlib.gunzipSync(payload, { maxOutputLength: MAX_PAYLOAD_BYTES });
    } catch (error) {
      if (
        error?.code === "ERR_BUFFER_TOO_LARGE" ||
        /output length|too large/i.test(String(error?.message || ""))
      ) {
        throw new Error("ASR payload exceeds 1MB");
      }
      throw error;
    }
  }
  if (serialization === 0x1) payload = JSON.parse(payload.toString("utf8"));
  return { type: "response", flags, sequence, payload };
}

export function normalizeAsrResult(payload) {
  const result = Array.isArray(payload?.result) ? payload.result[0] : payload?.result;
  const utterances = Array.isArray(result?.utterances)
    ? result.utterances.map((item) => ({
        text: item.text || "",
        startTime: utteranceTime(item, "start_time"),
        endTime: utteranceTime(item, "end_time"),
        definite: Boolean(item.definite),
        speaker: getSpeakerId(item),
      }))
    : [];
  return { text: result?.text || "", utterances };
}

function utteranceTime(utterance, field) {
  const valid = value => Number.isFinite(value) && value >= 0 ? value : undefined;
  const explicit = valid(utterance[field]);
  if (explicit !== undefined) return explicit;
  const words = Array.isArray(utterance.words) ? utterance.words : [];
  // Some ASR responses omit a sentence boundary while returning word timing.
  // Only the actual first/last word can establish that boundary: an interior
  // word or an assumed zero would point playback at the wrong part of speech.
  const boundaryWord = field === "start_time" ? words[0] : words.at(-1);
  return valid(boundaryWord?.[field]);
}

function getSpeakerId(utterance) {
  const additions = utterance?.additions || {};
  return [utterance?.speaker, utterance?.speaker_id, utterance?.speakerId,
    additions?.speaker, additions?.speaker_id, additions?.speakerId]
    .find(value => value === 0 || value) ?? "";
}
