# EasyRead 开发与验证指引

本仓库包含 EasyRead 论文管理与 AI 阅读系统的完整源码及 Windows 视障友好无障碍适配实现。详细的环境配置、架构修复点、复现命令与测试结果见 [Windows 开发与测试说明](docs/WINDOWS.md)。

## 快速开始

- **环境隔离**：开发与测试时建议通过 `EASYREAD_HOME` 指定独立的数据目录（`start-desktop.cmd` 默认使用 `runtime/windows-dev`），使用新建测试账号与公开论文样本进行验证。
- **架构组成**：系统由 Python 本地后端服务、原生 HTML/CSS/JS 前端界面和 Tauri 桌面端壳层组成。无障碍适配围绕《Windows 应用无障碍可访问性开发指南》展开，重点覆盖控件名称/角色/状态语义、全键盘导航、焦点管理与 Windows 系统高对比度主题。
- **验证维度**：除运行 Python、Node 与 Rust 自动化回归测试外，桌面端无障碍验证结合 NVDA 读屏软件与 `axe-core` 进行，重点验证工具栏、PDF/网页正文与侧边面板之间的 `F6` 焦点往返以及双栏 PDF 的连续朗读顺序。

## 版本与许可

项目基于 [Edwardxlai/easyread](https://github.com/Edwardxlai/easyread)（MIT License）扩展开发。第三方依赖与许可证详情见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，版本基线说明见 [docs/PUBLICATION.md](docs/PUBLICATION.md)。
