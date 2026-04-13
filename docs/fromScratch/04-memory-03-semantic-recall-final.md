# 第 4-3 节：接上语义召回、预取和最终版 `memory.ts`

这一小节会把 `src/memory.ts` 收口到最终版。

你会在上一节基础上补上语义召回、预取句柄、记忆注入格式化，以及给 system prompt 用的 `buildMemoryPromptSection()`。做完以后，这个文件就和参考仓库完全一致。

## 本小节目标

1. 导出 `selectRelevantMemories()`、`startMemoryPrefetch()`、`formatMemoriesForInjection()`、`buildMemoryPromptSection()`。
2. 可以用一个假的 `sideQuery` 跑通记忆筛选。
3. 可以做 `diff` 确认当前 `src/memory.ts` 和参考仓库零差异。
4. 成功编译当前工程。

## 这份阶段版源码来自哪里

这一小节直接使用参考仓库最终版 `src/memory.ts`：

- 第 1-439 行

## 手把手实操

### 步骤 1：用最终版覆盖 `src/memory.ts`

把 `$TARGET_REPO/src/memory.ts` 整个替换成下面这份最终代码。

#### 最终版 `src/memory.ts` 完整代码

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

// ─── 语义召回：先筛文件，再读取正文 ─────────────────────────

const SELECT_MEMORIES_PROMPT = `You are selecting memories that will be useful to an AI coding assistant as it processes a user's query. You will be given the user's query and a list of available memory files with their filenames and descriptions.

Return a JSON object with a "selected_memories" array of filenames for the memories that will clearly be useful (up to 5). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful, do not include it.
- If no memories would clearly be useful, return an empty array.`;

export interface RelevantMemory {
  // 记忆文件的绝对路径。
  path: string;
  // 真正会注入对话的文本内容。
  content: string;
  // 保存时间，用于新鲜度提示。
  mtimeMs: number;
  // 注入时前置的一段解释性头部。
  header: string;
}

// 用 sideQuery 调当前模型，让模型从 manifest 里选最多 5 条明显相关的记忆。
export async function selectRelevantMemories(
  query: string,
  sideQuery: SideQueryFn,
  alreadySurfaced: Set<string>,
  signal?: AbortSignal,
): Promise<RelevantMemory[]> {
  const headers = scanMemoryHeaders();
  if (headers.length === 0) return [];

  // 已经在当前会话里给过模型看的记忆，不再重复发给 selector。
  const candidates = headers.filter((h) => !alreadySurfaced.has(h.filePath));
  if (candidates.length === 0) return [];

  const manifest = formatMemoryManifest(candidates);

  try {
    // selector 只负责选文件名，不直接读正文，这样 token 成本更可控。
    const text = await sideQuery(
      SELECT_MEMORIES_PROMPT,
      `Query: ${query}\n\nAvailable memories:\n${manifest}`,
      signal,
    );

    // 模型偶尔会把 JSON 包在 markdown 代码块里，这里用正则把对象提出来。
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]);
    const selectedFilenames: string[] = parsed.selected_memories || [];

    // 根据文件名映射回 headers，再读取这些记忆的全文。
    const filenameSet = new Set(selectedFilenames);
    const selected = candidates.filter((h) => filenameSet.has(h.filename));

    return selected.slice(0, 5).map((h) => {
      let content = readFileSync(h.filePath, "utf-8");
      // 单条记忆正文过长时截断到 4KB，防止一条记忆独吞上下文。
      if (Buffer.byteLength(content) > MAX_MEMORY_BYTES_PER_FILE) {
        content = content.slice(0, MAX_MEMORY_BYTES_PER_FILE) +
          "\n\n[... truncated, memory file too large ...]";
      }
      const freshness = memoryFreshnessWarning(h.mtimeMs);
      const headerText = freshness
        ? `${freshness}\n\nMemory: ${h.filePath}:`
        : `Memory (saved ${memoryAge(h.mtimeMs)}): ${h.filePath}:`;

      return { path: h.filePath, content, mtimeMs: h.mtimeMs, header: headerText };
    });
  } catch (err: any) {
    // 记忆召回失败绝不能阻塞主对话；只打印诊断信息后返回空数组。
    if (signal?.aborted) return [];
    console.error(`[memory] semantic recall failed: ${err.message}`);
    return [];
  }
}

// ─── 预取句柄：让记忆召回异步进行，不阻塞首轮模型响应 ──────────

export interface MemoryPrefetch {
  // 实际执行中的 Promise。
  promise: Promise<RelevantMemory[]>;
  // 是否已经完成，用于主循环轮询。
  settled: boolean;
  // 是否已经把结果消耗并注入过消息历史。
  consumed: boolean;
}

// 判断用户输入是否“值得触发一次记忆召回”。
// 规则比较保守：要么包含至少两个 CJK 字符，要么至少是多词输入。
function isQuerySubstantial(query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.length === 0) return false;

  // 中文/日文/韩文经常没有空格，所以单独按字符集判断。
  const cjkRegex = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g;
  const cjkMatches = trimmed.match(cjkRegex);
  if (cjkMatches && cjkMatches.length >= 2) return true;

  // 非 CJK 场景退回“是否至少有空白分词”的启发式。
  if (/\s/.test(trimmed)) return true;

  return false;
}

export function startMemoryPrefetch(
  query: string,
  sideQuery: SideQueryFn,
  alreadySurfaced: Set<string>,
  sessionMemoryBytes: number,
  signal?: AbortSignal,
): MemoryPrefetch | null {
  // 输入太短/太含糊时不值得额外调用一次 selector 模型。
  if (!isQuerySubstantial(query)) return null;

  // 会话内累计注入的记忆已经太多时，直接停掉后续召回。
  if (sessionMemoryBytes >= MAX_SESSION_MEMORY_BYTES) return null;

  // 没有任何记忆文件时也没必要预取。
  const dir = getMemoryDir();
  const hasMemories = readdirSync(dir).some(
    (f) => f.endsWith(".md") && f !== "MEMORY.md"
  );
  if (!hasMemories) return null;

  // 返回一个可轮询状态的句柄，而不是直接 await，让主对话可以先跑起来。
  const handle: MemoryPrefetch = {
    promise: selectRelevantMemories(query, sideQuery, alreadySurfaced, signal),
    settled: false,
    consumed: false,
  };
  // 无论成功失败，Promise 落定后都把 `settled` 置 true。
  handle.promise.then(() => { handle.settled = true; }).catch(() => { handle.settled = true; });
  return handle;
}

// 把召回的记忆包成 `<system-reminder>` 片段，注入到用户消息中。
export function formatMemoriesForInjection(memories: RelevantMemory[]): string {
  return memories
    .map((m) => `<system-reminder>\n${m.header}\n\n${m.content}\n</system-reminder>`)
    .join("\n\n");
}

// ─── 拼出 system prompt 中的“记忆系统说明”小节 ───────────────

export function buildMemoryPromptSection(): string {
  const index = loadMemoryIndex();
  const memoryDir = getMemoryDir();

  // 这段字符串不是实际记忆内容，而是教模型如何正确使用记忆系统。
  return `# Memory System

You have a persistent, file-based memory system at \`${memoryDir}\`.

## Memory Types
- **user**: User's role, preferences, knowledge level
- **feedback**: Corrections and guidance from the user (include Why + How to apply)
- **project**: Ongoing work, goals, deadlines, decisions
- **reference**: Pointers to external resources (URLs, tools, dashboards)

## How to Save Memories
Use the write_file tool to create a memory file with YAML frontmatter:

\`\`\`markdown
---
name: memory name
description: one-line description
type: user|feedback|project|reference
---
Memory content here.
\`\`\`

Save to: \`${memoryDir}/\`
Filename format: \`{type}_{slugified_name}.md\`

The MEMORY.md index is auto-updated when you write to the memory directory — do NOT update it manually.

## What NOT to Save
- Code patterns or architecture (read the code instead)
- Git history (use git log)
- Anything already in CLAUDE.md
- Ephemeral task details

## When to Recall
When the user asks you to remember or recall, or when prior context seems relevant.
${index ? `\n## Current Memory Index\n${index}` : "\n(No memories saved yet.)"}`;
}
````

### 步骤 2：确认和参考仓库零差异

```bash
diff -u "$REFERENCE_REPO/src/memory.ts" "$TARGET_REPO/src/memory.ts"
```

### 步骤 3：重新编译

```bash
cd "$TARGET_REPO"
npm run build
```

### 步骤 4：测试语义召回、预取和注入格式

```bash
cd "$TARGET_REPO"
node --input-type=module <<'EOF'
import {
  saveMemory, deleteMemory, selectRelevantMemories, startMemoryPrefetch,
  formatMemoriesForInjection, buildMemoryPromptSection
} from "./dist/memory.js";

const keep = saveMemory({
  name: "Release Checklist",
  description: "release checklist for deploys",
  type: "project",
  content: "Run tests, check env vars, then deploy.",
});
const ignore = saveMemory({
  name: "Coffee Preference",
  description: "favorite coffee beans",
  type: "user",
  content: "Prefers light roast.",
});

const sideQuery = async () => JSON.stringify({ selected_memories: [keep] });
const selected = await selectRelevantMemories("deploy checklist", sideQuery, new Set());
console.log("selected:", selected.map((m) => m.path));
console.log(formatMemoriesForInjection(selected));

const prefetch = startMemoryPrefetch("deploy checklist", sideQuery, new Set(), 0);
const prefetched = prefetch ? await prefetch.promise : [];
console.log("prefetch-count:", prefetched.length);
console.log(buildMemoryPromptSection().includes("# Memory System"));

console.log("cleanup-keep:", deleteMemory(keep));
console.log("cleanup-ignore:", deleteMemory(ignore));
EOF
```

## 现在你应该看到什么

1. `diff -u` 没有输出。
2. `npm run build` 可以通过。
3. `selected:` 里会出现你刚刚保存的那条部署检查记忆文件路径。
4. 注入文本里会出现 `<system-reminder>` 包裹的记忆内容。
5. `prefetch-count:` 至少是 `1`。
6. `buildMemoryPromptSection().includes("# Memory System")` 应该打印 `true`。

## 本小节的“手把手测试流程”

1. 先执行“步骤 1”覆盖最终版 `src/memory.ts`。
2. 再执行“步骤 2”的 `diff -u`，确认你已经和参考仓库一致。
3. 然后执行“步骤 3”的 `npm run build`。
4. 最后执行“步骤 4”的测试脚本，确认语义召回、预取和注入格式都能跑通。
