// 根入口: 纯 React 设计系统唯一导出面。
// 纪律(总纲 §3/P7): 本文件及其传递闭包禁止引入 Next 专有依赖(next/*、next-themes、
// next-intl、geist)与 @tokenlens/* workspace 包; 由 test/pack/imports 测试机器锁定。
export { cn } from './cn';

// ---- primitives(视觉原子与浮层) ----
export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
} from './components/primitives/alert-dialog';
export {
  Avatar,
  AvatarImage,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarBadge,
} from './components/primitives/avatar';
export { Badge, badgeVariants } from './components/primitives/badge';
export { Button, buttonVariants } from './components/primitives/button';
export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
} from './components/primitives/card';
export {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from './components/primitives/collapsible';
export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
} from './components/primitives/command';
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from './components/primitives/dialog';
export {
  Drawer,
  DrawerPortal,
  DrawerOverlay,
  DrawerSwipeHandle,
  DrawerTrigger,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerFooter,
  DrawerTitle,
  DrawerDescription,
} from './components/primitives/drawer';
export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from './components/primitives/dropdown-menu';
export { Kbd, KbdGroup } from './components/primitives/kbd';
export {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from './components/primitives/popover';
export { ScrollArea, ScrollBar } from './components/primitives/scroll-area';
export { Separator } from './components/primitives/separator';
export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
} from './components/primitives/sheet';
export { Skeleton } from './components/primitives/skeleton';
export { Spinner } from './components/primitives/spinner';
export { ThemeProvider, useTheme, useThemeOptional } from './components/primitives/theme-provider';
export {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from './components/primitives/tooltip';

// ---- forms(表单控件) ----
export { Checkbox } from './components/forms/checkbox';
export {
  Combobox,
  ComboboxInput,
  ComboboxContent,
  ComboboxList,
  ComboboxItem,
  ComboboxGroup,
  ComboboxLabel,
  ComboboxCollection,
  ComboboxEmpty,
  ComboboxSeparator,
  ComboboxChips,
  ComboboxChip,
  ComboboxChipsInput,
  ComboboxTrigger,
  ComboboxValue,
  useComboboxAnchor,
} from './components/forms/combobox';
export {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldContent,
  FieldTitle,
} from './components/forms/field';
export { Input } from './components/forms/input';
export {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
  InputGroupInput,
  InputGroupTextarea,
} from './components/forms/input-group';
export { Label } from './components/forms/label';
export { PasswordInput, type PasswordInputProps } from './components/forms/password-input';
export { RadioGroup, RadioGroupItem } from './components/forms/radio-group';
export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from './components/forms/select';
export { Switch } from './components/forms/switch';
export { Textarea } from './components/forms/textarea';
export { Toggle, toggleVariants } from './components/forms/toggle';
export { ToggleGroup, ToggleGroupItem } from './components/forms/toggle-group';

// ---- data(数据展示) ----
export {
  DataTable,
  type DataTableColumn,
  type DataTableProps,
  type DataTableSortState,
} from './components/data/data-table';
export {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
  EmptyMedia,
} from './components/data/empty';
export { KpiCard, type KpiCardDelta, type KpiCardProps } from './components/data/kpi-card';
export { MoneyDisplay, type MoneyDisplayProps } from './components/data/money-display';
export { SecretReveal, type SecretRevealProps } from './components/data/secret-reveal';
export { StatusPill, type StatusPillProps } from './components/data/status-pill';
export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
} from './components/data/table';

// ---- navigation(导航) ----
export {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
  BreadcrumbEllipsis,
} from './components/navigation/breadcrumb';
export {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from './components/navigation/pagination';
export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from './components/navigation/sidebar';
export {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  tabsListVariants,
} from './components/navigation/tabs';
export {
  ThemeSwitcher,
  type ThemeSwitcherLabels,
  type ThemeSwitcherProps,
} from './components/navigation/theme-switcher';

// ---- feedback(反馈) ----
export { Alert, AlertTitle, AlertDescription, AlertAction } from './components/feedback/alert';
export { ConfirmDialog, type ConfirmDialogProps } from './components/feedback/confirm-dialog';
export { CopyButton, type CopyButtonProps } from './components/feedback/copy-button';
export { FormDialog, type FormDialogProps } from './components/feedback/form-dialog';
export {
  Progress,
  ProgressTrack,
  ProgressIndicator,
  ProgressLabel,
  ProgressValue,
} from './components/feedback/progress';
export { Toaster } from './components/feedback/sonner';
export { toast } from 'sonner';

// ---- hooks ----
export { useCopy, type UseCopyResult } from './hooks/use-copy';
export { useIsMobile } from './hooks/use-mobile';
export { useMediaQuery } from './hooks/use-media-query';

// ---- formatting(装配注入式格式化工厂) ----
export {
  createMoneyFormatter,
  type MoneyFormatter,
  type MoneyFormatterOptions,
  type MoneyTone,
} from './formatting/money';
export {
  createNumberFormatter,
  type NumberFormatter,
  type NumberFormatterOptions,
} from './formatting/number';
export {
  createDateFormatter,
  type DateFormatter,
  type DateFormatterOptions,
  type DateInput,
} from './formatting/date';
