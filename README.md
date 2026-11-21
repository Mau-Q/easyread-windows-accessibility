# EasyRead：Windows 视障友好适配

EasyRead 是软件工程课程项目，提供文献导入、搜索、PDF 和网页阅读、批注、阅读报告与问答。本次适配在 Windows 桌面上验证了键盘操作、NVDA 读屏和系统高对比度。教师验收已登记为完成。

**Windows 适配源码和启动说明在 [windows-accessibility 分支](https://github.com/Mau-Q/easyread-windows-accessibility/tree/windows-accessibility)。** 默认分支 main 保留适配前的源码快照。

## 在 Windows 上运行

克隆适配分支：

    git clone --branch windows-accessibility https://github.com/Mau-Q/easyread-windows-accessibility.git

按 [Windows 开发与测试说明](https://github.com/Mau-Q/easyread-windows-accessibility/blob/windows-accessibility/docs/WINDOWS.md) 安装依赖并构建桌面程序，然后在检出目录运行 start-desktop.cmd。

## 实测结果

Windows 本机通过了 235 项 Python 测试、30 项 Node 测试和 3 项 Rust 测试。另验证了桌面核心流程、本地文本模型和简单图片问答。测试环境、复测步骤和剩余测试见 [Windows 测试记录](https://github.com/Mau-Q/easyread-windows-accessibility/blob/windows-accessibility/docs/WINDOWS.md)。

任务要求见 [课程任务书](docs/assignment/揭榜任务2-无障碍适配任务书.pdf)。

## 来源与许可


项目基于 [Edwardxlai/easyread](https://github.com/Edwardxlai/easyread)，保留原 MIT [LICENSE](LICENSE)。本地扩展及课程改造是在上游基础上的后续工作，不声称所有代码均为原创。第三方组件遵循各自许可证，详见 [第三方说明](THIRD_PARTY_NOTICES.md)。任务书是课程材料，不因放在本仓库而改授 MIT 许可。

本次使用经过筛选的当前源码新建 Git 历史，原私有工作区与旧 Git 历史未上传。来源版本、纳入的未提交改动、排除范围和实际验证见 [公开整理记录](docs/PUBLICATION.md)。历史设计说明反映各自编写时状态，当前代码及实际测试优先。
