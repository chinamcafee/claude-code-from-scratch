# 第 11 章：Agent 内核总览

`src/agent.ts` 是整个项目里最大的文件，所以这一章不再把多个子章节塞进一个 Markdown。

从这里开始，请按下面 3 个独立文件顺序往下做。每个文件都会给出当前阶段版或最终版 `src/agent.ts` 的完整代码，并在末尾附带可执行测试步骤。

## 本章路线

1. [11-agent-01-foundation.md](./11-agent-01-foundation.md)：先搭好构造器、基础状态、thinking 策略和 plan mode 基础切换。
2. [11-agent-02-history-budget.md](./11-agent-02-history-budget.md)：补上历史管理、成本预算和会话恢复。
3. [11-agent-03-full-runtime.md](./11-agent-03-full-runtime.md)：替换成最终版 `src/agent.ts`，接上完整 runtime。

## 这一章做完后的验收目标

当你做完最后一个子文件时，应该满足：

1. `diff -u "$REFERENCE_REPO/src/agent.ts" "$TARGET_REPO/src/agent.ts"` 没有输出。
2. 你可以成功实例化 `Agent`。
3. 你可以跑通本地 smoke test。
4. 如果你配置了真实模型，还可以做一次最小对话。

从这里开始：[11-agent-01-foundation.md](./11-agent-01-foundation.md)
