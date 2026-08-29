import { describe, expect, test } from 'bun:test';

import { lintSample, ruleCount } from '../test/utils.ts';

describe('multi-component/no-multi-component', () => {
  test('两个组件同文件:第二个组件报 exceed', async () => {
    const { exitCode, stdout } = await lintSample(`export function First() {
  return <div />;
}

export function Second() {
  return <section />;
}
`);
    expect(exitCode).toBe(1);
    expect(ruleCount(stdout, 'no-multi-component')).toBe(1);
    expect(stdout).toContain("'Second' is component/hook #2 in this file (after 'First')");
  });

  test('组件与 hook 同文件:hook 报 exceed', async () => {
    const { exitCode, stdout } = await lintSample(`export function Panel() {
  return <div />;
}

export function usePanel() {
  return null;
}
`);
    expect(exitCode).toBe(1);
    expect(ruleCount(stdout, 'no-multi-component')).toBe(1);
    expect(stdout).toContain("'usePanel' is component/hook #2 in this file (after 'Panel')");
  });

  test('嵌套定义组件:报 nested', async () => {
    const { exitCode, stdout } = await lintSample(`export function Shell() {
  function Badge() {
    return <span />;
  }
  return <Badge />;
}
`);
    expect(exitCode).toBe(1);
    expect(ruleCount(stdout, 'no-multi-component')).toBe(1);
    expect(stdout).toContain("'Badge' is defined inside 'Shell'");
  });

  test('单组件文件:无诊断', async () => {
    const { exitCode, stdout } = await lintSample(`export function Only() {
  return <div />;
}

export const ONLY_LABEL = 'only';
`);
    expect(exitCode).toBe(0);
    expect(ruleCount(stdout, 'no-multi-component')).toBe(0);
  });
});
