/**
 * 全局心跳/静默扫描器（S2 修复）：单一 interval 扫描活跃流注册表，
 * 替代 v1 每流一个 setInterval（万级流 = 4 万次/秒定时器唤醒）。
 * check() 由 relay-stream 注册：返回 false 表示流已结束，自动注销。
 */

interface SweeperEntry {
  check: () => boolean; // 执行一次检查；false = 注销
}

const entries: SweeperEntry[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
const INTERVAL_MS = 250;

function sweep(): void {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    let alive = false;
    if (entry !== undefined) {
      try {
        alive = entry.check();
      } catch {
        alive = false;
      }
    }
    if (!alive) entries.splice(i, 1);
  }
  if (entries.length === 0 && timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

/** 注册周期检查；返回注销函数（流结束时必须调用或由 check 返回 false 自动注销） */
export function registerSweep(check: () => boolean): () => void {
  const entry: SweeperEntry = { check };
  entries.push(entry);
  if (timer === null) timer = setInterval(sweep, INTERVAL_MS);
  let unregistered = false;
  return () => {
    if (unregistered) return;
    unregistered = true;
    const i = entries.indexOf(entry);
    if (i >= 0) entries.splice(i, 1);
  };
}
