# Windows 桌面与自部署

## 1. Windows 桌面架构

Electron 主进程启动打包后的 Next.js standalone 服务，健康检查通过后加载本地窗口。应用使用单实例锁；数据库、运行文件和日志通过 `AGENTIC_DATA_DIR` 指向 Electron 的 `userData`。

桌面功能包括：

- NSIS 安装版和便携版 `.exe`
- 原生文件/文件夹选择以及批量输出目录选择
- 后台任务关闭提醒
- 可最小化到系统托盘继续运行
- 打开数据目录和导出诊断日志
- 卸载时默认保留用户数据

## 2. 密钥

Electron 使用 `safeStorage` 包装一个随机主密钥，再将该主密钥提供给服务端的 AES-GCM 端点密钥存储层。主密钥、API Key 和 Authorization header 不会写入日志、SSE、HTML 或导出文件。

Web 生产环境必须显式设置强随机的 `AGENTIC_SECRET_KEY`。开发环境下可生成 `data/.development-secret-key`，仅供本机开发使用。

## 3. 构建

```bash
npm ci
npm run typecheck
npm test
npm run build:standalone
npm run package:win
```

`build:standalone` 只清理可再生成的 `.next/standalone` 目录：它会移除 tracing 意外带入的 `.omo/`、`data/`、`迭代文档/` 等本地路径，再自动执行发行树扫描。扫描通过后，构建会使用独立临时数据目录和随机密钥，在系统分配的非 3000 端口真实启动 standalone，并等待 `/api/health/ready` 成功。发现数据库、运行记录、研发文档、疑似凭据或缺失运行时依赖时，构建直接失败；现有服务和工作区中的真实数据目录不会被停止、删除或改写。

`package:win` 会在不含空格的隔离暂存目录中为 Electron ABI 重新构建 `better-sqlite3`，准备 standalone 资源，并由 electron-builder 同时生成 NSIS 和便携版目标。打包前会从 `app/icon.svg` 独立生成包含 16 到 256 px 多尺寸图层的 Windows ICO，无需依赖外部图标转换工具。短暂的下载或构建故障最多重试三次；确定性错误仍会以非零状态退出。该命令不会覆盖开发环境中 Node.js 使用的原生模块。

当前 Windows x64 产物位于 `dist-electron/`：

- `Agentic Translating-0.1.1-setup-x64.exe`
- `Agentic Translating-0.1.1-portable-x64.exe`

桌面运行时从 `resources/app` 启动 standalone 服务，并通过只读的 `app.asar/node_modules` 解析服务器依赖。`better-sqlite3` 仍由 electron-builder 放入 `app.asar.unpacked`。构建机需要 Node.js 22 或更高版本，以及可用的 Windows C++ 构建工具链，以便在预编译包缺失时从源码重建。

## 4. Docker

```bash
docker compose up --build
```

Compose 配置暴露 3000 端口并挂载持久数据卷。部署前必须替换 `AGENTIC_SECRET_KEY`，建议在反向代理层配置 TLS、请求体大小、超时时间和访问控制。`.dockerignore` 会排除本机数据库、测试产物、桌面构建输出和所有 `.env` 文件，避免将 BYOK 密钥带入构建上下文。

## 5. 备份与升级

1. 暂停批量任务并停止应用。
2. 复制整个数据目录，而不仅仅是 `app.db`。这样可以一并保留 WAL 文件、运行文件和加密所需的本地材料。
3. 升级程序后首次启动时，系统会自动执行增量迁移。
4. 如果迁移或健康检查失败，停止新版，并使用完整的数据目录备份回滚。

不要在应用运行且 WAL 尚未检查点时只复制单个 SQLite 主文件。

## 6. 自定义扩展

高级用户可通过 Agent 库和方向提示词包扩展角色，无需修改 Electron。若自行修改源码，请保持稳定 ID、迁移幂等性、旧 revision 只读兼容以及公共 DTO 密钥隔离，并重新运行所有门禁检查。
