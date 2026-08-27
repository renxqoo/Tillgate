/**
 * 音频时长估算（秒，向上取整）——audio_transcription/translation 按秒计费的计量源。
 *
 * WAV：RIFF 头逐块遍历（data 实际字节 ÷ 字节率）——声明值不可信：
 *   data 尺寸按文件实际字节收敛、字节率按上界钳制（伪造头只能高估不能少计）。
 * MP3：前 8KB 内多帧头位率取中位 → 文件大小 ÷ 位率（VBR/伪造首帧不放大偏差；
 *   位率表上界 320kbps 即少计的硬下界）。
 * 其它/无法识别：保守估算（16KB/s，语音电话质量下限）——宁可高估不漏收。
 */

/** WAV 字节率可信上界（4MB/s 覆盖 192kHz/8ch/24bit 专业形态；更高只存在于伪造头） */
const WAV_BYTE_RATE_CAP = 4 * 1024 * 1024;

/** WAV：'RIFF' 头精确时长；非 WAV 或块缺失 → undefined（字节下标越界按 0 参与位运算，与原实现一致） */
function wavDurationSeconds(bytes: Uint8Array, view: DataView): number | undefined {
  if (
    view.getUint32(0, false) !== 0x52494646 || // RIFF
    view.getUint32(8, false) !== 0x57415645 // WAVE
  ) {
    return undefined;
  }
  // 逐块找 fmt（字节率 byteRate）与 data（实际字节）
  let offset = 12;
  let byteRate = 0;
  let dataBytes = 0;
  while (offset + 8 <= bytes.byteLength) {
    const chunkId = view.getUint32(offset, false);
    const chunkSize = view.getUint32(offset + 4, true);
    if (chunkId === 0x666d7420) {
      byteRate = view.getUint32(offset + 16, true);
    } // 'fmt '
    else if (chunkId === 0x64617461) {
      // 声明尺寸按文件实际字节收敛（伪造大/小 chunkSize 都不改变计量事实）
      const actual = Math.min(chunkSize, bytes.byteLength - (offset + 8));
      dataBytes = Math.max(dataBytes, Math.max(0, actual));
    } // 'data'
    offset += 8 + chunkSize + (chunkSize % 2);
    if (byteRate > 0 && dataBytes > 0) break;
  }
  if (byteRate > 0 && dataBytes > 0) {
    return Math.max(1, Math.ceil(dataBytes / Math.min(byteRate, WAV_BYTE_RATE_CAP)));
  }
  return undefined;
}

/** ID3v2 头跳过字节数（无 ID3 头 → 0） */
function id3SkipBytes(bytes: Uint8Array, view: DataView): number {
  if (
    view.getUint32(0, false) !== 0x49443300 &&
    !(bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33)
  ) {
    return 0;
  }
  // syncsafe 整数：每字节低 7 位（<<21/14/7/0）
  const tagSize =
    ((bytes[6] ?? 0) << 21) | ((bytes[7] ?? 0) << 14) | ((bytes[8] ?? 0) << 7) | (bytes[9] ?? 0);
  return 10 + tagSize;
}

// MPEG1 / MPEG2 LayerIII 位率表（kbps；索引 0/15 为非法 → 0）
const MP3_BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MP3_BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];

/** MP3 帧头位率解析（kbps）；帧同步未命中/版本保留位/索引非法 → 0 */
function mp3FrameKbps(bytes: Uint8Array, i: number): number {
  if (bytes[i] !== 0xff || ((bytes[i + 1] ?? 0) & 0xe0) !== 0xe0) return 0;
  const bitrateVersion = ((bytes[i + 1] ?? 0) >> 3) & 0x03; // 00=2.5 01=保留 10=2 11=1
  if (bitrateVersion === 0x01) return 0;
  const bitrateIndex = ((bytes[i + 2] ?? 0) >> 4) & 0x0f;
  return (bitrateVersion === 0x03 ? MP3_BITRATES_V1 : MP3_BITRATES_V2)[bitrateIndex] ?? 0;
}

/** MP3：前 8KB 多帧头位率中位 → 文件大小 ÷ 位率；未识别 → undefined */
function mp3DurationSeconds(bytes: Uint8Array, view: DataView): number | undefined {
  const start = id3SkipBytes(bytes, view);
  const rates: number[] = [];
  for (let i = start; i < Math.min(bytes.length - 4, start + 8192) && rates.length < 32; i++) {
    const kbps = mp3FrameKbps(bytes, i);
    if (kbps > 0) rates.push(kbps);
  }
  if (rates.length === 0) return undefined;
  rates.sort((a, b) => a - b);
  const medianKbps = rates[rates.length >> 1] ?? rates[0];
  if (medianKbps == null || medianKbps <= 0) return undefined;
  const bytesPerSecond = (medianKbps * 1000) / 8;
  return Math.max(1, Math.ceil((bytes.length - start) / bytesPerSecond));
}

export function estimateAudioDurationSeconds(bytes: Uint8Array): number {
  if (bytes.length < 16) return 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const wav = wavDurationSeconds(bytes, view);
  if (wav !== undefined) return wav;
  const mp3 = mp3DurationSeconds(bytes, view);
  if (mp3 !== undefined) return mp3;
  // 保守兜底：16KB/s（8kbps 低码率语音的近似下限——高估保证不漏收）
  return Math.max(1, Math.ceil(bytes.length / 16_384));
}
