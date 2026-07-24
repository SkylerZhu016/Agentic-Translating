# Windows 桌面与自部署

## 1. Windows 桌面架构

Electron 主进程启动打包后的 Next.js standalone 服务，等待健康检查成功后加载本地窗口。应用使用单实例锁；数据库、运行文件和日志通过 `AGENTIC_DATA_DIR` 指向 Electron `userData`。

桌面功能包括：

- NSIS 安装版和 portable `.exe`；
- 原生文件/文件夹与批量输出目录选择；
- 后台任务关闭提醒；
- 可最小化到托盘继续运行；
- 打开数据目录与导出诊断日志；
- 卸载默认保留用户数据。

## 2. 密钥

Electron 使用 `safeStorage` 包装一个随机主密钥，再把主密钥提供给服务端的 AES-GCM 端点密钥存储层。主密钥、API Key、Authorization header 不写入日志、SSE、HTML 或导出。

Web production 必须显式设置强随机 `AGENTIC_SECRET_KEY`。开发环境可生成 `data/.development-secret-key`，仅供本机开发。

## 3. 构建

```bash
npm ci
npm run typecheck
npm test
npm run build:standalone
npm run package:win
```

`package:win` 会在无空格的隔离暂存目录中为 Electron ABI 重建
`better-sqlite3`、准备 standalone 资源，并由 electron-builder 同时生成
NSIS 与 portable 目标。打包前会从 `app/icon.svg` 独立生成包含
16–256 px 多尺寸图层的 Windows ICO，避免依赖外部图标转换器。瞬时下载或
构建故障最多重试三次；确定性错误仍会以非零状态退出。它不会改写开发环境中
供 Node.js 使用的原生模块。

当前 Windows x64 产物位于 `dist-electron/`：

- `Agentic Translating-0.1.0-setup-x64.exe`
- `Agentic Translating-0.1.0-portable-x64.exe`

桌面运行时从 `resources/app` 启动 standalone 服务，并通过只读
`app.asar/node_modules` 解析服务器依赖；`better-sqlite3` 仍由
electron-builder 放入 `app.asar.unpacked`。构建机需要 Node.js 22+
和可用的 Windows C++ 构建工具链，以便预编译包缺失时从源码重建。

## 4. Docker

```bash
docker compose up --build
```

Compose 暴露 3000 端口并挂载持久数据卷。部署前必须替换 `AGENTIC_SECRET_KEY`，推荐在反向代理处配置 TLS、请求体大小、超时和访问控制。
`.dockerignore` 会排除本机数据库、测试证据、桌面产物和所有 `.env`
文件，避免把 BYOK 密钥带入构建上下文。

## 5. 备份与升级

1. 暂停批量任务并停止应用。
2. 复制整个数据目录，而不仅是 `app.db`；这样会一并保留 WAL、运行文件和加密所需本地材料。
3. 升级程序后首次启动自动执行增量迁移。
4. 若迁移或健康检查失败，停止新版并用完整数据目录备份回滚。

不要在应用运行且 WAL 尚未检查点时只复制单个 SQLite 主文件。

## 6. 自定义扩展

高级用户可通过 Agent 库和方向提示词包扩展角色，不需要修改 Electron。若修改源码，请保持稳定 ID、迁移幂等、旧 revision 只读兼容和公共 DTO 密钥隔离，并重新执行全部门禁。
