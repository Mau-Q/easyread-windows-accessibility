# EasyRead 桌面壳

现有实现使用 Tauri 窗口与菜单，启动同一 Python 服务，加载原文献库与阅读器。当前构建配置和脚本面向 macOS，**尚未在 Windows 构建或运行验证**。

Windows 接手请先阅读 [交接说明](../HANDOFF.md)和 [Windows 开发说明](../docs/WINDOWS.md)。需检查 Python 环境路径、Unix 进程组、外部打开操作、菜单快捷键、窗口生命周期和 Windows 构建目标。

macOS 原有构建入口为 `desktop/build.command`；该脚本包含 macOS 专用复制与签名命令，不能在 Windows 原样使用。`package.json` 中现有 `build` 也指定 `--bundles app`，需增加合适的 Windows 构建方式。

当前桌面壳依赖项目本地 `.venv`，不是内置 Python 的独立安装器。生成桌面二进制不自动证明 Python 运行时与依赖已经被打包。先完成源码开发及桌面功能/无障碍验证，再依据实际交付需要决定是否制作独立安装包。

`EASYREAD_HOME` 用于独立测试数据目录；`EASYREAD_PROJECT_ROOT` 可指定代码目录。交接仓库不包含原 App、个人数据、旧截图或历史验收日志。
