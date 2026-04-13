# 第 6 章：工具系统总览

`src/tools.ts` 代码量很大，所以这一章不再把多个子章节塞进同一个文件里。

从这一章开始，请按下面 3 个独立文件顺序往下做。每个文件都会给出当前阶段版 `src/tools.ts` 的完整代码，并且在文末附带可执行的测试步骤。

## 本章路线

1. [06-tools-01-schema.md](./06-tools-01-schema.md)：先搭好工具类型、schema 和 deferred tool 激活机制。
2. [06-tools-02-execution.md](./06-tools-02-execution.md)：把本地工具执行器和 `executeTool()` 接上。
3. [06-tools-03-permissions-final.md](./06-tools-03-permissions-final.md)：补齐权限系统，完成最终版 `src/tools.ts`。

## 这一章做完后的验收目标

当你做完第 3 个子文件时，应该满足下面两条：

1. `diff -u "$REFERENCE_REPO/src/tools.ts" "$TARGET_REPO/src/tools.ts"` 没有输出。
2. 你可以运行 `checkPermission()`、`executeTool()`、`tool_search`、`web_fetch` 相关测试。

从这里开始：[06-tools-01-schema.md](./06-tools-01-schema.md)
