import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  ThemeProvider,
  ThemeSwitcher,
} from '../../src/index';

describe('Tabs', () => {
  it('受控切换内容', async () => {
    render(
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">概览</TabsTrigger>
          <TabsTrigger value="logs">日志</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">概览内容</TabsContent>
        <TabsContent value="logs">日志内容</TabsContent>
      </Tabs>,
    );
    expect(screen.getByText('概览内容')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: '日志' }));
    expect(screen.getByText('日志内容')).toBeInTheDocument();
  });
});

describe('Breadcrumb', () => {
  it('渲染导航路径', () => {
    render(
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/admin">管理</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>渠道</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>,
    );
    expect(screen.getByRole('navigation')).toBeInTheDocument();
    expect(screen.getByText('渠道')).toBeInTheDocument();
  });
});

describe('Pagination', () => {
  it('渲染链接式分页', () => {
    render(
      <Pagination>
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious href="?page=1" />
          </PaginationItem>
          <PaginationItem>
            <PaginationLink href="?page=1">1</PaginationLink>
          </PaginationItem>
          <PaginationItem>
            <PaginationLink href="?page=2" isActive>
              2
            </PaginationLink>
          </PaginationItem>
          <PaginationItem>
            <PaginationNext href="?page=3" />
          </PaginationItem>
        </PaginationContent>
      </Pagination>,
    );
    expect(screen.getByRole('navigation', { name: 'pagination' })).toBeInTheDocument();
    const active = screen.getByRole('link', { name: '2' });
    expect(active).toHaveAttribute('href', '?page=2');
    expect(active).toHaveAttribute('aria-current', 'page');
  });
});

describe('Sidebar', () => {
  it('渲染侧栏导航结构', () => {
    render(
      <SidebarProvider>
        <Sidebar>
          <SidebarHeader>Tillgate</SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>运营</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton isActive>渠道</SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
        </Sidebar>
      </SidebarProvider>,
    );
    expect(screen.getByText('Tillgate')).toBeInTheDocument();
    expect(screen.getByText('运营')).toBeInTheDocument();
  });
});

describe('ThemeSwitcher', () => {
  it('未包 ThemeProvider 时抛错(契约与 useTheme 一致)', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<ThemeSwitcher />)).toThrow(/ThemeProvider/);
    consoleError.mockRestore();
  });

  it('直接点击在明暗两态间切换并持久化(无菜单)', async () => {
    render(
      <ThemeProvider defaultTheme="light">
        <ThemeSwitcher label="切换主题" />
      </ThemeProvider>,
    );
    const toggle = screen.getByRole('button', { name: '切换主题' });
    // 不渲染任何菜单项——切换器只有两态直切形态
    expect(screen.queryByRole('menuitem')).toBeNull();

    await userEvent.click(toggle);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(window.localStorage.getItem('theme')).toBe('dark');

    await userEvent.click(toggle);
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(window.localStorage.getItem('theme')).toBe('light');
  });
});
