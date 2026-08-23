# round-0820 凭据入口

`npm run experiment:round0820:run -- ...` 直接启动安全主 runner。运行前只配置一种凭据来源：进程环境变量 `FSBP_EXPERIMENT_API_KEY`，或指向仓库外 OS 临时文件的 `FSBP_EXPERIMENT_KEY_FILE`。两者同时存在时 runner 以 `conflicting_sources` 终止；两者都不存在时同样终止，不会发起模型请求。

临时文件模式会在每次物理请求前重新读取文件，并校验连接 URL 与冻结实验端点一致。文件必须位于 Node 识别的真实 OS 临时目录，是链接数为 1 的普通文件；符号链接、junction/reparse 路径、硬链接、目录、实际仓库或 `--repo-root` 所选仓库内的路径都会被拒绝。Key 不应写入命令参数、仓库、报告或冻结清单。

`npm run experiment:round0820:run:legacy-key-file -- --key-file <仓库外的 OS 临时文件> ...` 仅为显式兼容入口；它没有默认 Key 文件，也不会把 Key 放入子进程参数。

应用数据库升级到 migration 17 时会在事务内逻辑清除历史 `sessions.config_snapshot` 中结构化保存的 Key 字段；当前 preflight 快路径也会以 compare-and-swap 方式惰性清理遗漏记录。该迁移不会自动执行 `VACUUM`、`secure_delete` 或破坏性 WAL 重写，因此它保证活动数据库记录和公开 DTO 不再暴露这些字段，不承诺从旧 WAL、备份或底层介质中完成取证级擦除。
