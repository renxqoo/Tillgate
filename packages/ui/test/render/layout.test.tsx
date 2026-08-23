import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import {
  AuthShell,
  ListContent,
  ListFooter,
  ListPanel,
  ListToolbar,
  ListToolbarGroup,
  PageHeader,
  RowActions,
  DropdownMenuItem,
} from '../../src/index';

describe('PageHeader', () => {
  it('渲染标题、说明、图标、元信息和页面动作', () => {
    render(
      <PageHeader
        title="用户管理"
        description="管理用户与余额"
        icon={<span>U</span>}
        meta={<span>128 条</span>}
        actions={<button type="button">新建用户</button>}
      />,
    );

    expect(screen.getByRole('heading', { name: '用户管理' })).toBeInTheDocument();
    expect(screen.getByText('管理用户与余额')).toBeInTheDocument();
    expect(screen.getByText('128 条')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新建用户' })).toBeInTheDocument();
  });
});

describe('AuthShell', () => {
  it('保持表单与品牌说明为独立语义区域', () => {
    render(
      <AuthShell
        brand={<a href="/">TokenLens</a>}
        asideIcon={<span>S</span>}
        asideTitle="统一模型网关"
        asideDescription="一个账户连接所有模型"
      >
        <form aria-label="登录表单" />
      </AuthShell>,
    );

    expect(screen.getByRole('main')).toHaveAttribute('data-slot', 'auth-shell');
    expect(screen.getByRole('link', { name: 'TokenLens' })).toBeInTheDocument();
    expect(screen.getByRole('form', { name: '登录表单' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '统一模型网关' })).toBeInTheDocument();
  });
});

describe('ListPanel', () => {
  it('组合工具栏、内容与分页区', () => {
    render(
      <ListPanel>
        <ListToolbar>
          <ListToolbarGroup>搜索</ListToolbarGroup>
        </ListToolbar>
        <ListContent>列表</ListContent>
        <ListFooter>分页</ListFooter>
      </ListPanel>,
    );

    expect(document.querySelector('[data-slot="list-panel"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="list-toolbar"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="list-content"]')).toHaveTextContent('列表');
    expect(document.querySelector('[data-slot="list-footer"]')).toHaveTextContent('分页');
  });
});

describe('RowActions', () => {
  it('使用三点按钮打开右对齐的行操作菜单', async () => {
    render(
      <RowActions label="打开操作菜单">
        <DropdownMenuItem>编辑</DropdownMenuItem>
      </RowActions>,
    );

    await userEvent.click(screen.getByRole('button', { name: '打开操作菜单' }));
    expect(await screen.findByText('编辑')).toBeInTheDocument();
  });
});
