import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// boundaries 插件测试 harness:在临时目录拼一个最小 monorepo
// (packages/*/package.json + 源文件),用真实 oxlint + 本插件 lint 指定文件,
// 断言完即清理。files 为相对临时根的「路径 → 内容」表。
const pluginDir = join(import.meta.dir, '..');
const oxlintBin = join(pluginDir, '../../node_modules/.bin/oxlint');

export interface LintResult {
  exitCode: number | null;
  stdout: string;
}

export async function lintProject(
  files: Record<string, string>,
  lintTarget: string,
): Promise<LintResult> {
  const root = mkdtempSync(join(tmpdir(), 'boundaries-oxlint-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = join(root, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    const config = {
      jsPlugins: [join(pluginDir, 'index.ts')],
      rules: {
        'boundaries/no-deep-import': 'error',
        'boundaries/no-workspace-escape': 'error',
      },
    };
    writeFileSync(join(root, '.oxlintrc.json'), JSON.stringify(config));
    const proc = Bun.spawn([oxlintBin, '-c', '.oxlintrc.json', lintTarget], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    return { exitCode: await proc.exited, stdout };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function ruleCount(stdout: string, rule: string): number {
  return stdout.split(`boundaries(${rule})`).length - 1;
}

/** 生成一个带显式 exports 的 workspace package.json 内容 */
export function workspacePkg(name: string, exports: string[]): string {
  const exp: Record<string, string> = {};
  for (const sub of exports) exp[sub] = `./dist/${sub === '.' ? 'index' : sub.slice(2)}.js`;
  return JSON.stringify({ name, private: true, exports: exp });
}
