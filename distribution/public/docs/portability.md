# 迁移与恢复

公开仓库提供源码和通用模板，不附带任何用户的账号、固定技能或本机状态。克隆或解压后先运行 `bash setup.command`，网页通过 `bash start.command` 启动。

## 规则与技能入口

固定入口为 `~/.ai-hub`。先编辑自己的 `rules/global.md`；技能来源位于 `skills/<name>/SKILL.md`，以 `manifest.tsv` 登记的 canonical 清单为准。`bash scripts/pull.sh --check` 是只读检查，实际写入需要使用者确认并设置 `AI_HUB_APPLY_LIVE=1`。

现有来源或客户端正文不一致时会停止。不要为安装公开版删除其他客户端内容；需要迁移已安装来源时先核对差异，再使用 `--relocate`。首次安装不需要把所有产品自带技能或第三方技能搬入这个目录。

## 本人自己的迁移包

```bash
python3 scripts/hub.py doctor
python3 scripts/hub.py export --output dist/my-hub.tar.gz
```

这是本人使用的来源迁移包，包含本人登记的规则和技能，不是自动脱敏的公开分发包。迁移包不携带 `.local/`、历史备份、编译产物和账号登录态；换机后仍需安装依赖、重新登录并核对工程路径。

需要重新公开通用源码时使用 `python3 scripts/export_public_hub.py`，不要把本人迁移包直接公开。

恢复映射前先运行只读核对：

```bash
python3 scripts/hub.py restore --backup .backups/实际批次
```

核实范围后才加 `--apply`。工具保留替换前备份；不要删除或硬重置来源来跳过冲突。
