import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 规则测试 harness(参考 t3code 的方式):不落 fixtures 文件,
// 每个用例在临时目录写入样本 .tsx 与最小 lint 配置(绝对路径指回本插件),
// 拉起仓库安装的真实 oxlint CLI 断言诊断与退出码,结束后清理临时目录。
const pluginDir = join(import.meta.dir, '..');
const oxlintBin = join(pluginDir, '../../node_modules/.bin/oxlint');

export interface LintResult {
  exitCode: number | null;
  stdout: string;
}

export async function lintSample(code: string): Promise<LintResult> {
  const dir = mkdtempSync(join(tmpdir(), 'tillgate-oxlint-'));
  try {
    const config = {
      jsPlugins: [join(pluginDir, 'index.ts')],
      rules: { 'tillgate/no-multi-component': 'error' },
    };
    writeFileSync(join(dir, 'sample.tsx'), code);
    writeFileSync(join(dir, 'oxlintrc.json'), JSON.stringify(config));
    const proc = Bun.spawn([oxlintBin, '-c', 'oxlintrc.json', 'sample.tsx'], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    return { exitCode: await proc.exited, stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function ruleCount(stdout: string, rule: string): number {
  return stdout.split(`tillgate(${rule})`).length - 1;
}
