// @vitest-environment jsdom
/**
 * 登录三态表单规格（密码步 → TOTP/恢复码步 | 邮箱验证码步）：目录化拆分为
 * 编排器 + 自持验证步（与 client 端 LoginCodeStep 判例同构）后的行为等价回归。
 * 覆盖：三态切换、输入净化（TOTP 大写/去杂/截 10；邮箱码纯数字截 6）、
 * 提交门控（6 位数字|10 位字母数字 / 6 位数字）、验证步动作参数（TOTP 步的
 * email/password 是第一步校验后的快照）、跨步 code 卸载归零、错误信封 → toast。
 */
import '@testing-library/jest-dom/vitest';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';

import en from '../messages/en.json';

const loginAction = vi.fn();
const loginTotpAction = vi.fn();
const verifyLoginAction = vi.fn();

vi.mock('@/server/auth-actions', () => ({
  loginAction: (...args: unknown[]) => loginAction(...args),
  loginTotpAction: (...args: unknown[]) => loginTotpAction(...args),
  verifyLoginAction: (...args: unknown[]) => verifyLoginAction(...args),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { toast } from 'sonner';

import { LoginForm } from '../src/features/auth/login-form';

const CHALLENGE = '11111111-1111-4111-8111-111111111111';

function renderForm() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <LoginForm />
    </NextIntlClientProvider>,
  );
}

async function fillCredentials() {
  await userEvent.type(screen.getByLabelText('Email'), 'ops@example.test');
  await userEvent.type(screen.getByLabelText('Password'), 'secret-pass');
}

function signInButton() {
  return screen.getByRole('button', { name: 'Sign in' });
}

function verifyButton() {
  return screen.getByRole('button', { name: 'Verify and sign in' });
}

async function submitFirstStep() {
  await fillCredentials();
  await userEvent.click(signInButton());
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('LoginForm：三态切换与密码步', () => {
  it('默认渲染密码步（标题 + 邮箱/密码字段 + 提交钮）', () => {
    renderForm();
    expect(screen.getByText('Welcome to Tillgate')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveValue('');
    expect(screen.getByLabelText('Password')).toHaveValue('');
    expect(signInButton()).toBeEnabled();
  });

  it('空提交被 zod 拦截：双字段报错且不触发 loginAction', async () => {
    renderForm();
    await userEvent.click(signInButton());
    expect(await screen.findByText('Enter a valid email')).toBeInTheDocument();
    expect(screen.getByText('Enter a password')).toBeInTheDocument();
    expect(loginAction).not.toHaveBeenCalled();
  });

  it('loginAction 返回 error 信封 → toast 失败提示，停留密码步', async () => {
    loginAction.mockResolvedValueOnce({ error: 'Invalid credentials' });
    renderForm();
    await submitFirstStep();
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Sign-in failed', {
        description: 'Invalid credentials',
      }),
    );
    expect(screen.getByText('Welcome to Tillgate')).toBeInTheDocument();
  });
});

describe('TotpStep：TOTP/恢复码步', () => {
  it('totpRequired → 进入 TOTP 步；输入净化为大写字母数字并截 10', async () => {
    loginAction.mockResolvedValueOnce({ totpRequired: true });
    renderForm();
    await submitFirstStep();
    expect(await screen.findByText('Authenticator verification')).toBeInTheDocument();

    const input = screen.getByLabelText('Authenticator code / recovery code');
    await userEvent.type(input, 'ab1-cd2 ef3g4h5');
    // toUpperCase → 去非 [A-Z0-9] → 截 10：AB1CD2EF3G4H5 → AB1CD2EF3G
    expect(input).toHaveValue('AB1CD2EF3G');
  });

  it('提交门控：仅 6 位数字或 10 位字母数字可提交', async () => {
    loginAction.mockResolvedValueOnce({ totpRequired: true });
    renderForm();
    await submitFirstStep();
    const input = await screen.findByLabelText('Authenticator code / recovery code');

    await userEvent.type(input, '12345');
    expect(verifyButton()).toBeDisabled();
    await userEvent.type(input, '6');
    expect(verifyButton()).toBeEnabled();

    await userEvent.clear(input);
    await userEvent.type(input, 'ABCDEF');
    expect(verifyButton()).toBeDisabled();
    await userEvent.type(input, 'GHIJ');
    expect(verifyButton()).toBeEnabled();
  });

  it('TOTP 提交携带第一步凭证快照 (email, password, code)', async () => {
    loginAction.mockResolvedValueOnce({ totpRequired: true });
    renderForm();
    await submitFirstStep();
    const input = await screen.findByLabelText('Authenticator code / recovery code');
    await userEvent.type(input, '123456');
    await userEvent.click(verifyButton());
    await waitFor(() =>
      expect(loginTotpAction).toHaveBeenCalledWith('ops@example.test', 'secret-pass', '123456'),
    );
  });

  it('返回回密码步；表单凭证保留可直接重提', async () => {
    loginAction.mockResolvedValueOnce({ totpRequired: true });
    renderForm();
    await submitFirstStep();
    await screen.findByText('Authenticator verification');
    await userEvent.click(screen.getByRole('button', { name: 'Back to sign in' }));
    expect(await screen.findByText('Welcome to Tillgate')).toBeInTheDocument();
  });
});

describe('EmailCodeStep：邮箱验证码步', () => {
  it('challengeId → 进入邮箱验证码步；输入净化为纯数字并截 6', async () => {
    loginAction.mockResolvedValueOnce({ challengeId: CHALLENGE });
    renderForm();
    await submitFirstStep();
    expect(await screen.findByText('Email verification code')).toBeInTheDocument();

    const input = screen.getByLabelText('6-digit code');
    await userEvent.type(input, '1a2b3c45678');
    // 非数字剔除 → 截 6：12345678 → 123456
    expect(input).toHaveValue('123456');
  });

  it('提交门控：6 位数字才可提交；verifyLoginAction 携带 (challenge, code)', async () => {
    loginAction.mockResolvedValueOnce({ challengeId: CHALLENGE });
    renderForm();
    await submitFirstStep();
    const input = await screen.findByLabelText('6-digit code');

    await userEvent.type(input, '12345');
    expect(verifyButton()).toBeDisabled();
    await userEvent.type(input, '6');
    expect(verifyButton()).toBeEnabled();

    await userEvent.click(verifyButton());
    await waitFor(() => expect(verifyLoginAction).toHaveBeenCalledWith(CHALLENGE, '123456'));
  });
});

describe('跨步状态归零（验证步自持 code，卸载即清）', () => {
  it('TOTP 步输入后返回再进邮箱验证码步：code 为空', async () => {
    loginAction
      .mockResolvedValueOnce({ totpRequired: true })
      .mockResolvedValueOnce({ challengeId: CHALLENGE });
    renderForm();
    await submitFirstStep();
    const totpInput = await screen.findByLabelText('Authenticator code / recovery code');
    await userEvent.type(totpInput, 'ab1');

    await userEvent.click(screen.getByRole('button', { name: 'Back to sign in' }));
    await screen.findByText('Welcome to Tillgate');
    // 密码步凭证保留（form 状态未卸载），直接重提进入邮箱验证码步
    await userEvent.click(signInButton());
    const codeInput = await screen.findByLabelText('6-digit code');
    expect(codeInput).toHaveValue('');
  });
});
