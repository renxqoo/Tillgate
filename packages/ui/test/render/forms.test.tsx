import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { Field, FieldError, FieldLabel, Input, PasswordInput } from '../../src/index';

describe('PasswordInput', () => {
  // 注意: input[type=password] 没有隐式 textbox 角色, 统一用 placeholder 定位
  it('默认 type=password 遮蔽输入', () => {
    render(<PasswordInput name="pw" placeholder="密码" />);
    expect(screen.getByPlaceholderText('密码')).toHaveAttribute('type', 'password');
  });

  it('点击切换 type 并联动 aria 状态', async () => {
    render(<PasswordInput name="pw" placeholder="密码" />);
    const input = screen.getByPlaceholderText('密码');
    const toggle = screen.getByRole('button', { name: 'Show password' });
    await userEvent.click(toggle);
    expect(input).toHaveAttribute('type', 'text');
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(input).toHaveAttribute('type', 'password');
  });

  it('aria-label 文案可注入', () => {
    render(<PasswordInput name="pw" showLabel="显示密码" hideLabel="隐藏密码" />);
    expect(screen.getByRole('button', { name: '显示密码' })).toBeInTheDocument();
  });

  it('透传 input 属性(placeholder/name)', () => {
    render(<PasswordInput name="token" placeholder="输入令牌" />);
    expect(screen.getByPlaceholderText('输入令牌')).toHaveAttribute('name', 'token');
  });
});

describe('Field + Input 组合', () => {
  it('label 关联与错误渲染', async () => {
    render(
      <Field>
        <FieldLabel>预算</FieldLabel>
        <Input name="budget" aria-invalid />
        <FieldError errors={[{ message: '超出余额' }]} />
      </Field>,
    );
    expect(screen.getByText('预算')).toBeInTheDocument();
    expect(await screen.findByText('超出余额')).toBeInTheDocument();
  });
});
