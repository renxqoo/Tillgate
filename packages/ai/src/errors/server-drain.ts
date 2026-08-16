/**
 * 服务端主动中止标记（drain 语义）：gateway 优雅停机时在宽限期结束后
 * abort 在途请求预算，abort reason 携带本标记。传输层据此把终态归类为
 * 服务端原因（server_draining），而非用户取消（request_cancelled）——
 * 两者计费归属不同：用户取消按已透传字节估算结算，服务端中止全额释放。
 */
export class ServerDrainAbort extends Error {
  readonly serverDraining = true;
  constructor(message = 'gateway draining') {
    super(message);
    this.name = 'ServerDrainAbort';
  }
}

/** 判定 abort 信号是否为服务端 drain 中止（null = 非该类中止） */
export function asServerDrainAbort(reason: unknown): ServerDrainAbort | null {
  return reason instanceof ServerDrainAbort ? reason : null;
}
