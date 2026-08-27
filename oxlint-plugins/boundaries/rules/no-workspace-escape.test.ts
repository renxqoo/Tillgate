import { describe, expect, test } from 'bun:test';

import { lintProject, ruleCount, workspacePkg } from '../test/utils.ts';

const BASE = {
  'packages/dummy-a/package.json': workspacePkg('@tillgate/dummy-a', ['.']),
  'packages/dummy-a/src/shared.ts': 'export const s = 1;\n',
  'packages/dummy-b/package.json': workspacePkg('@tillgate/dummy-b', ['.']),
  'packages/dummy-b/src/deep/util.ts': 'export const u = 1;\n',
};

describe('boundaries/no-workspace-escape', () => {
  test('workspace 内的相对导入:无诊断', async () => {
    const { exitCode, stdout } = await lintProject(
      {
        ...BASE,
        'packages/dummy-b/src/deep/main.ts':
          "import { u } from './util';\nimport { s } from '../shared';\nexport const m = u + s;\n",
      },
      'packages/dummy-b/src/deep/main.ts',
    );
    expect(exitCode).toBe(0);
    expect(ruleCount(stdout, 'no-workspace-escape')).toBe(0);
  });

  test('相对导入越出 workspace 根:报 escape', async () => {
    const { exitCode, stdout } = await lintProject(
      {
        ...BASE,
        'packages/dummy-b/src/deep/main.ts':
          "import { s } from '../../../dummy-a/src/shared';\nexport const m = s;\n",
      },
      'packages/dummy-b/src/deep/main.ts',
    );
    expect(exitCode).toBe(1);
    expect(ruleCount(stdout, 'no-workspace-escape')).toBe(1);
    expect(stdout).toContain("'../../../dummy-a/src/shared' escapes the @tillgate/dummy-b");
  });

  test('指向 apps/ 的深路径导入:报 app-path', async () => {
    const { exitCode, stdout } = await lintProject(
      {
        ...BASE,
        'packages/dummy-b/src/main.ts':
          "import { x } from 'apps/app-x/src/index';\nexport const m = x;\n",
      },
      'packages/dummy-b/src/main.ts',
    );
    expect(exitCode).toBe(1);
    expect(ruleCount(stdout, 'no-workspace-escape')).toBe(1);
    expect(stdout).toContain('references the apps tree directly');
  });

  test('workspace 外的文件:不检查', async () => {
    const { exitCode, stdout } = await lintProject(
      {
        ...BASE,
        'scripts/tooling.ts': "import { s } from '../../packages/dummy-a/src/shared';\n",
      },
      'scripts/tooling.ts',
    );
    expect(exitCode).toBe(0);
    expect(ruleCount(stdout, 'no-workspace-escape')).toBe(0);
  });
});
