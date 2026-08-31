<div align="center">

<img src="https://gloom.sh/gloomberb-logo-grayscale.svg" alt="Gloomberb logo" width="76" />

# Gloomberb

**开源金融终端。快速、键盘驱动、可扩展。**

桌面应用支持 macOS 和 Windows。终端界面（TUI）支持 macOS、Linux 和 Windows。

<a href="https://gloom.sh/download/desktop"><strong>下载桌面版</strong></a>
&nbsp;&middot;&nbsp;
<a href="#安装">安装 TUI</a>
&nbsp;&middot;&nbsp;
<a href="README.md"><strong>English</strong></a>

<br />
<br />

<img src="https://gloom.sh/landing-terminal.png" alt="Gloomberb 终端界面，显示投资组合、自选列表、市场数据和图表面板。" width="720" />

</div>

> 本文档为社区维护的简体中文翻译。若与 [英文原版 README](README.md) 有出入，以英文版为准。

## 桌面版还是 TUI？

Gloomberb 有两种使用方式：

| 形态 | 适合场景 | 运行方式 |
|---------|----------|-------------|
| 桌面应用 | 精美的应用窗口、可弹出面板、系统级快捷键、内置更新 | 发布支持 macOS 和 Windows，同时会安装 `gloomberb` 终端命令用于运行 TUI |
| 终端界面 (TUI) | 终端内的高速键盘操作、SSH/开发机、Linux 主机、脚本友好的场景 | 在 macOS、Linux、Windows 上通过 `gloomberb` 运行 |

两者共享同一套命令语言、插件系统、市场数据界面、投资组合、自选列表、提醒、笔记与 AI 工具。

## 安装

### macOS

安装桌面应用和 `gloomberb` 终端命令：

```bash
brew install --cask vincelwt/tap/gloomberb
# 或
curl -fsSL gloom.sh/install | bash
```

两种方式都会安装 `Gloomberb.app`，以及一个通过应用内置运行时执行 TUI 的 `gloomberb` 命令，运行时只会存储一份。

想直接下载？

- [下载 Gloomberb（Mac 版）](https://gloom.sh/download/desktop)

### Linux

安装独立的 TUI 可执行文件：

```bash
curl -fsSL gloom.sh/install | bash
```

默认会将 `gloomberb` 安装到 `~/.local/bin`。Linux 桌面安装包暂未发布。

### Windows

安装桌面应用：

- [下载 GloomberbSetup.exe（Windows x64）](https://github.com/gloom-sh/gloomberb/releases/latest/download/stable-win-x64-GloomberbSetup.exe)

安装程序会添加应用本体和 `gloomberb` 终端命令。如果只需要终端版本，安装 Bun 后使用该包即可：

```powershell
bun install -g gloomberb
```

### 终端安装包

已经装好 Bun？在任意受支持的系统上执行：

```bash
bun install -g gloomberb
```

然后运行：

```bash
gloomberb
```

在 macOS 和 Windows 上，桌面版更新会原地替换已安装的应用，并让终端命令继续指向更新后的运行时。Homebrew 用户也可以通过 `brew upgrade --cask gloomberb` 更新。

为获得最佳终端体验，请使用兼容 [Kitty](https://sw.kovidgoyal.net/kitty/) 图形协议的终端，例如 Ghostty、Kitty 或 WezTerm。

## 开始使用

按 `Ctrl+P` 打开命令模式，然后输入命令。按 `` ` `` 可直接打开股票搜索。

| 试试 | 打开 |
|-----|-------|
| `DES AAPL` | 证券详情 |
| `GP NVDA` | 价格图表 |
| `TOP` | 排名市场头条 |
| `HM` | 市场热力图 |
| `MOST` | 市场异动 |
| `PF` | 投资组合与自选列表 |
| `KELLY AAPL` | 仓位计算 |
| `HELP` | 完整的应用内快捷键列表 |

## 功能概览

- **公司研究**：行情、图表、财务报表、监管文件、股东、内部人交易、期权、分析师评级、事件与相对估值。
- **市场追踪**：头条新闻、突发新闻、板块新闻、Substack 订阅、全球股指、外汇、宏观事件、收益率曲线、市场异动与恐惧贪婪指数。
- **组合管理**：跟踪投资组合与自选列表、连接券商、设置提醒、记笔记、运行 AI 选股、浏览预测市场，并使用 Gloom Cloud 聊天。

## 命令行 (CLI)

不带参数运行 `gloomberb` 会启动终端界面。普通命令走无界面（headless）的 CLI 路径；脚本若需要显式打开 UI，使用 `gloomberb launch-ui`。

默认输出为易读的人类可读格式。自动化场景可通过 `--json`、`--csv` 或 `--ndjson` 选择结构化输出。JSON 输出会使用能获取到的最丰富的数据模型，并在命令带有表格列时附带列元数据；CSV 和 NDJSON 则使用命令的表格行视图。常用全局参数包括 `--limit`、`--refresh`、`--quiet`、`--no-color`、`--dry-run` 和 `--yes`。

| 命令 | 用途 |
|---------|-----|
| `gloomberb` | 启动终端界面 |
| `gloomberb launch-ui` | 显式启动终端界面 |
| `gloomberb help` | 显示全部 CLI 命令 |
| `gloomberb api list\|get\|invoke\|subscribe` | 直接查看和调用插件能力 |
| `gloomberb quote <symbols>` | 获取实时行情 |
| `gloomberb search <query>` / `provider-search <query>` | 搜索股票代码与数据源符号 |
| `gloomberb ticker <symbol>` | 显示行情、持股结构与财务数据 |
| `gloomberb history\|financials\|fundamentals\|options <symbol>` | 获取研究数据 |
| `gloomberb news\|filings\|holders\|insider\|13f\|analyst\|events\|valuation <symbol>` | 获取公司研究信息流 |
| `gloomberb movers\|indices\|sectors\|fx\|fear-greed\|earnings` | 获取市场概览数据 |
| `gloomberb econ\|fred\|yield-curve` | 获取宏观数据 |
| `gloomberb compare\|correlation\|relationship <symbols>` | 对比证券 |
| `gloomberb portfolio [action]` | 管理手动投资组合 |
| `gloomberb watchlist [action]` | 管理自选列表 |
| `gloomberb notes\|alerts [action]` | 管理本地笔记与提醒 |
| `gloomberb broker\|ibkr [action]` | 查看券商配置 |
| `gloomberb ai providers\|ask` | 使用已配置的 AI 服务商 |
| `gloomberb rss fetch <url>` | 抓取 RSS 订阅源 |
| `gloomberb provider status` | 查看已启用的数据源 |
| `gloomberb config\|cache\|plugin\|layout\|pane\|debug\|doctor\|version\|changelog` | 查看和管理本地应用状态 |
| `gloomberb fn [...]` | 运行基于面板的报告命令 |
| `gloomberb shot [...]` | 捕获基于面板的截图 |
| `gloomberb predictions [...]` | 启动预测市场 |
| `gloomberb plugins` | 列出已安装插件 |
| `gloomberb install <user/repo>` | 从 GitHub 安装插件 |
| `gloomberb remove <name>` | 移除已安装插件 |
| `gloomberb update [name]` | 更新插件 |

## 插件

从投资组合列表到券商集成，一切皆为插件。插件可以添加面板、页签、列、命令栏命令、CLI 命令、状态栏组件与数据源。

核心插件领域包括：

- 投资组合、自选列表、手动录入与券商连接
- 股票详情、行情、图表、期权、监管文件、股东、内部人交易与研究
- 新闻、Substack 阅读订阅、市场异动、全球股指、板块、外汇、财报、宏观数据与收益率曲线
- 预测市场、提醒、笔记、聊天、AI 选股器与外部插件

插件 API 以及通过 `gloomberb/components` 提供的共享 UI 界面，详见 [PLUGINS.md](PLUGINS.md)。

## 键盘快捷键

| 按键 | 操作 |
|-----|--------|
| `Ctrl+P` | 打开命令模式 |
| `` ` `` | 打开股票搜索 |
| `Ctrl+,` | 打开聚焦面板的设置 |
| `Ctrl+W` | 关闭聚焦面板 |
| `Ctrl+Shift+M` | 移动聚焦窗口（`WIN resize` 进入缩放模式） |
| `Ctrl+Shift+D` | 停靠或浮动聚焦面板 |
| `Ctrl+Shift+E` | 将聚焦面板的表格导出为 CSV |
| `Ctrl+Shift+L` | 布局操作 |
| `Ctrl+Shift+G` | 所有窗口网格对齐 |
| `Tab` | 切换面板 |
| `j` / `k` | 列表导航 |
| `h` / `l` | 切换页签 |
| `m` | 循环切换图表模式 |
| `q` | 退出 |

桌面版还支持 `Cmd/Ctrl+K` 打开命令栏、macOS 上对应的 `Cmd` 快捷键、`Cmd/Ctrl+Shift+O` 弹出面板为独立窗口，以及 `Cmd/Ctrl+Shift+C` 复制聚焦面板截图。

## 命令参考

在 Gloomberb 内输入 `HELP` 可查看实时快捷键列表。以下列出常用命令栏前缀，方便快速查阅。

### 公司研究

| 快捷指令 | 功能 |
|----------|----------|
| `DES <ticker>` / `T <ticker>` | 股票的证券详情 |
| `FA <ticker>` | 财务报表视图 |
| `GP <ticker>` | 价格图表 |
| `GIP <ticker>` | 盘中价格图表 |
| `HP <ticker>` | 历史 OHLCV 价格 |
| `GF <tickers>` | 基本面报表图表 |
| `GE <tickers>` | 估值倍数图表 |
| `GR <tickers>` | 证券关系图 |
| `EE <ticker>` | 含 EPS 与营收预估的事件视图 |
| `EM [tickers]` | 财报监控 |
| `SRCH <query>` | 数据源符号搜索 |
| `RSCH [query]` | 跨财报电话会记录、新闻与 SEC 文件的全文检索 |
| `QQ <tickers>` | 股票行情监控 |
| `CMP <tickers>` | 股票图表对比 |
| `CORR <tickers>` | 股票收益率相关性 |
| `ANR <ticker>` | 分析师目标价与评级 |
| `SEC <ticker>` | SEC 申报文件与公司披露 |
| `OMON <ticker>` | 期权监控 |
| `HDS <ticker>` | 机构股东 |
| `13F [fund/ticker/CIK]` | 13F 基金申报与持仓 |
| `INS <ticker>` | 内部人交易动态 |
| `EVT <ticker>` | 公司行动、财报与预估 |
| `RV <tickers>` | 相对估值 |

### 市场、新闻与宏观

| 快捷指令 | 功能 |
|----------|----------|
| `TOP` | 排名市场头条 |
| `HM` | 美股大盘股与 ETF 市场热力图 |
| `MOST` | 涨幅榜、跌幅榜、成交活跃与热门股票 |
| `PM <query>` | Polymarket 与 Kalshi 预测数据 |
| `N` | 新闻源 |
| `CN <ticker>` | 个股新闻 |
| `NI` | 板块新闻 |
| `SUB` | 已登录的 Substack 阅读订阅源 |
| `FIRST` | 突发新闻 |
| `TWIT <query>` | 与股票相关的市场动态帖子 |
| `TBO` | TheBuildout 基础设施情报 |
| `CG` | 国会交易披露 |
| `WEI` | 全球股指 |
| `ECON` | 经济事件与数据发布 |
| `GC` | 收益率曲线 |
| `ERN` | 财报日历 |
| `BI` / `SP` | 标普 500 板块表现 |
| `FXC` | 主要外汇交叉汇率 |
| `FNG` | 恐惧与贪婪市场指数 |

### 工作区与应用控制

| 快捷指令 | 功能 |
|----------|----------|
| `PF` | 投资组合与自选列表工作区 |
| `PORT` | 投资组合风险与板块敞口 |
| `ALRT` | 价格提醒 |
| `SA <symbol condition price>` | 创建价格提醒 |
| `AI <prompt>` | AI 选股器 |
| `CHAT [channel]` | Gloom Cloud 聊天 |
| `DM @user [@user...]` | 打开或发起私信/群聊 |
| `ACM` | Gloom Cloud 账户设置 |
| `NOTE` | 笔记 |
| `IBKR` | IBKR 交易面板 |
| `BR` | 券商连接 |
| `CHG` | 更新日志 |
| `HELP` | 打开快捷键与布局帮助 |
| `AW` / `AP <ticker>` | 将股票添加到活动自选列表或投资组合 |
| `RW` / `RP <ticker>` | 从活动自选列表或投资组合中移除股票 |
| `PS` | 打开聚焦面板的设置 |
| `LAY` | 打开布局浏览器以切换、发布或添加布局 |
| `LMA <query>` | 布局与面板排列操作 |
| `WIN move\|resize` | 移动或缩放聚焦窗口 |
| `GL` | 所有可见面板网格对齐 |
| `SB` | 切换状态栏 |
| `VF` | 切换行情数值闪烁 |
| `TH <theme>` | 更换配色主题 |
| `CR` | 切换图表渲染器 |
| `LANG <locale>` | 切换界面语言（`auto`、`en`、`es`、`zh-CN`、`zh-TW`、`ja` 或 `ko`） |
| `PL <plugin>` | 管理插件 |

发布的布局会保留可移植的面板设置与状态，包括搜索条件、图表视窗和绘图；凭据、账户、投资组合以及标记为私密的字段始终保留在本地。发布后会自动复制一个长期有效的 `term.gloom.sh/l/...` 社交分享链接。

## 本地化界面

Gloomberb 内置 English、简体中文、繁體中文、日本語和한국어界面支持；英文仍是默认回退语言。

- **自动检测**：终端 `LANG` / `LC_ALL` 与桌面系统语言会自动选择受支持的界面语言。
- **命令切换**：在命令栏（Ctrl+P）输入 `LANG` 可循环切换，也可直接输入 `LANG auto`、`LANG en`、`LANG es`、`LANG zh-CN`、`LANG zh-TW`、`LANG ja` 或 `LANG ko`。选择会保存到 `config.json`。
- **单次覆盖**：在可读取进程语言变量的环境中，可用 `GLOOMBERB_LANG=ja gloomberb`（或其他受支持的语言代码）进行最高优先级覆盖。

实现说明：

- 各语言词典位于 [src/i18n](src/i18n)，以英文原文为键；查不到的词条自动回退英文，因此可以增量补充翻译，不影响任何功能。
- 渲染出口统一经过 `t()`（[src/i18n/index.ts](src/i18n/index.ts)），面板标题、命令栏、右键菜单、设置对话框、页签、帮助与引导页均已接入。
- 表格列头（BID/ASK/CHG% 等金融缩写）刻意保留英文，符合行情终端惯例并保证定宽列对齐。
- 中日韩宽字符和字素簇的截断与排版由 [src/utils/format.ts](src/utils/format.ts) 按终端单元格宽度处理。

## 许可证

MIT

## 致谢

- [OpenTUI](https://opentui.com/) 提供布局引擎
