# 第 8 章：Prompt 组装总览

`src/prompt.ts` 一口气承担了 `@include` 展开、rules 自动加载、递归合并各级 `CLAUDE.md`、Git 上下文采集，以及最终的 system prompt 模板替换。

所以这一章也拆成 3 个独立文件。

## 本章路线

1. [08-prompt-01-claude-rules.md](./08-prompt-01-claude-rules.md)：先搭好 `CLAUDE.md`、rules 和 `@include` 展开。
2. [08-prompt-02-git-context.md](./08-prompt-02-git-context.md)：补上 Git 上下文采集。
3. [08-prompt-03-system-prompt-final.md](./08-prompt-03-system-prompt-final.md)：接上 system prompt 模板并收口到最终版。

## 这一章做完后的验收目标

1. `diff -u "$REFERENCE_REPO/src/prompt.ts" "$TARGET_REPO/src/prompt.ts"` 没有输出。
2. 你可以解析各级 `CLAUDE.md`、rules 和 `@include`。
3. 你可以调用 `getGitContext()` 和 `buildSystemPrompt()`。


从这里开始：[08-prompt-01-claude-rules.md](./08-prompt-01-claude-rules.md)
