# Mini Claude Code From Scratch

这套文档不是讲“架构概念”，而是讲“你现在就开一个全新的工程，严格对照当前仓库的源码，一章一章手搓到 1:1 复刻”。

## 你要先接受的约束

1. 第 1 章只负责把新工程搭起来，所以允许先放一个占位版 `src/cli.ts`。
2. 从第 2 章开始，所有“正式源码”都必须原封不动来自当前仓库的 `src/`。
3. 每一章都要先做实操，再看解释。
4. 每一章结束都要跑一遍“手把手测试流程”。
5. 如果你手打了代码，不要靠感觉判断对不对，直接用 `diff -u` 校验。

## 先约定两个目录

下面所有章节都默认你先在终端里执行这两行：

```bash
export REFERENCE_REPO=/Users/changzechuan/AIProjects/claude-code-from-scratch
export TARGET_REPO=$HOME/dev/mini-claude-rebuild
```

- `$REFERENCE_REPO`：当前这份参考仓库，也就是你现在正在看的仓库。
- `$TARGET_REPO`：你准备从零重建的新工程目录。

## 这套文档的使用方式

1. 打开 `$REFERENCE_REPO`，把它当作“标准答案仓库”。
2. 在 `$TARGET_REPO` 里按照章节顺序操作。
3. 每一章只新增本章要求的文件，不抢跑。
4. 每一章新增完，先 `npm run build`，再跑本章测试。
5. 第 12 章最后一个子文件结束时，你的 `$TARGET_REPO/src` 应该和 `$REFERENCE_REPO/src` 完全一致。

## 章节路线图

| 章节 | 目标 | 本章新增的正式源码 |
| --- | --- | --- |
| [01-create-project.md](./01-create-project.md) | 从零创建一个可编译的新工程 | 无，只有占位文件 |
| [02-frontmatter.md](./02-frontmatter.md) | 搭好 frontmatter 解析基础设施 | `src/frontmatter.ts`（57 行） |
| [03-session.md](./03-session.md) | 实现会话存储与恢复 | `src/session.ts`（79 行） |
| [04-memory.md](./04-memory.md) | 记忆系统总览 | 进入 04-1 ~ 04-3 |
| [04-memory-01-storage-index.md](./04-memory-01-storage-index.md) | 先搭好记忆存储、索引和增删查 | `src/memory.ts` 阶段版 1 |
| [04-memory-02-manifest-freshness.md](./04-memory-02-manifest-freshness.md) | 头部扫描、manifest 和新鲜度 | `src/memory.ts` 阶段版 2 |
| [04-memory-03-semantic-recall-final.md](./04-memory-03-semantic-recall-final.md) | 语义召回与最终版收口 | `src/memory.ts`（439 行） |
| [05-skills.md](./05-skills.md) | 技能系统总览 | 进入 05-1 ~ 05-2 |
| [05-skills-01-discovery-execution.md](./05-skills-01-discovery-execution.md) | 技能发现、解析和执行结果整理 | `src/skills.ts` 阶段版 1 |
| [05-skills-02-descriptions-final.md](./05-skills-02-descriptions-final.md) | 技能说明文本与最终版收口 | `src/skills.ts`（207 行） |
| [06-tools.md](./06-tools.md) | 工具系统总览 | 进入 06-1 ~ 06-3 |
| [06-tools-01-schema.md](./06-tools-01-schema.md) | schema 与 deferred 激活阶段版 | `src/tools.ts` 阶段版 1 |
| [06-tools-02-execution.md](./06-tools-02-execution.md) | 本地工具执行器阶段版 | `src/tools.ts` 阶段版 2 |
| [06-tools-03-permissions-final.md](./06-tools-03-permissions-final.md) | 权限系统与最终版收口 | `src/tools.ts`（925 行） |
| [07-subagent.md](./07-subagent.md) | 子代理配置层总览 | 进入 07-1 ~ 07-2 |
| [07-subagent-01-config-core.md](./07-subagent-01-config-core.md) | 内置 / 自定义 agent 配置返回 | `src/subagent.ts` 阶段版 1 |
| [07-subagent-02-descriptions-final.md](./07-subagent-02-descriptions-final.md) | agent 类型说明文本与最终版收口 | `src/subagent.ts`（229 行） |
| [08-prompt.md](./08-prompt.md) | Prompt 组装总览 | 进入 08-1 ~ 08-3 |
| [08-prompt-01-claude-rules.md](./08-prompt-01-claude-rules.md) | `CLAUDE.md`、rules 和 `@include` 展开 | `src/prompt.ts` 阶段版 1 |
| [08-prompt-02-git-context.md](./08-prompt-02-git-context.md) | Git 上下文采集阶段版 | `src/prompt.ts` 阶段版 2 |
| [08-prompt-03-system-prompt-final.md](./08-prompt-03-system-prompt-final.md) | system prompt 模板与最终版收口 | `src/prompt.ts`（261 行） |
| [09-ui.md](./09-ui.md) | 终端输出层总览 | 进入 09-1 ~ 09-3 |
| [09-ui-01-basic-output.md](./09-ui-01-basic-output.md) | 基础打印函数和工具摘要辅助函数 | `src/ui.ts` 阶段版 1 |
| [09-ui-02-spinner.md](./09-ui-02-spinner.md) | spinner 动画阶段版 | `src/ui.ts` 阶段版 2 |
| [09-ui-03-plan-subagent-final.md](./09-ui-03-plan-subagent-final.md) | 计划审批 / 子代理提示与最终版收口 | `src/ui.ts`（235 行） |
| [10-mcp.md](./10-mcp.md) | 接入 MCP 连接与工具桥接 | `src/mcp.ts`（295 行） |
| [11-agent.md](./11-agent.md) | Agent 内核总览 | 进入 11-1 ~ 11-3 |
| [11-agent-01-foundation.md](./11-agent-01-foundation.md) | Agent 基础状态阶段版 | `src/agent.ts` 阶段版 1 |
| [11-agent-02-history-budget.md](./11-agent-02-history-budget.md) | 历史管理与预算阶段版 | `src/agent.ts` 阶段版 2 |
| [11-agent-03-full-runtime.md](./11-agent-03-full-runtime.md) | 最终版 Agent runtime | `src/agent.ts`（1615 行） |
| [12-cli.md](./12-cli.md) | CLI 入口总览 | 进入 12-1 ~ 12-2 |
| [12-cli-01-minimal-repl.md](./12-cli-01-minimal-repl.md) | 参数解析、最小 REPL 和主启动流程 | `src/cli.ts` 阶段版 1 |
| [12-cli-02-full-cli-final.md](./12-cli-02-full-cli-final.md) | 完整 REPL 与最终版收口 | `src/cli.ts`（416 行） |
| [13-full-verification.md](./13-full-verification.md) | 做最终 1:1 验收 | 不新增源码，做总验证 |

补充说明：

1. 大文件章节不再在同一个 Markdown 里塞多个章内子章节，而是拆成独立文件。
2. 每个拆出来的子文件末尾都附带可执行测试步骤。
3. 所有“复制源码”的位置，现在都会直接给出可照抄的完整代码或阶段版完整代码。

## 和现有 `docs/` 的关系

`docs/` 目录下原有文档更偏“架构解释”。

这套 `docs/fromScratch/` 更偏“实操施工图”。

推荐配合方式：

1. 先按这里的章节把代码一步步搭出来。
2. 如果你在某一章想深入理解，再回头看同主题的老文档。

大致对应关系如下：

| fromScratch | 对照阅读 |
| --- | --- |
| 第 4 章 Memory | `../08-memory.md` |
| 第 6 章 Tools | `../02-tools.md`、`../06-permissions.md`、`../07-context.md` |
| 第 8 章 Prompt | `../03-system-prompt.md` |
| 第 10 章 MCP | `../12-mcp.md` |
| 第 11 章 Agent | `../01-agent-loop.md`、`../05-streaming.md`、`../10-plan-mode.md`、`../11-multi-agent.md` |
| 第 12 章 CLI | `../04-cli-session.md` |
| 第 13 章验收 | `../14-testing.md` |

## 最终验收标准

到第 13 章结束时，你至少要满足这 4 条：

1. `diff -ruN "$REFERENCE_REPO/src" "$TARGET_REPO/src"` 没有输出。
2. `diff -u "$REFERENCE_REPO/package.json" "$TARGET_REPO/package.json"` 没有输出。
3. `diff -u "$REFERENCE_REPO/tsconfig.json" "$TARGET_REPO/tsconfig.json"` 没有输出。
4. 你能在 `$TARGET_REPO` 里跑起 `node dist/cli.js --help`，并完成至少一次真实对话。

先从第 1 章开始：[01-create-project.md](./01-create-project.md)
