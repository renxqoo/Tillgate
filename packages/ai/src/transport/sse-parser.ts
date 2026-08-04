/**
 * SSE 增量解析（eventsource-parser 薄封装）：
 * 事件边界 / 注释行 / 多行 data / usage 最后帧胜出 / 错误帧捕获（骨架）
 */
// TODO(ai): createParser(onParse) 封装为增量扫描器：
//   - 维护 lastUsage（最后 usage 帧胜出）
//   - 记录首个 error 帧（code/type/detail）
//   - 透传所有事件到输出
export interface SseScanResult {
  usage: unknown | null;
  errorFrame: { code: string; type?: string; detail?: string } | null;
}
