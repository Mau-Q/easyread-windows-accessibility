# 版本来源与仓库整理说明

本仓库整理自 EasyRead 软件工程课程项目，用于在开源环境下提供完整的文献管理、双语阅读及 Windows 视障友好无障碍适配源码与自动化测试集。

## 代码来源与基线

- **上游开源项目**：<https://github.com/Edwardxlai/easyread>（保留根目录 MIT `LICENSE` 及各第三方组件原始开源许可）。
- **课程项目基线**：在原项目基础上新增多用户账号与会话隔离、SQLite 结构化持久化、四栏目阅读报告、AI 调用前知情同意、异常恢复及 CR-001 中文题名搜索（对应课程基线提交 `1e4793db5bdc7b8fa42a109034332d326517a205`）。
- **Windows 平台与无障碍适配**：在此基础上进一步完成了 Windows Tauri 桌面端适配、全键盘导航、ARIA 语义补齐、NVDA 读屏支持与 Windows 系统高对比度主题适配（详见 [Windows 开发与测试说明](WINDOWS.md)）。

## 收录与排除范围

- **收录范围**：完整的 Python 后端源码、原生 HTML/CSS/JS 前端界面、`easyread/web/vendor/` 第三方阅读器运行资源、Tauri 桌面端工程与锁文件、单元测试与 Windows 无障碍 E2E 测试脚本、配置示例（`config.example.json`）以及课程任务书。
- **排除范围**：开发过程中的个人文献库、本地 SQLite 账号数据库、包含 API 密钥的实际 `config.json`、阅读与翻译缓存文件以及本地临时构建产物均已通过 `.gitignore` 与发布检查脚本排除。

## 自动化验证与安全检查

- **跨平台自动化回归**：
  - Windows 原生环境：Python 后端单元测试 **235 项通过**，Node 前端测试 **30 项通过**，Rust 桌面端测试 **3 项通过**，`axe-core` 10 个核心界面状态扫描 **0 违规**。
  - macOS 基线环境：Python 后端单元测试 **230 项通过**，Node 前端测试 **30 项通过**。
- **代码树与敏感信息检查**：
  - 运行 `python scripts/check_public_tree.py` 检查全部受跟踪文件，确认无本地绝对路径泄漏、无配置文件或数据库残留。
  - 使用 Gitleaks（`gitleaks dir . --config .gitleaks.toml --redact=100` 及 `gitleaks git .`）扫描工作区与 Git 提交历史，确认无任何凭据或密钥泄漏。
