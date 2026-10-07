# 本地准备

公开版本保留工作台实现，首次使用需要建立自己的运行环境。建议先运行开发界面和隔离测试，再接真实媒体任务。

1. 使用支持 `node:sqlite` 的 Node.js 24+，在本目录执行 `npm ci`、`npm run typecheck` 和 `npm run dev`，开发页在 3100 端口。
2. 将 `codex-auto-video-lab` 放到相邻目录，按该仓库说明准备 Python 3.12、FFmpeg 和需要的模型。默认查找相邻仓库，也可用 `DW_AUTO_EDIT_LAB_ROOT` 指定绝对路径。
3. 工作台自己的数据在 `data/`，首次配置生成账号、数据库和本机密钥。此目录被 Git 忽略；不要复用别人的登录文件、声音样本或员工任务。
4. 真正调用 Codex 时，用自己的账号授权。部分媒体工作目录校验沿用 Windows D 盘部署约束，使用前检查 `lib/codex-director.ts` 与自己磁盘布局是否一致。
5. 公开版不含原有的声音参考、试听文件、任务视频与 `.next` 构建目录。需要这些能力时，用自己的素材重新准备。生成提示词方案后，仍由使用者在对应视频平台执行。

```powershell
$env:DW_AUTO_EDIT_LAB_ROOT = 'D:\projects\codex-auto-video-lab'
npm run test:concurrency
npm run test:edit-templates
```

`scripts/start-server.ps1` 是 Windows 服务运行辅助脚本，包含端口与进程清理策略。公开整理没有执行它，也没有接管本机当前服务。真实上线前应自行确认端口、授权与可写目录。
