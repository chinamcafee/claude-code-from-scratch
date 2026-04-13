# 第 4-1 节：先搭好记忆目录、索引和增删查

这一小节结束后，你拿到的不是最终版 `src/memory.ts`，而是一个“可编译、可测试的阶段版”。

这个阶段版先只做三件事：根据项目路径创建记忆目录、把单条记忆写成 markdown + frontmatter 文件、以及自动生成和读取 `MEMORY.md` 索引。

## 本小节目标

1. 在 `src/memory.ts` 中导出 `getMemoryDir()`、`listMemories()`、`saveMemory()`、`deleteMemory()`、`loadMemoryIndex()`。
2. 成功创建和删除一条记忆文件。
3. 成功生成 `MEMORY.md` 索引。
4. 成功编译当前工程。

## 这份阶段版源码来自哪里

这一小节的阶段版 `src/memory.ts` 完全由参考文件中的这段原始源码组成：

- 第 1-167 行

## 手把手实操

### 步骤 1：用第一阶段版本覆盖 `src/memory.ts`

先把 `$TARGET_REPO/src/memory.ts` 整个替换成下面这份阶段版代码。

#### 当前阶段版 `src/memory.ts` 完整代码

````ts
// 这个模块实现一个文件型长期记忆系统：
// 1. 记忆文件按项目维度存到用户主目录下。
// 2. 每条记忆都是 markdown + frontmatter。
// 3. 提供索引、增删查、语义召回、以及给 system prompt 注入说明文案。

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync,
  unlinkSync, statSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import { parseFrontmatter, formatFrontmatter } from "./frontmatter.js";

// sideQuery 是一个轻量级模型查询函数，主 agent 会把它传进来做“语义选记忆”。
export type SideQueryFn = (system: string, userMessage: string, signal?: AbortSignal) => Promise<string>;

// ─── 记忆类型与数据结构 ─────────────────────────────────────

// 记忆类型故意限制在 4 类，方便模型理解与选择。
export type MemoryType = "user" | "feedback" | "project" | "reference";

export interface MemoryEntry {
  // 人类可读的记忆标题。
  name: string;
  // 一句话描述，主要用于索引与语义筛选。
  description: string;
  // 记忆分类。
  type: MemoryType;
  // 实际存盘的文件名。
  filename: string;
  // frontmatter 之后的正文内容。
  content: string;
}

// 所有允许的 type 做成 Set，便于快速校验。
const VALID_TYPES = new Set<MemoryType>(["user", "feedback", "project", "reference"]);
// `MEMORY.md` 索引文件的最大展示行数。
const MAX_INDEX_LINES = 200;
// `MEMORY.md` 索引文件的最大字节数。
const MAX_INDEX_BYTES = 25000;

// ─── 记忆目录与索引路径 ─────────────────────────────────────

function getProjectHash(): string {
  // 用 cwd 做哈希，让不同项目有各自独立的 memory 空间。
  return createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16);
}

export function getMemoryDir(): string {
  // 目录结构：~/.mini-claude/projects/<project-hash>/memory
  const dir = join(homedir(), ".mini-claude", "projects", getProjectHash(), "memory");
  // 第一次使用时自动创建目录。
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function getIndexPath(): string {
  // 所有记忆都共享一个 `MEMORY.md` 索引文件。
  return join(getMemoryDir(), "MEMORY.md");
}

// ─── 记忆文件名 slug 化 ─────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    // 只保留字母数字，其余统一转下划线，确保文件名稳定可预测。
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    // 控制长度，避免标题太长导致文件名难看或路径过长。
    .slice(0, 40);
}

// ─── 基本增删查 ─────────────────────────────────────────────

export function listMemories(): MemoryEntry[] {
  const dir = getMemoryDir();
  // 忽略 `MEMORY.md`，只把真正的记忆条目读出来。
  const files = readdirSync(dir).filter(
    (f) => f.endsWith(".md") && f !== "MEMORY.md"
  );
  const entries: MemoryEntry[] = [];
  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), "utf-8");
      const { meta, body } = parseFrontmatter(raw);
      // 缺失 name / type 的文件视为非法记忆，不参与返回。
      if (!meta.name || !meta.type) continue;
      entries.push({
        name: meta.name,
        description: meta.description || "",
        // type 非法时退回 `project`，避免脏数据把上层逻辑打断。
        type: (VALID_TYPES.has(meta.type as MemoryType) ? meta.type : "project") as MemoryType,
        filename: file,
        content: body,
      });
    } catch {
      // 坏文件直接跳过，保证记忆系统尽量可用。
    }
  }
  // 按修改时间倒序，让最近的记忆排在前面。
  entries.sort((a, b) => {
    try {
      const statA = statSync(join(dir, a.filename));
      const statB = statSync(join(dir, b.filename));
      return statB.mtimeMs - statA.mtimeMs;
    } catch {
      return 0;
    }
  });
  return entries;
}

export function saveMemory(entry: Omit<MemoryEntry, "filename">): string {
  const dir = getMemoryDir();
  // 文件名由 `type + slug(name)` 组成，方便人眼识别。
  const filename = `${entry.type}_${slugify(entry.name)}.md`;
  const content = formatFrontmatter(
    { name: entry.name, description: entry.description, type: entry.type },
    entry.content
  );
  writeFileSync(join(dir, filename), content);
  // 每次写记忆后都同步刷新索引，避免 MEMORY.md 过时。
  updateMemoryIndex();
  return filename;
}

export function deleteMemory(filename: string): boolean {
  const filepath = join(getMemoryDir(), filename);
  // 目标文件不存在时返回 false，让调用方知道这次删除没发生。
  if (!existsSync(filepath)) return false;
  unlinkSync(filepath);
  updateMemoryIndex();
  return true;
}

// ─── `MEMORY.md` 索引生成与读取 ────────────────────────────

function updateMemoryIndex(): void {
  const memories = listMemories();
  const lines = ["# Memory Index", ""];
  for (const m of memories) {
    // 索引里保留标题、文件名、类型、描述，便于人类查看和模型快速浏览。
    lines.push(`- **[${m.name}](${m.filename})** (${m.type}) — ${m.description}`);
  }
  writeFileSync(getIndexPath(), lines.join("\n"));
}

export function loadMemoryIndex(): string {
  const indexPath = getIndexPath();
  if (!existsSync(indexPath)) return "";
  let content = readFileSync(indexPath, "utf-8");
  // 为了控制 system prompt 体积，索引内容要做双重裁剪：
  // 1. 最多 200 行
  // 2. 最多 25KB
  const lines = content.split("\n");
  if (lines.length > MAX_INDEX_LINES) {
    content = lines.slice(0, MAX_INDEX_LINES).join("\n") +
      "\n\n[... truncated, too many memory entries ...]";
  }
  if (Buffer.byteLength(content) > MAX_INDEX_BYTES) {
    content = content.slice(0, MAX_INDEX_BYTES) +
      "\n\n[... truncated, index too large ...]";
  }
  return content;
}
````

### 步骤 2：先编译

```bash
cd "$TARGET_REPO"
npm run build
```

### 步骤 3：跑基础记忆存取测试

```bash
cd "$TARGET_REPO"
node --input-type=module <<'EOF'
import { saveMemory, listMemories, loadMemoryIndex, deleteMemory, getMemoryDir } from "./dist/memory.js";

const filename = saveMemory({
  name: "Alice Preference",
  description: "prefers concise answers",
  type: "user",
  content: "User prefers concise answers.",
});

console.log("dir:", getMemoryDir());
console.log("saved:", filename);
console.log("count:", listMemories().length);
console.log(loadMemoryIndex());
console.log("deleted:", deleteMemory(filename));
EOF
```

## 现在你应该看到什么

1. `npm run build` 可以通过。
2. 终端会打印出一个实际存在的记忆目录路径。
3. 你会看到类似 `saved: user_alice_preference.md` 的文件名。
4. `loadMemoryIndex()` 的输出里会出现 `# Memory Index` 和刚保存的那条记忆。
5. 最后一行应该是 `deleted: true`。

## 本小节的“手把手测试流程”

1. 先执行“步骤 1”，完整覆盖当前的 `src/memory.ts`。
2. 再执行“步骤 2”的 `npm run build`，确认第一阶段代码能编译。
3. 最后执行“步骤 3”的 Node 测试脚本，确认记忆文件和 `MEMORY.md` 索引都会被创建并可删除。
