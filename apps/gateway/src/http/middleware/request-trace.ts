/**
 * 请求级 trace 生命周期协调（otel 中间件 ↔ 后台终态收尾的唯一接线）。
 *
 * 不变量：一条请求一棵树、全部 span 落在根 span 时间窗内——因此根 span 的
 * 生命周期 = 响应体送完 ∧ 全部登记的后台收尾（流式结算等）完成，二者缺一都会
 * 产生「时窗逃逸」或「孤儿 trace」（2026-08-24 探针实证的两类缺陷）。
 *
 * - AsyncLocalStorage 携带 {根上下文, coordinator}：路由/推理链在根上下文内运行；
 * - 后台收尾经 TracePort.captureRoot() 拿根句柄（adapters/trace-port 消费本存储）：
 *   span 直挂根 span（不挂已结束的 upstream.attempt），并把任务计入 coordinator；
 * - wait 有界：收尾自身带重试预算，越界只闭合 span（观测面不阻塞数据面回收）。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Context } from '@tillgate/observability';

/** 后台收尾等待上界（结算信号重试预算之外的最后保险丝） */
export const TRACE_FINALIZE_BOUND_MS = 10_000;

/** 后台收尾注册表：任务 resolve/reject 都算完成（错误由任务自身上报 onError） */
export class RequestTraceCoordinator {
  private readonly pending = new Set<Promise<unknown>>();

  add(task: Promise<unknown>): void {
    const observed = task.catch(() => {});
    this.pending.add(observed);
    void observed.finally(() => {
      this.pending.delete(observed);
    });
  }

  /**
   * 等待全部登记任务完成（有界）。
   * graceTicks：启动宽限拍（setImmediate）——客户端取消时，取消回调（同步）先于
   * 中止传播链（pipeTo 拒绝 → 终态事件 → 结算登记，纯微任务）到达，空集快照会
   * 提前放行导致根 span 在结算登记前闭合（时窗逃逸）。流式收口路径传 ≥2；非流式
   * 路径恒空集，传 0 零延迟。
   */
  async wait(boundMs: number, graceTicks = 0): Promise<void> {
    const deadline = Date.now() + boundMs;
    let ticks = graceTicks;
    for (;;) {
      if (this.pending.size === 0) {
        if (ticks <= 0 || Date.now() >= deadline) return;
        ticks -= 1;
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        continue;
      }
      if (Date.now() >= deadline) return;
      const snapshot = [...this.pending];
      await Promise.race([
        Promise.allSettled(snapshot),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 50);
          timer.unref?.();
        }),
      ]);
    }
  }
}

export interface RequestTraceStore {
  /** 请求根 span 的 OTel 上下文（后台收尾 span 的父上下文） */
  readonly rootContext: Context;
  readonly coordinator: RequestTraceCoordinator;
}

/** 请求作用域存储：otel 中间件 run，内层（路由/推理/适配器）getStore 取用 */
export const requestTraceStorage = new AsyncLocalStorage<RequestTraceStore>();
