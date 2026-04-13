# 第 4-2 节：补上头部扫描、manifest 和新鲜度判断

这一小节仍然不是最终版 `src/memory.ts`。

你会在上一节的基础上继续扩展：让系统先轻量扫描每个记忆文件的头部元数据，再把它们整理成 manifest，同时补上“距今多久”和“是否过期”的提示函数。

## 本小节目标

1. 导出 `scanMemoryHeaders()`、`formatMemoryManifest()`、`memoryAge()`、`memoryFreshnessWarning()`。
2. 能扫描出记忆文件名、描述、类型和修改时间。
3. 能把扫描结果压成多行 manifest 文本。
4. 成功编译当前工程。

## 这份阶段版源码来自哪里

这一小节的阶段版 `src/memory.ts` 完全由参考文件中的这段原始源码组成：

- 第 1-252 行

## 手把手实操

### 步骤 1：用第二阶段版本覆盖 `src/memory.ts`

把上一节的阶段版 `src/memory.ts` 整个替换成下面这份第二阶段代码。

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

// ─── 轻量扫描 memory 头部信息 ───────────────────────────────

export interface MemoryHeader {
  // 文件名，例如 `project_architecture_note.md`。
  filename: string;
  // 绝对路径，后续真正读取全文时会直接用到。
  filePath: string;
  // 修改时间，用于排序与新鲜度提示。
  mtimeMs: number;
  // 从 frontmatter 读到的简述。
  description: string | null;
  // 从 frontmatter 读到的类型；非法值会被转成 `undefined`。
  type: MemoryType | undefined;
}

// 语义筛选时最多看 200 个记忆文件，避免 memory 太多时 selector 提示词失控。
const MAX_MEMORY_FILES = 200;
// 真正注入上下文的单条记忆最多保留 4KB。
const MAX_MEMORY_BYTES_PER_FILE = 4096;
// 单次会话累计最多注入 60KB 记忆，防止记忆不断堆积把上下文吃光。
const MAX_SESSION_MEMORY_BYTES = 60 * 1024;

// 扫描 memory 目录时只读取每个文件前 30 行，尽量避免把所有正文都读进来。
export function scanMemoryHeaders(): MemoryHeader[] {
  const dir = getMemoryDir();
  const files = readdirSync(dir).filter(
    (f) => f.endsWith(".md") && f !== "MEMORY.md"
  );
  const headers: MemoryHeader[] = [];
  for (const file of files) {
    try {
      const filePath = join(dir, file);
      const stat = statSync(filePath);
      const raw = readFileSync(filePath, "utf-8");
      // frontmatter 一般都在文件最前面，所以只截前 30 行做轻量解析。
      const first30 = raw.split("\n").slice(0, 30).join("\n");
      const { meta } = parseFrontmatter(first30);
      headers.push({
        filename: file,
        filePath,
        mtimeMs: stat.mtimeMs,
        description: meta.description || null,
        type: VALID_TYPES.has(meta.type as MemoryType) ? (meta.type as MemoryType) : undefined,
      });
    } catch {
      // 任意文件损坏都直接跳过。
    }
  }
  // 最新的记忆优先参与候选，且总量封顶。
  headers.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return headers.slice(0, MAX_MEMORY_FILES);
}

// 把记忆头部压成“每条一行”的 manifest，发给模型做相关性筛选。
export function formatMemoryManifest(headers: MemoryHeader[]): string {
  return headers
    .map((h) => {
      const tag = h.type ? `[${h.type}] ` : "";
      // 时间戳转成 ISO 字符串，便于模型判断先后和新旧。
      const ts = new Date(h.mtimeMs).toISOString();
      return h.description
        ? `- ${tag}${h.filename} (${ts}): ${h.description}`
        : `- ${tag}${h.filename} (${ts})`;
    })
    .join("\n");
}

// ─── 新鲜度描述与提醒 ───────────────────────────────────────

export function memoryAge(mtimeMs: number): string {
  // 以“距今天数”这种粗粒度描述就足够让模型判断是否过时。
  const days = Math.max(0, Math.floor((Date.now() - mtimeMs) / 86_400_000));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

export function memoryFreshnessWarning(mtimeMs: number): string {
  const days = Math.max(0, Math.floor((Date.now() - mtimeMs) / 86_400_000));
  // 1 天以内不提示，避免对刚存的记忆过度提醒。
  if (days <= 1) return "";
  // 旧记忆注入前会带上这一段，提醒模型不要把它当实时真相。
  return `This memory is ${days} days old. Memories are point-in-time observations, not live state — claims about code behavior may be outdated. Verify against current code before asserting as fact.`;
}
````

### 步骤 2：先编译

```bash
cd "$TARGET_REPO"
npm run build
```

### 步骤 3：测试头部扫描和 manifest

```bash
cd "$TARGET_REPO"
node --input-type=module <<'EOF'
import { saveMemory, deleteMemory, scanMemoryHeaders, formatMemoryManifest, memoryAge, memoryFreshnessWarning } from "./dist/memory.js";

const a = saveMemory({
  name: "Build Notes",
  description: "notes about local build commands",
  type: "project",
  content: "Run npm run build before smoke tests.",
});
const b = saveMemory({
  name: "Dashboard Link",
  description: "points to internal dashboard",
  type: "reference",
  content: "https://example.com/dashboard",
});

const headers = scanMemoryHeaders();
console.log("headers:", headers.length);
console.log(formatMemoryManifest(headers));
if (headers[0]) {
  console.log("age:", memoryAge(headers[0].mtimeMs));
  console.log("warning:", memoryFreshnessWarning(headers[0].mtimeMs));
}
console.log("cleanup-a:", deleteMemory(a));
console.log("cleanup-b:", deleteMemory(b));
EOF
```

## 现在你应该看到什么

1. `npm run build` 可以通过。
2. 终端会打印出 `headers:`，数量至少包含你刚刚创建的两条记忆。
3. manifest 文本里会出现带时间戳的 `project_...md` 和 `reference_...md`。
4. `memoryAge(...)` 对刚创建的文件通常会返回 `today`。
5. 两条 `cleanup-*` 都应该是 `true`。

## 本小节的“手把手测试流程”

1. 先执行“步骤 1”，把 `src/memory.ts` 升级到第二阶段。
2. 再执行“步骤 2”的 `npm run build`。
3. 最后执行“步骤 3”的测试脚本，确认扫描、manifest 和新鲜度判断都已可用。
