# EasyRead：Windows 视障友好适配

EasyRead 是一款面向文献阅读与管理的桌面应用，提供本地文献库、多账号隔离、PDF 与网页双语阅读、分类与检索、批注与手动笔记、结构化阅读报告及论文内问答等功能。

本仓库在原有课程项目基础上完成了 **Windows 平台兼容性改造与视障友好无障碍适配**，并已在 Windows 原生 Tauri 桌面环境中完成全键盘导航、NVDA 读屏朗读及 Windows 系统高对比度主题验证。

## 核心无障碍适配特性

- **Windows 原生桌面运行与进程管理**：适配 Windows Python 虚拟环境发现、进程树生命周期清理、无控制台子进程调度、`msvcrt` 文件锁、原生外部链接打开及 `.mjs` 模块 MIME 映射。
- **控件可访问语义（名称 / 角色 / 状态）**：为输入框、图标按钮、可编辑字段、文献列表、任务状态及阅读器正文 `iframe` 补齐 ARIA 语义属性，实现列表 `aria-activedescendant` 焦点与实际选中项同步。
- **全键盘操作与焦点管理**：支持文献分类管理、上下文菜单（`Shift+F10`）、六个设置页、模型列表增删改、确认弹窗及会话切换的纯键盘操作；模态弹窗启用背景 `inert` 与焦点限制，关闭后自动恢复原焦点。
- **阅读器跨区导航与正文定位**：支持 `F6` / `Shift+F6` 在顶部工具栏、PDF/网页正文与侧边面板之间循环切换；支持选文后按 `Shift+F10` 唤出批注工具栏，点击目录、摘要、批注或报告引用后自动将焦点移入对应正文位置。
- **高对比度主题与低视力支持**：适配 Windows 系统高对比度主题（`forced-colors`）下的文字、边框、选中态与键盘焦点样式，支持 200% 页面缩放并修复低缩放比例下的逻辑页码同步。

## 在 Windows 上运行

1. 克隆仓库：
   ```powershell
   git clone https://github.com/Mau-Q/easyread-windows-accessibility.git
   cd easyread-windows-accessibility
   ```
2. 创建 Python 3.12 虚拟环境并安装后端依赖：
   ```powershell
   py -3.12 -m venv .venv
   .\.venv\Scripts\python.exe -m pip install -e .
   ```
3. 安装前端与桌面端依赖并构建原生桌面程序：
   ```powershell
   cd desktop
   npm ci
   npm run build
   cd ..
   ```
4. 启动桌面应用：
   ```powershell
   .\start-desktop.cmd
   ```
   默认运行数据保存在 `runtime/windows-dev` 目录下（可通过环境变量 `EASYREAD_HOME` 指定独立的数据目录）。详细构建与测试说明见 [Windows 开发与测试记录](docs/WINDOWS.md)，教学平台提交说明见 [适配总结](docs/TEACHING_POST_DRAFT.md)。

## 目录结构

| 路径 | 说明 |
|---|---|
| `easyread/` | Python 后端服务、HTML/CSS/JS 前端界面、无障碍支持模块与阅读器资源 |
| `desktop/` | Tauri 桌面端壳层（支持 Windows 与 macOS 构建及平台进程管理） |
| `tests/` | Python 后端回归测试、Node 前端测试及 Windows 无障碍/NVDA 自动化测试脚本 |
| `start.cmd` / `start-desktop.cmd` | Windows 本地后端服务启动脚本 / 原生桌面应用启动脚本 |
| `config.example.json` | 默认配置模板 |
| `docs/WINDOWS.md` | Windows 平台适配细节、测试环境、复现命令与实测结果记录 |
| `docs/assignment/` | 课程无障碍适配任务书 |

## 实测验证概览

在 Windows x64（10.0.26300）原生桌面环境下已完成以下验证（详见 [docs/WINDOWS.md](docs/WINDOWS.md)）：

- **自动化回归测试**：Python 后端单元测试 **235 项全部通过**，Node 前端测试 **30 项全部通过**，Rust 桌面壳层测试 **3 项全部通过**。
- **NVDA 读屏实测**：基于 NVDA 2026.3.1 实测控件名称与角色播报、双栏两页合成 PDF（20 段正文）跨栏连续朗读顺序，以及公开 BERT 论文从首页进入摘要、引言与相关工作的连续朗读。
- **全键盘与系统高对比度**：覆盖登录、导入、搜索、分类、设置、阅读翻页、划线批注、笔记保存、原生文件打开/另存为对话框及 Windows“夜空”高对比度主题；`axe-core` 对 10 个核心界面状态扫描均为 **0 违规（0 violations）**。
- **AI 阅读与重排流程**：基于本地模型完成四栏目阅读报告生成、带引用问答、图片问答与选词翻译验证，并通过 Zotero `document-worker` 完成双栏 PDF 结构化重排映射验证。

## 来源与开源许可

本项目基于 [Edwardxlai/easyread](https://github.com/Edwardxlai/easyread)（MIT [LICENSE](LICENSE)）扩展开发。内置第三方阅读器与前端组件遵循各自开源许可证，详见 [第三方许可说明](THIRD_PARTY_NOTICES.md)；版本基线与仓库整理记录见 [版本说明](docs/PUBLICATION.md)。
