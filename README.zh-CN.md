<div align="center">

<img src="https://gloom.sh/gloomberb-logo-grayscale.svg" alt="Gloomberb 标志" width="76" />

# Gloomberb

**开源金融终端。快速、键盘驱动、可扩展。**

桌面应用支持 macOS 和 Windows。终端界面（TUI）支持 macOS、Linux 和 Windows。

<a href="https://gloom.sh/download/desktop"><strong>下载桌面版</strong></a>
&nbsp;&middot;&nbsp;
<a href="#安装"><strong>安装 TUI</strong></a>
&nbsp;&middot;&nbsp;
<a href="https://term.gloom.sh"><strong>在浏览器中打开</strong></a>
&nbsp;&middot;&nbsp;
<a href="README.md">English</a>

<br />
<br />

<img src="https://gloom.sh/landing-terminal.png" alt="Gloomberb 终端界面，显示投资组合、自选列表、市场数据和图表面板。" width="720" />

</div>

> 本文档为社区维护的简体中文翻译。若与 [英文原版 README](README.md) 有出入，以英文版为准。

- **公司研究**：行情、图表、财务报表、监管文件、期权与分析师评级。
- **市场追踪**：新闻、全球股指、外汇、经济事件与市场扫描工具。
- **工作区管理**：投资组合、自选列表、券商连接、提醒、笔记与 AI 工具。

桌面版和 TUI 共享同一套命令语言与插件系统。[浏览器版](https://term.gloom.sh) 提供部分功能，需要免费 Gloom Cloud 账户：免费行情有请求频率限制，并延迟 15 分钟；Pro 提供实时行情。详见[浏览器版功能与限制（英文）](docs/browser.md)。

## 安装

### 桌面版

在 **macOS（Apple Silicon）** 上：

```bash
brew install --cask vincelwt/tap/gloomberb
```

在 **Windows 11** 上，[下载安装程序](https://github.com/gloom-sh/gloomberb/releases/latest/download/stable-win-x64-GloomberbSetup.exe)。支持 x64，也可通过 x64 仿真在 ARM64 上运行。

两个平台的桌面安装程序均包含 `gloomberb` 终端命令。

### 终端版

在 **macOS 或 Linux** 上：

```bash
curl -fsSL gloom.sh/install | bash
```

在 Apple Silicon Mac 上，此脚本会安装桌面版和 TUI；在 Intel Mac 和 Linux 上，会安装独立的 TUI。

也可在 macOS、Linux 或 Windows x64 上通过 [Bun](https://bun.sh) 安装：

```bash
bun install -g gloomberb
```

运行 `gloomberb` 即可启动。要显示图形，请使用兼容 Kitty 图形协议的终端，例如 Ghostty、Kitty 或 WezTerm。直接下载、安装位置与更新方式详见[安装指南（英文）](docs/installation.md)。

## 开始使用

按 `Ctrl+P` 打开命令栏，或按 `` ` `` 搜索股票代码。桌面版也支持 `Cmd/Ctrl+K`。

| 试试 | 打开 |
|-----|-------|
| `DES AAPL` | 公司详情 |
| `GP NVDA` | 价格图表 |
| `TOP` | 市场新闻 |
| `PF` | 投资组合与自选列表 |
| `HELP` | 命令与键盘快捷键 |

使用 `Tab` 切换面板，`j` / `k` 浏览列表。[使用指南（英文）](docs/usage.md) 包含图表、券商配置、键盘快捷键与完整命令参考。

## 命令行（CLI）

直接在 shell 中运行命令：

```bash
gloomberb quote AAPL
gloomberb quote AAPL --json
gloomberb help
```

默认输出便于阅读；脚本可使用 `--json`、`--csv` 或 `--ndjson` 获取结构化输出。命令与参数详见 [CLI 参考（英文）](docs/usage.md#cli)。

## 插件与贡献

插件可添加面板、数据源、券商连接与命令。从 GitHub 安装插件：

```bash
gloomberb install gloom-sh/gloomberb-tv
```

详见[插件开发指南（英文）](PLUGINS.md)、[直播电视配置（英文）](docs/usage.md#live-tv)或[贡献指南（英文）](CONTRIBUTING.md)。

界面支持英语、西班牙语、简体中文、繁体中文、日语与韩语。在命令栏中输入 `LANG` 即可切换，详见[语言设置（英文）](docs/usage.md#localized-interface)。

采用 [MIT 许可证](LICENSE)。基于 [OpenTUI](https://opentui.com/) 构建。
