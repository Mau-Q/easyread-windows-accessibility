# 开发与测试规范

- **项目定位**：本仓库维护 EasyRead 论文管理与 AI 阅读系统的 Windows 平台兼容与视障友好无障碍适配。开发与测试请结合 `docs/WINDOWS.md` 及 `docs/assignment/` 下的任务书进行。
- **技术栈保持**：沿用 Python 后端服务、原生 Web 界面和 Tauri 桌面壳层，保持全部既有阅读、批注、分类检索、阅读报告与问答功能正常运行。
- **无障碍验证标准**：在 Windows 原生桌面环境中验证完整键盘操作、焦点流转、NVDA 读屏播报及系统高对比度主题（`forced-colors`），配合 `axe-core` 完成 WCAG 2.1 A/AA 自动化规则检查。
- **数据与配置隔离**：测试时使用独立的 `EASYREAD_HOME` 数据目录和测试账号。切勿向版本库提交包含实际 API Key 的 `config.json`、本地 SQLite 数据库、个人文献库文件、临时运行日志或编译构建产物。
- **开源许可维护**：保留上游 MIT 许可证（`LICENSE`）及 `easyread/web/vendor/` 下各第三方组件的原始许可证声明。
- **提交前检查**：提交代码前请运行 Python、Node 与 Rust 回归测试，并执行 `python scripts/check_public_tree.py` 检查工作区文件合规性。
