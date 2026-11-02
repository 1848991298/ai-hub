# AI Hub

完整的本地 AI 工作台源码：管理工程、个人规则与技能、客户端映射、模型用量、飞书问题与任务，以及 ISHO 应用运营。包含 React 网页、Python 服务和 macOS App 外壳；不是只有运营大屏。

仓库保留早期 `isho-operations` 地址，当前根目录已经是完整 AI Hub。公开版不预装作者的个人规则、固定技能、工程清单、飞书资源或商店登录资料。

## Mac 快速运行

需要 Python 3.9+、Node.js 22.12+、Git；可通过 Homebrew 安装 Python 和 Node。先在 GitHub 点击 **Code → Download ZIP** 解压，或克隆仓库，再进入项目目录：

```bash
bash setup.command
bash start.command
```

首次初始化会安装前端和商店浏览器依赖并构建页面，需要联网。启动后浏览器打开 `http://127.0.0.1:4317`；关闭终端或按 `Control+C` 停止本机服务。端口占用时可运行 `bash start.command --port 4318`。已有其他 Hub 目录时，请分别使用不同端口，不要覆盖已有数据。

## 按模块使用

| 模块 | 功能与入口 | 首次使用需要做什么 |
| --- | --- | --- |
| 工作台与外观 | 工程入口、主题、字号、可调面板与搜索 | 默认只登记当前 Hub；外观保存在本机 |
| 工程合集 | 选择目录、读取 Git 分支和 worktree、打开 SourceTree | 在界面添加自己的目录；不会替你 checkout、提交或推送 |
| Rules | 编辑自己的共享规则；核对 Cursor User Rules 与 Codex 入口 | 先填写 `rules/global.md`，查看映射差异；Cursor 原生操作需本机权限 |
| Skills | 查看 `skills/` 中登记的技能及其映射 | 默认无个人固定技能；添加自己的技能并登记 `manifest.tsv` |
| 客户端与变更 | 检查映射、工作区差异和迁移／恢复来源 | 文件链接和客户端实际加载是两种状态，分别核实 |
| 用量中心 | 读取本机可用的 CodexBar／ccusage 来源，按日期看用量 | 自行安装、登录相应来源；没有来源时显示未接入 |
| 问题与任务 | 读取、创建、修改自己的飞书多维表记录 | 配置自己的表和字段；未配置时不查询任何飞书资源 |
| 应用运营 | ISHO 版本／审核、下载、评论、CSV 与大屏 | 自行登录商店并具备 `com.jryx.isho` 的查询权限 |
| 独立运营工具 | 脱离完整 Hub，提供独立／共享服务器开关 | 按下方命令导出后运行；不复制 Hub 数据 |

### 自己的规则与技能

公开版只提供通用规则模板；不会安装原作者的固定技能。浏览工作台不需要先写入客户端全局配置。需要映射时先检查：

```bash
bash scripts/pull.sh --check
```

确认检查结果和已有差异后，才执行：

```bash
AI_HUB_APPLY_LIVE=1 bash scripts/pull.sh --apply --to both
```

固定入口是 `~/.ai-hub`。已有其他入口或规则存在差异时工具会停止，不要为了安装公开版直接覆盖它们。Codex 全局入口及个人技能使用链接；Cursor 共享正文由引导规则指向，原生 User Rules 同步还需要 Cursor 正在运行及系统辅助功能／自动化权限。不要把映射文件存在当作客户端已经加载。

### 模型用量

用量来源和账号由使用者自行准备。可选 ccusage 依赖可运行 `npm --prefix scripts/usage-tools ci` 安装；CodexBar 按自己的账号登录。该模块读取的是本机来源，不会带入作者的消耗记录或账号资料。

### 飞书问题与任务

安装并登录 `lark-cli` 后，复制配置示例到本机忽略目录，填入自己的 Base、表和字段 ID：

```bash
mkdir -p .local
cp tracker-config.example.json .local/tracker-config.json
chmod 600 .local/tracker-config.json
```

需要两张表（问题、任务），各有内容、状态、创建时间、截止时间、优先级、备注字段。状态为“未启动／进行中／已结束”，优先级为 P0／P1／P2。配置后重新启动服务。未配置或配置无效时，不会自动查询任何人的表；新增／修改仍受当前飞书账号权限控制，冲突不直接覆盖。

### ISHO 应用运营

OPPO、vivo、小米已有只读采集实现；荣耀、应用宝保留入口，实际字段按适配器和账号权限核实。固定应用包名为 `com.jryx.isho`，不是任意产品通用采集器。商店登录过期时需在官方窗口补登；不会自动上传、提审、发布或回复评论。新增、活跃、留存及业务上传量需来自业务后端，未知值不填零。

完整 Hub 默认保存本机记录；需要独立／共享开关时，导出独立运营工具：

```bash
python3 scripts/export_market.py --directory .build/operations
cd .build/operations
bash setup.command
bash start.command
```

独立工具保留中文说明、初始化和启动脚本。共享模式连接已部署的运营服务，失败不回退本机；模式切换不自动迁移或合并数据。`deploy/market/` 提供共享网页／数据 API 容器配置，但不代表云端采集已经部署。

### 可选 macOS App

需要 Xcode 命令行工具，在项目根目录运行：

```bash
python3 scripts/build_macos_app.py
```

生成的 `dist/AI Hub.app` 是本机架构的 App，仍需要 Python、源码目录和已安装的依赖；不是免运行环境安装包。首次运行选择自己的 Hub 来源目录即可。应用运营也可以通过网页使用。

## 本地数据与公开范围

`.local/` 保存工程登记、界面偏好、台账配置、数据库、采集状态和登录资料；`.backups/`、`archive/`、`dist/`、`.build/` 和依赖只保存在本机。不要上传这些内容，不复制别人的登录态、钥匙串或数据库。

使用者添加自己的规则、技能、项目和资源地址后，再公开自己的 fork 前须重新检查。`scripts/export_public_hub.py` 按白名单重新导出通用源码，遇到个人路径、私人资源地址或凭据模式会停止；该检查不能替代人工审查。

## 验证

```bash
python3 -m unittest discover -s scripts -p 'test_*.py'
node --test ui/src/*.test.js
node --test scripts/market-browser/test-*.mjs
npm --prefix ui run build
```

测试采用临时数据和夹具；同事真实账号、辅助功能权限、设备与服务器需在自己的环境验证。没有附开源许可证时，不代表授予任意再分发或商业使用权。
