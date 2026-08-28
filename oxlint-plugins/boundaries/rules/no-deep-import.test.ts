import { describe, expect, test } from 'bun:test';

import { lintProject, ruleCount, workspacePkg } from '../test/utils.ts';

const BASE = {
  'packages/dummy-a/package.json': workspacePkg('@tillgate/dummy-a', ['.', './composition']),
  'packages/dummy-a/src/index.ts': 'export const a = 1;\n',
  'packages/dummy-a/composition.ts': 'export const c = 1;\n',
  'apps/app-x/package.json': workspacePkg('@tillgate/app-x', ['.']),
  'apps/app-x/src/index.ts': 'export const x = 1;\n',
  'packages/dummy-b/package.json': workspacePkg('@tillgate/dummy-b', ['.']),
};

describe('boundaries/no-deep-import', () => {
  test('命中显式 exports 的根导入与子路径导入:无诊断', async () => {
    const { exitCode, stdout } = await lintProject(
      {
        ...BASE,
        'packages/dummy-b/src/main.ts':
          "import { a } from '@tillgate/dummy-a';\nimport { c } from '@tillgate/dummy-a/composition';\nexport const b = a + c;\n",
      },
      'packages/dummy-b/src/main.ts',
    );
    expect(exitCode).toBe(0);
    expect(ruleCount(stdout, 'no-deep-import')).toBe(0);
  });

  test('src 深导入:报 deep', async () => {
    const { exitCode, stdout } = await lintProject(
      {
        ...BASE,
        'packages/dummy-b/src/main.ts':
          "import { a } from '@tillgate/dummy-a/src/index';\nexport const b = a;\n",
      },
      'packages/dummy-b/src/main.ts',
    );
    expect(exitCode).toBe(1);
    expect(ruleCount(stdout, 'no-deep-import')).toBe(1);
    expect(stdout).toContain("'@tillgate/dummy-a/src/index' bypasses the explicit exports");
  });

  test('未登记子路径:报 deep', async () => {
    const { exitCode, stdout } = await lintProject(
      {
        ...BASE,
        'packages/dummy-b/src/main.ts':
          "import { c } from '@tillgate/dummy-a/composition';\nexport { c } from '@tillgate/dummy-a/missing';\n",
      },
      'packages/dummy-b/src/main.ts',
    );
    expect(exitCode).toBe(1);
    expect(ruleCount(stdout, 'no-deep-import')).toBe(1);
    expect(stdout).toContain("'@tillgate/dummy-a/missing' bypasses");
  });

  test('动态 import 深导入:同样报 deep', async () => {
    const { exitCode, stdout } = await lintProject(
      {
        ...BASE,
        'packages/dummy-b/src/main.ts':
          "export async function load() {\n  return import('@tillgate/dummy-a/src/index');\n}\n",
      },
      'packages/dummy-b/src/main.ts',
    );
    expect(exitCode).toBe(1);
    expect(ruleCount(stdout, 'no-deep-import')).toBe(1);
  });

  test('import 不存在的 workspace:报 unknown', async () => {
    const { exitCode, stdout } = await lintProject(
      {
        ...BASE,
        'packages/dummy-b/src/main.ts':
          "import { z } from '@tillgate/nope';\nexport const b = z;\n",
      },
      'packages/dummy-b/src/main.ts',
    );
    expect(exitCode).toBe(1);
    expect(ruleCount(stdout, 'no-deep-import')).toBe(1);
    expect(stdout).toContain("'@tillgate/nope' does not match any @tillgate/* workspace");
  });

  test('packages 里 import app 包:报 pkg-to-app;apps 里 import 包:合法', async () => {
    const pkgResult = await lintProject(
      {
        ...BASE,
        'packages/dummy-b/src/main.ts':
          "import { x } from '@tillgate/app-x';\nexport const b = x;\n",
      },
      'packages/dummy-b/src/main.ts',
    );
    expect(pkgResult.exitCode).toBe(1);
    expect(ruleCount(pkgResult.stdout, 'no-deep-import')).toBe(1);
    expect(pkgResult.stdout).toContain('Package @tillgate/dummy-b must not import app');

    const appResult = await lintProject(
      {
        ...BASE,
        'apps/app-x/src/page.ts': "import { a } from '@tillgate/dummy-a';\nexport const p = a;\n",
      },
      'apps/app-x/src/page.ts',
    );
    expect(appResult.exitCode).toBe(0);
    expect(ruleCount(appResult.stdout, 'no-deep-import')).toBe(0);
  });
});
