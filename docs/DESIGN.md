# HPC Mail 设计基线

新前端的唯一设计文档。颜色/字体/圆角/阴影的**唯一真源**是 `apps/web/src/styles/index.css` 的 `@theme` 块，本文档解释体系与纪律，不重复枚举值。

## 1. 产品语义

- **平台账户（user）**：用户名 + 密码登录的身份，与邮箱地址解耦。角色只有 `admin` / `user` 两种。
- **邮箱地址（mailbox）**：`前缀@系统域名`，由用户认领，全局唯一占用；释放后他人可再认领。邮件按地址关联，认领即可见该地址全部历史邮件。
- **域名（domain）**：系统收件域由管理员在「域名」页维护（`settings.domains.list`），可设为仅管理员或公开；用户还可以托管自己的域名（`hosted_domains`），只有所有者、成员与管理员能在其上认领。
- **发件身份**：user 只能以自己认领的地址发件，共享来的邮箱只读；admin 另可用任意已认领邮箱，或系统域名、托管域名上的任意前缀（托管域名需发信就绪）。

## 2. 设计基调：Graphite + Indigo（浅色单主题）

近无彩石墨基底 + 纯白表面，只让品牌靛蓝与语义色携带色彩；`html { color-scheme: light }`，无深色模式。

### 色彩令牌结构（OKLCH）

| 组 | 令牌 | 用途 |
|----|------|------|
| 中性 | `canvas` / `surface` / `surface-hover` / `surface-active` | 页面画布 / 卡片面板输入框 / 悬停 / 选中 |
| 文字 | `ink` / `ink-secondary` / `ink-tertiary` | 主文字（非纯黑）/ 次级 / 占位与时间戳 |
| 线 | `line` / `line-strong` | 分隔线 / 输入框边框 |
| 品牌 | `accent` / `accent-hover` / `accent-soft` / `on-accent` / `focus` | 主操作、选中态、focus ring |
| 语义 | `positive` / `caution` / `critical`（各带 `-soft`） | 仅表状态，禁作装饰 |
| 验证码 | `otp-bg` / `otp-border` / `otp-ink`（琥珀系） | 验证码高亮条专用（产品第一场景） |
| 遮罩 | `scrim` | Dialog/Sheet 背后 |

纪律：

- 业务 JSX **禁止任意色值**（`bg-[#…]` 之类），只引语义令牌。
- 正文对比 ≥ 4.5:1，大文本/图形 ≥ 3:1。
- 状态永远双通道：颜色 + 字重/图标/文字（如未读 = 圆点 + 600 字重）。

### 字体

- sans：系统栈（PingFang SC / HarmonyOS Sans SC / Noto Sans SC / Segoe UI / system-ui），**不引 webfont**。
- mono：仅用于验证码、API Key、邀请码三处。
- 字号刻度 12/13/14/16/18/22；正文 14px 行高 1.5；页面标题 18/600；区块标题 14/600 + ink-secondary。

### 形状与动效

- 圆角四档：6（chip/badge）/ 8（按钮输入框，全站控件统一）/ 12（卡片 Dialog）/ full（FilterChip）。
- 阴影三档低调：xs（卡片）/ md（popover）/ lg（modal）；列表行不加阴影，靠分隔线与 hover 底色。
- 动效 100/150/200ms + ease-out；禁列表逐行入场动画。
- 间距 4px 刻度：控件内边距 8×12、表单字段间隔 16、卡片内边距 20、区块间隔 24、页面边距 24（移动 16）。

## 3. 反模式（禁止）

渐变、毛玻璃、霓虹描边、海报式登录页、卡片套卡片、Emoji 当图标、用等宽字体制造"技术感"（三个例外场景除外）、深色模式、逐行入场动画。

## 4. 组件清单（apps/web/src/components/ui）

Button（primary/secondary/ghost/danger × sm/md）、IconButton、Input、PasswordInput、Textarea、Combobox、Select、Checkbox、Switch、SegmentedControl、FilterChip、Badge、Table、Dialog、ConfirmDialog、Sheet、DropdownMenu、Tabs、Toast、EmptyState、Skeleton、Spinner、CopyButton、FormField。

自有源码 + Radix 无样式基元；不引大型组件库。提示文字用原生 `title`，不引 Tooltip 组件。

## 5. 布局

- AppShell：桌面左侧栏 220px + 顶栏 56px；平板侧栏收窄为 64px 图标栏；移动端底部导航（≤4 项）+ 详情页全屏。
- 收件箱过滤器：域名 FilterChip 单选横排 + 地址 Combobox + 「全部|未读」SegmentedControl + debounce 搜索；四维全部序列化到 URL，URL 是唯一 source of truth。
- 空状态三分：真空（未收到邮件）/ 过滤无结果（含清除筛选按钮）/ 网络错误（保留缓存 + banner）。

## 6. 可访问性验收

- 全部交互元素可键盘到达，focus ring 用 `focus` 令牌可见。
- 未读/状态不单靠颜色表达。
- Dialog/Sheet 焦点陷阱与 Esc 关闭（Radix 保证）。
- 验证码/Key 的复制按钮要有成功反馈（toast + 图标切换）。
