# 第 4 章：记忆系统总览

`src/memory.ts` 不只是“存文件”，它把记忆目录、索引、manifest、新鲜度、语义召回和 system prompt 说明都放在了同一个文件里。

所以这一章也拆成 3 个独立文件。你要按顺序完成，每个文件都会给出当前阶段版或最终版 `src/memory.ts` 的完整代码，并在文末附带可执行测试步骤。

## 本章路线

1. [04-memory-01-storage-index.md](./04-memory-01-storage-index.md)：先搭好记忆目录、索引和增删查。
2. [04-memory-02-manifest-freshness.md](./04-memory-02-manifest-freshness.md)：补上头部扫描、manifest 和新鲜度判断。
3. [04-memory-03-semantic-recall-final.md](./04-memory-03-semantic-recall-final.md)：接上语义召回、预取和最终版收口。

## 这一章做完后的验收目标

1. `diff -u "$REFERENCE_REPO/src/memory.ts" "$TARGET_REPO/src/memory.ts"` 没有输出。
2. 你可以保存、列出、删除记忆，并自动生成 `MEMORY.md`。
3. 你可以跑通 `scanMemoryHeaders()`、`formatMemoryManifest()`、`selectRelevantMemories()`、`startMemoryPrefetch()`。


从这里开始：[04-memory-01-storage-index.md](./04-memory-01-storage-index.md)
