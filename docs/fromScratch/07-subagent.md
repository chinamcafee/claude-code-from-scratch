# 第 7 章：子代理配置层总览

`src/subagent.ts` 既要提供内置子代理类型，也要扫描和解析 `.claude/agents/*.md`，还要把这些能力整理成后续 prompt 可见的描述文本。

所以这一章拆成 2 个独立文件。

## 本章路线

1. [07-subagent-01-config-core.md](./07-subagent-01-config-core.md)：先搭好内置 / 自定义 agent 的配置返回。
2. [07-subagent-02-descriptions-final.md](./07-subagent-02-descriptions-final.md)：补上 agent 类型说明文本并收口到最终版。

## 这一章做完后的验收目标

1. `diff -u "$REFERENCE_REPO/src/subagent.ts" "$TARGET_REPO/src/subagent.ts"` 没有输出。
2. 你可以调用 `getSubAgentConfig()` 获得内置或自定义子代理配置。
3. 你可以调用 `getAvailableAgentTypes()` 和 `buildAgentDescriptions()`。


从这里开始：[07-subagent-01-config-core.md](./07-subagent-01-config-core.md)
