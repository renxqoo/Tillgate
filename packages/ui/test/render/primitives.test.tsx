// primitives 冒烟: 核心原子渲染 + 交互; 完整交互矩阵由 vendored base-nova 上游保障
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  Avatar,
  AvatarFallback,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Spinner,
  ThemeProvider,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useTheme,
} from '../../src/index';

describe('Button', () => {
  it('渲染默认变体并响应点击', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>保存</Button>);
    const button = screen.getByRole('button', { name: '保存' });
    expect(button).toBeInTheDocument();
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('disabled 不触发点击', async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        提交
      </Button>,
    );
    await userEvent.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('Badge / Card / Avatar / Spinner', () => {
  it('Badge 渲染内容与变体 class', () => {
    const { container } = render(<Badge variant="secondary">active</Badge>);
    expect(container.textContent).toBe('active');
    expect(container.firstElementChild?.className).toContain('bg-secondary');
  });

  it('Card 各分区渲染', () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>标题</CardTitle>
          <CardDescription>描述</CardDescription>
        </CardHeader>
        <CardContent>内容</CardContent>
      </Card>,
    );
    expect(screen.getByText('标题')).toBeInTheDocument();
    expect(screen.getByText('描述')).toBeInTheDocument();
    expect(screen.getByText('内容')).toBeInTheDocument();
  });

  it('Avatar 回退块渲染', () => {
    render(
      <Avatar>
        <AvatarFallback>TL</AvatarFallback>
      </Avatar>,
    );
    expect(screen.getByText('TL')).toBeInTheDocument();
  });

  it('Spinner 带 Loading 状态语义', () => {
    render(<Spinner />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Loading');
  });
});

describe('Tooltip', () => {
  it('触发器渲染(浮层交互由上游保障)', () => {
    render(
      <Tooltip>
        <TooltipTrigger render={<Button>hover</Button>} />
        <TooltipContent>提示内容</TooltipContent>
      </Tooltip>,
    );
    expect(screen.getByRole('button', { name: 'hover' })).toBeInTheDocument();
  });
});

function ThemeProbe() {
  const { theme, setTheme } = useTheme();
  return <button onClick={() => setTheme('dark')}>current:{theme}</button>;
}

function NakedThemeProbe() {
  useTheme();
  return null;
}

describe('ThemeProvider', () => {
  it('useTheme 在 Provider 内可用且 setTheme 生效', async () => {
    render(
      <ThemeProvider defaultTheme="light">
        <ThemeProbe />
      </ThemeProvider>,
    );
    expect(screen.getByRole('button', { name: 'current:light' }));
    await userEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('button', { name: 'current:dark' }));
  });

  it('useTheme 在 Provider 外抛错', () => {
    // 直接渲染裸组件验证契约: 未包 Provider 必须显式失败
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<NakedThemeProbe />)).toThrow(/ThemeProvider/);
    consoleError.mockRestore();
  });
});
