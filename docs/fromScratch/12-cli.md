# 第 12 章：CLI 入口总览

`src/cli.ts` 是最后一个正式源码文件。它既要解析参数，也要管理 REPL，还要负责主程序启动、API key 选择和会话恢复。

所以这一章拆成 2 个独立文件：先得到一个“可用的最小 CLI 阶段版”，再替换成最终版。

## 本章路线

1. [12-cli-01-minimal-repl.md](./12-cli-01-minimal-repl.md)：先接上参数解析、最小 REPL 和主启动流程。
2. [12-cli-02-full-cli-final.md](./12-cli-02-full-cli-final.md)：补上内建命令、技能调用和最终版收口。

## 这一章做完后的验收目标

1. `diff -u "$REFERENCE_REPO/src/cli.ts" "$TARGET_REPO/src/cli.ts"` 没有输出。
2. 你可以运行 `node dist/cli.js --help`。
3. 你可以进入 REPL，并测试 `/clear /plan /cost /compact /memory /skills` 等命令。


从这里开始：[12-cli-01-minimal-repl.md](./12-cli-01-minimal-repl.md)
