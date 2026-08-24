/**
 * 循环调度器（v1 index.ts 八定时器的结构化形态）：注册 → setInterval(unref)
 * → tick 错误隔离 → 停机宽限。语义口径（DESIGN §3.1）：
 *   - 无重入保护（v1 刻意设计）：上一轮未完成时新一轮照常触发——正确性完全
 *     下沉到 DB（认领 SKIP LOCKED + 租约 + CAS）；
 *   - 在途 Promise 用 Set 登记（多循环并发时单变量会互相覆盖——v1 教训）；
 *   - 每 tick 维护 lastStartedAt/lastResult 快照（/health 深度报告数据源）。
 */
export interface JobDefinition {
  name: string;
  intervalMs: number;
  run: () => Promise<unknown>;
}

export interface JobSnapshot {
  lastStartedAt: string | null;
  /** JSON-safe 结果摘要（计数/金额；异常路径为 null） */
  lastResult: unknown;
  lastError: string | null;
  lastFinishedAt: string | null;
}

export interface Scheduler {
  register(job: JobDefinition): void;
  start(): void;
  /** 拒新批次 → clear 全部定时器 → 在途宽限（allSettled race 宽限上界） */
  stop(): Promise<void>;
  isRunning(): boolean;
  /** 未启动/未触发的 job 为 null（深度报告区分「没跑过」与「跑过」） */
  snapshots(): Record<string, JobSnapshot | null>;
}

// eslint-disable-next-line max-lines-per-function -- 调度器闭包工厂:track/tick/生命周期方法共享 jobs/timers/inFlight 状态,拆分即状态上提或互相回读(存量棘轮)
export function createScheduler(deps: {
  graceMs: number;
  onError: (error: unknown, name: string) => void;
  now?: () => Date;
}): Scheduler {
  const now = deps.now ?? (() => new Date());
  const jobs: JobDefinition[] = [];
  const snapshots = new Map<string, JobSnapshot>();
  const timers: Array<ReturnType<typeof setInterval>> = [];
  const inFlight = new Set<Promise<unknown>>();
  let running = false;

  const track = (p: Promise<unknown>): void => {
    inFlight.add(p);
    void p.finally(() => {
      inFlight.delete(p);
    });
  };

  const tick = async (job: JobDefinition): Promise<void> => {
    // 快照对象常驻（lastError 粘滞——最近一次错误保留到下一次错误覆盖；
    // lastResult/lastFinishedAt 每轮刷新）——运维排障口径见 DESIGN §5
    const snapshot: JobSnapshot = snapshots.get(job.name) ?? {
      lastStartedAt: null,
      lastResult: null,
      lastError: null,
      lastFinishedAt: null,
    };
    snapshots.set(job.name, snapshot);
    snapshot.lastStartedAt = now().toISOString();
    try {
      snapshot.lastResult = await job.run();
    } catch (error) {
      snapshot.lastError = error instanceof Error ? error.message : String(error);
      deps.onError(error, job.name);
    } finally {
      snapshot.lastFinishedAt = now().toISOString();
    }
  };

  return {
    register(job) {
      jobs.push(job);
    },
    start() {
      if (running) return;
      running = true;
      for (const job of jobs) {
        // interval 到点即触发（无立即首跑——首扫由各 job 的兜底周期覆盖，v1 同款）
        const timer = setInterval(() => {
          if (!running) return;
          track(tick(job));
        }, job.intervalMs);
        timer.unref();
        timers.push(timer);
      }
    },
    async stop() {
      running = false;
      for (const timer of timers) clearInterval(timer);
      await Promise.race([
        Promise.allSettled(inFlight),
        new Promise<void>((resolve) => {
          setTimeout(resolve, Math.max(0, deps.graceMs)).unref();
        }),
      ]);
    },
    isRunning() {
      return running;
    },
    snapshots() {
      return Object.fromEntries(jobs.map((job) => [job.name, snapshots.get(job.name) ?? null]));
    },
  };
}
