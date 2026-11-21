# EasyRead：Windows 视障友好适配

本仓库基于已有 EasyRead 软件工程课程项目，已进行 Windows 兼容与视障友好适配，并在本机 Tauri 桌面窗口验证键盘、NVDA 输出和系统高对比度。教师验收已登记为完成。测试结果和复测步骤见 [Windows 测试记录](docs/WINDOWS.md)。

应用包含本地文献库、账号隔离、PDF 与网页阅读、分类和搜索、批注与手动笔记、阅读报告及问答等已有功能。此次目标是让这些现有功能可被读屏软件识别、可通过键盘操作，并支持 Windows 系统高对比度；不新增业务功能。

## 在 Windows 上运行

1. 克隆仓库：`git clone --branch windows-accessibility https://github.com/Mau-Q/easyread-windows-accessibility.git`。
2. 阅读 [开发交接](HANDOFF.md)、[开发约定](AGENTS.md)和[任务书原件](docs/assignment/揭榜任务2-无障碍适配任务书.pdf)。
3. 按 [Windows 开发与测试说明](docs/WINDOWS.md)安装依赖并在 `desktop` 执行 `npm ci`、`npm run build`。
4. 在根目录运行 `start-desktop.cmd`；默认数据位于检出目录下 `runtime/windows-dev`，可先设置独立 `EASYREAD_HOME`。教学平台草稿见 [此处](docs/TEACHING_POST_DRAFT.md)。

## 已有结构

| 路径 | 内容 |
|---|---|
| `easyread/` | Python 后端、HTML/CSS/JS 界面与完整第三方阅读器资源 |
| `desktop/` | Tauri 桌面壳、图标与 npm/Cargo 锁文件；Windows 构建和平台分支 |
| `tests/` | 原有回归测试及已补入的 CR-001 中文题名搜索测试 |
| `start.cmd` / `start-desktop.cmd` | Python 服务入口 / 本机 Windows 原生桌面入口 |
| `config.example.json` | 不含凭据、关闭自动翻译的配置示例 |
| `docs/assignment/` | 用户提供的课程任务书，作为需求材料保留 |

## 运行范围

Python 依赖声明在 `pyproject.toml`，要求 Python 3.10+；接手时建议先使用 3.12。前端为原生 HTML/CSS/JS，不需要另建 React/Vue 项目。第三方 `easyread/web/vendor/` 是运行资源，不能作为缓存删除。

Windows 本机已通过 Python 235 项管理员回归、Node 30 项和 Rust 3 项。桌面核心流程、NVDA、系统高对比度、本地真实文本模型和 Zotero 重排候选均已实测。Tauri 和翻译进程管理保留 Unix 分支并增加 Windows 实现。当前 exe 依赖源码检出和 Python 虚拟环境。HJFY 和其他补测条件见 [Windows 测试记录](docs/WINDOWS.md#待补测与提交状态)。

真实 AI 功能依赖使用者自行配置的服务或本机后端；本仓库不附 API Key、模型账户、个人文献、账号数据库或历史阅读记录。初始验证使用新建测试账号和可公开的测试 PDF，不调用真实付费服务。

## 来源与公开边界

项目基于 [Edwardxlai/easyread](https://github.com/Edwardxlai/easyread)，保留原 MIT [LICENSE](LICENSE)。本地扩展及课程改造是在上游基础上的后续工作，不声称所有代码均为原创。第三方组件遵循各自许可证，详见 [第三方说明](THIRD_PARTY_NOTICES.md)。任务书是课程材料，不因放在本仓库而改授 MIT 许可。

本次使用经过筛选的当前源码新建 Git 历史，原私有工作区与旧 Git 历史未上传。来源版本、纳入的未提交改动、排除范围和实际验证见 [公开整理记录](docs/PUBLICATION.md)。历史设计说明反映各自编写时状态，当前代码及实际测试优先。

课程最终提交仍需在教学平台发布主贴，包含修改点、测试工具和实际效果；仓库链接不能替代主贴。标题按任务书要求填写，截止时间以课程通知为准。
