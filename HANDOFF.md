# EasyRead 开发交接

Windows 适配在 [windows-accessibility 分支](https://github.com/Mau-Q/easyread-windows-accessibility/tree/windows-accessibility)。该分支在 Windows 桌面上验证了键盘操作、NVDA 读屏和系统高对比度。启动步骤、复测命令和补测条件见 [Windows 开发与测试记录](https://github.com/Mau-Q/easyread-windows-accessibility/blob/windows-accessibility/docs/WINDOWS.md)。

## 开始开发

- 先查看当前分支和工作区改动。跟着测试记录启动桌面程序，用独立的 EASYREAD_HOME 和测试账号。
- 保留原有 Python 服务、Web 界面和 Tauri 桌面壳。适配范围以 [任务书](docs/assignment/揭榜任务2-无障碍适配任务书.pdf) 为准，重点检查控件名称、角色、状态、键盘操作、焦点和高对比度。
- 测试时记录系统和工具版本、操作步骤、结果及复测情况。浏览器和自动检查的结果应单独记录。用 NVDA 检查桌面正文、工具栏与面板之间的焦点，以及双栏 PDF 的朗读顺序。
- 提交前按 [开发约定](AGENTS.md) 检查公开文件。使用合成样本或公开论文，测试账号、服务凭据和原始日志保存在本机。

## 来源

[公开整理记录](docs/PUBLICATION.md) 保存了源码来源、首次公开检查和任务书指纹。任务书原件的 SHA-256 为 a238fa3009452467796b22cf582635921cc82999bc505cd0586bd75c8b98005e。
