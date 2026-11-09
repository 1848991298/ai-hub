# 通用技能与个人扩展

公开版包含已审核的通用 [commit-by-business](commit-by-business/SKILL.md)：按业务拆分 Git 提交，核对多平台共享／独立调用链，并按授权提交、合入及推送。映射后可通过 `$commit-by-business` 调用；不含作者个人称呼、项目路径或仓库配置。

另预装 [git-worktree-audit](git-worktree-audit/SKILL.md)。映射后调用 `$git-worktree-audit`，盘点当前仓库全部分支和 worktree，列出未提交文件、相对本机上游引用的领先／落后、stash 与 Shelf，并结合实际差异提出建议。默认只读、不联网、不提交、不清理；采集脚本仅依赖 Python 标准库与 Git，不预装任何项目的盘点结果。

添加自己的 `<技能名称>/SKILL.md` 后，在根目录 `manifest.tsv` 中加入一行以制表符分隔的 `canonical`、技能名称和来源说明。映射前执行预检，已有同名技能内容不一致时先整合，不覆盖个人版本。

不整目录接管产品自带或第三方技能，不将未经许可的技能重新公开分发。
