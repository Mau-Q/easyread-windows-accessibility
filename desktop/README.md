# EasyRead 桌面端壳层（Tauri）

`desktop/` 目录包含基于 Tauri 2 的原生桌面窗口与系统菜单实现，负责在启动时自动拉起或连接本地 Python 后端服务，并承载文献库与阅读器界面。目前已完整支持 Windows 与 macOS 双平台构建及运行。

## Windows 构建与启动

在完成根目录 Python 虚拟环境（`.venv`）安装后，执行以下命令构建并启动 Windows 桌面端：

```powershell
cd desktop
npm ci
npm run build
cd ..
.\start-desktop.cmd
```

`start-desktop.cmd` 默认将应用数据目录 `EASYREAD_HOME` 指向 `runtime/windows-dev`（也可在启动前自定义 `EASYREAD_HOME` 环境变量），并将 WebView2 用户数据目录置于同一隔离路径下。

## 跨平台构建说明

- **Windows**：`npm run build` 调用 `tauri build --no-bundle` 生成原生可执行程序，配合项目目录内的 `.venv` Python 虚拟环境运行。
- **macOS**：保留 `desktop/build.command` 与 `npm run build:mac`（`tauri build --bundles app`），支持生成 macOS `.app` 应用包。
- **环境变量**：`EASYREAD_HOME` 用于指定数据存储目录；`EASYREAD_PROJECT_ROOT` 用于显式指定后端项目根目录。
