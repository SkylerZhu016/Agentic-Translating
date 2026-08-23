# Windows Desktop and Self-Deployment

## 1. Windows Desktop Architecture

The Electron main process starts the packaged Next.js standalone server and loads the local window after a successful health check. The application uses a single-instance lock. The database, runtime files, and logs are stored under `AGENTIC_DATA_DIR`, which points to Electron's `userData`.

Desktop features include:

- NSIS installer and portable `.exe`
- Native file/folder selection and batch output directory selection
- Background task closing reminder
- Minimize to system tray to continue running
- Open data directory and export diagnostic logs
- Uninstall preserves user data by default

## 2. Encryption Keys

Electron uses `safeStorage` to wrap a random master key, then provides that master key to the server-side AES-GCM endpoint key storage layer. The master key, API keys, and Authorization header are never written to logs, SSE, HTML, or exports.

In production web environments, a strong random `AGENTIC_SECRET_KEY` must be set explicitly. For development, a `data/.development-secret-key` file can be generated for local development only.

## 3. Build

Source development and standalone preview are deliberately separate:

```bash
npm run desktop
npm run build:standalone
npm run desktop:preview
```

`desktop` starts Electron plus a managed Next.js development server and uses `.next-electron-dev`; no standalone build is required. The normal `dev` command uses `.next-web-dev`, so simultaneous source entry points do not write the same Next cache. `desktop:preview` reads only the existing `.next/standalone` tree. If it is missing, the app explains which two commands to run and exits without building anything. Packaged applications always start `resources/app/server.js` and never fall back to a source or development server.

```bash
npm ci
npm run typecheck
npm test
npm run build:standalone
npm run package:win
```

`build:standalone` cleans only the reproducible `.next/standalone` output. It removes local paths such as `.omo/`, `data/`, `迭代文档/`, and the complete `FSBP_Test/` dataset tree if tracing copied them, then automatically runs the release-tree scan. Next's tracing exclusions reduce unnecessary copies, while this post-processing cleanup is the cross-platform release boundary because Next 15 tracing on Windows may not apply POSIX exclude globs to backslash-normalized paths. After the scan passes, the command uses an isolated temporary data directory and random key to start the real standalone server on an OS-assigned non-3000 port and waits for `/api/health/ready`. The build fails when it finds a database, dataset/private experiment artifact, runtime record, development note, possible credential, or missing runtime dependency. Existing services and real workspace data directories are never stopped, deleted, or rewritten.

`package:win` rebuilds `better-sqlite3` for the Electron ABI in a temporary staging directory without spaces, prepares the standalone assets, and lets electron-builder produce both NSIS and portable targets simultaneously. Before packaging, a Windows ICO with multiple layers ranging from 16 to 256 px is generated from `app/icon.svg`, eliminating the need for external icon conversion tools. Transient download or build failures retry up to three times; deterministic errors still exit with a non-zero status. The command does not overwrite native modules used by Node.js in the development environment.

Current Windows x64 artifacts live under `dist-electron/`:

- `Agentic Translating-0.1.1-setup-x64.exe`
- `Agentic Translating-0.1.1-portable-x64.exe`

At runtime, the desktop app starts the standalone server from `resources/app` and resolves server dependencies through read-only `app.asar/node_modules`. `better-sqlite3` is placed in `app.asar.unpacked` by electron-builder. The build machine requires Node.js 22 or later and a working Windows C++ build toolchain, so that prebuilt packages can be rebuilt from source when missing.

## 4. Docker

```bash
docker compose up --build
```

The Compose setup exposes port 3000 and mounts a persistent data volume. Before deployment, replace `AGENTIC_SECRET_KEY`. It is recommended to configure TLS, request body size, timeouts, and access control at the reverse proxy layer. The `.dockerignore` excludes local databases, test artifacts, desktop build outputs, and all `.env` files to prevent BYOK keys from entering the build context.

## 5. Backup and Upgrade

1. Pause batch tasks and stop the application.
2. Copy the entire data directory, not just `app.db`. This preserves WAL files, runtime files, and the local material needed for encryption.
3. On first launch after upgrading, the application automatically runs incremental migrations.
4. If migration or health check fails, stop the new version and roll back using the full data directory backup.

Do not copy only the single SQLite main file while the application is running and the WAL has not been checkpointed.

## 6. Custom Extensions

Advanced users can extend roles through the Agent library and direction prompt packs without modifying Electron. If you modify the source code, keep stable IDs, migration idempotency, backward-compatible read-only old revisions, and public DTO key isolation, and re-run all gating checks.
