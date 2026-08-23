/**
 * 音频时长估算（秒，向上取整）——audio_transcription/translation 按秒计费的计量源。
 *
 * WAV：RIFF 头精确（data 块大小 ÷ 字节率）。
 * MP3：首帧头解析位率 → 文件大小 ÷ 位率（CBR 近似；VBR 偏差可接受——估算仅用于计费下界）。
 * 其它/无法识别：保守估算（16KB/s，语音电话质量下限）——宁可高估不漏收。
 */

export function estimateAudioDurationSeconds(bytes: Uint8Array): number {
  if (bytes.length < 16) return 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // WAV：'RIFF' .... 'WAVE'
  if (
    view.getUint32(0, false) === 0x52494646 && // RIFF
    view.getUint32(8, false) === 0x57415645 // WAVE
  ) {
    // 逐块找 fmt（字节率 byteRate）与 data（大小）
    let offset = 12;
    let byteRate = 0;
    let dataSize = 0;
    while (offset + 8 <= bytes.byteLength) {
      const chunkId = view.getUint32(offset, false);
      const chunkSize = view.getUint32(offset + 4, true);
      if (chunkId === 0x666d7420)
        byteRate = view.getUint32(offset + 16, true); // 'fmt '
      else if (chunkId === 0x64617461) dataSize = chunkSize; // 'data'
      offset += 8 + chunkSize + (chunkSize % 2);
      if (byteRate > 0 && dataSize > 0) break;
    }
    if (byteRate > 0 && dataSize > 0) {
      return Math.max(1, Math.ceil(dataSize / byteRate));
    }
  }

  // MP3：ID3 头跳过后找帧同步 0xFFEx
  let start = 0;
  if (
    view.getUint32(0, false) === 0x49443300 ||
    (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33)
  ) {
    const tagSize = (bytes[6]! << 21) | (bytes[7]! << 14) | (bytes[8]! << 7) | bytes[9]!;
    start = 10 + tagSize;
  }
  for (let i = start; i < Math.min(bytes.length - 4, start + 8192); i++) {
    if (bytes[i] === 0xff && (bytes[i + 1]! & 0xe0) === 0xe0) {
      const bitrateVersion = (bytes[i + 1]! >> 3) & 0x03; // 00=2.5 01=保留 10=2 11=1
      if (bitrateVersion === 0x01) continue;
      const bitrateIndex = (bytes[i + 2]! >> 4) & 0x0f;
      // MPEG1 LayerIII / MPEG2 LayerIII 位率表（kbps）
      const table1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
      const table2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
      const kbps = (bitrateVersion === 0x03 ? table1 : table2)[bitrateIndex] ?? 0;
      if (kbps > 0) {
        const bytesPerSecond = (kbps * 1000) / 8;
        return Math.max(1, Math.ceil((bytes.length - start) / bytesPerSecond));
      }
    }
  }

  // 保守兜底：16KB/s（8kbps 低码率语音的近似下限——高估保证不漏收）
  return Math.max(1, Math.ceil(bytes.length / 16_384));
}
