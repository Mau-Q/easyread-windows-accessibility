# EasyRead 桌面壳

现有实现使用 Tauri 窗口与菜单，启动同一 Python 服务，加载原文献库与阅读器。本轮已修复 Windows 平台分支并在原生桌面运行验证；范围和外部验收边界见 [Windows 记录](../docs/WINDOWS.md)。

Windows 在 desktop 运行 `npm ci`、`npm run build`，然后在仓库根目录运行 `start-desktop.cmd`。默认数据在检出目录下 runtime/windows-dev，可设置独立 EASYREAD_HOME。

macOS 原有 `desktop/build.command` 保留，它包含专用复制与签名步骤；`npm run build:mac` 保留 app bundle 构建。Windows 的 build 使用 --no-bundle，不生成名不副实的独立安装器。

当前桌面壳依赖项目本地 `.venv`，不是内置 Python 的独立安装器。生成桌面二进制不自动证明 Python 运行时与依赖已经被打包。先完成源码开发及桌面功能/无障碍验证，再依据实际交付需要决定是否制作独立安装包。

`EASYREAD_HOME` 用于独立测试数据目录；`EASYREAD_PROJECT_ROOT` 可指定代码目录。交接仓库不包含原 App、个人数据、旧截图或历史验收日志。
