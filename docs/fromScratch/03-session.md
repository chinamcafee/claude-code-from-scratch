# 第 3 章：接入 `session.ts`

这一章开始把“会话能落盘、能恢复”这件事搭起来。

## 本章目标

本章结束后，你会得到：

1. 一个和参考仓库完全一致的 `src/session.ts`。
2. 会话写入 JSON 文件的能力。
3. 读取、列出、查最近会话的能力。

## 本章新增的正式源码

- `src/session.ts`（79 行）
- 源码基准：`$REFERENCE_REPO/src/session.ts`

## 步骤 1：创建目标文件

### 先动手

```bash
cd "$TARGET_REPO"
touch src/session.ts
```

### 再理解

还是同样的节奏：先把文件落位，再拷正式源码。

## 步骤 2：复制正式源码并校验

### 先动手

把 `$REFERENCE_REPO/src/session.ts` 的 79 行完整复制到 `$TARGET_REPO/src/session.ts`。

直接照抄下面这份完整代码：

#### `src/session.ts` 完整代码

````ts
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// 会话都落到用户主目录下，避免污染项目仓库本身。
const SESSION_DIR = join(homedir(), ".mini-claude", "sessions");

interface SessionMetadata {
  // 简短会话 ID，用来恢复最近一次会话。
  id: string;
  // 保存模型名，恢复时便于理解这段会话是谁生成的。
  model: string;
  // 记录当时的工作目录，便于定位这段会话属于哪个项目。
  cwd: string;
  // ISO 时间戳，用于排序“最近一次会话”。
  startTime: string;
  // 粗略记录消息数，方便展示会话规模。
  messageCount: number;
}

interface SessionData {
  // 元数据始终存在。
  metadata: SessionMetadata;
  // Anthropic / OpenAI 两套消息历史分开存，谁在用就恢复谁。
  anthropicMessages?: any[];
  openaiMessages?: any[];
}

function ensureDir() {
  // 写会话前保证目录存在；`recursive` 能处理首次启动场景。
  if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });
}

export function saveSession(
  id: string,
  data: Omit<SessionData, "metadata"> & { metadata: SessionMetadata }
): void {
  // 每个会话一个独立 JSON 文件，读写简单，调试也直观。
  ensureDir();
  writeFileSync(join(SESSION_DIR, `${id}.json`), JSON.stringify(data, null, 2));
}

export function loadSession(id: string): SessionData | null {
  const file = join(SESSION_DIR, `${id}.json`);
  // 会话文件不存在时直接返回 null，让上层决定如何提示用户。
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    // JSON 损坏时静默失败，避免恢复流程把 CLI 直接打崩。
    return null;
  }
}

export function listSessions(): SessionMetadata[] {
  ensureDir();
  // 只看 json 文件，其他杂项文件一律忽略。
  const files = readdirSync(SESSION_DIR).filter((f) => f.endsWith(".json"));
  return files
    .map((f) => {
      try {
        // 列表场景只需要 metadata，不需要把整段消息历史都返回给调用方。
        const data = JSON.parse(readFileSync(join(SESSION_DIR, f), "utf-8"));
        return data.metadata as SessionMetadata;
      } catch {
        // 单个文件损坏不应该影响其它会话展示。
        return null;
      }
    })
    .filter(Boolean) as SessionMetadata[];
}

export function getLatestSessionId(): string | null {
  const sessions = listSessions();
  if (sessions.length === 0) return null;
  // 用开始时间倒序，取最近的一次会话。
  sessions.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
  return sessions[0].id;
}
````

复制后执行：

```bash
diff -u "$REFERENCE_REPO/src/session.ts" "$TARGET_REPO/src/session.ts"
```

### 再理解

这个模块的职责非常单一：

1. 统一把会话存到 `~/.mini-claude/sessions/`。
2. 每个会话一个 JSON 文件。
3. 对损坏文件尽量容错，不把主流程拖死。

## 步骤 3：构建

### 先动手

```bash
cd "$TARGET_REPO"
npm run build
```

### 再理解

`session.ts` 只依赖 Node 内置模块，所以它应该是一个很稳定的“小闭环”。

## 步骤 4：跑一个真实的会话存取测试

### 先动手

```bash
cd "$TARGET_REPO"
node --input-type=module <<'EOF'
import { saveSession, loadSession, listSessions, getLatestSessionId } from "./dist/session.js";

const id = "doc-demo-session";
saveSession(id, {
  metadata: {
    id,
    model: "demo-model",
    cwd: process.cwd(),
    startTime: new Date().toISOString(),
    messageCount: 2,
  },
  anthropicMessages: [{ role: "user", content: "hello" }],
});

console.log(loadSession(id)?.metadata.id);
console.log(listSessions().some((s) => s.id === id));
console.log(getLatestSessionId());
EOF
```

### 再理解

你现在验证的是 4 个导出函数都能工作：

1. `saveSession`
2. `loadSession`
3. `listSessions`
4. `getLatestSessionId`

## 本章原理解释

这个模块故意没有上数据库，也没有 JSONL。

当前项目的目标很明确：先用最简单的“一会话一个 JSON 文件”完成可恢复性。

这样做的收益是：

1. 调试直观。
2. 文件可以直接打开看。
3. 容错逻辑简单。

## 手把手测试流程

```bash
cd "$TARGET_REPO"
diff -u "$REFERENCE_REPO/src/session.ts" "$TARGET_REPO/src/session.ts"
npm run build
node --input-type=module <<'EOF'
import { loadSession } from "./dist/session.js";
console.log(!!loadSession("doc-demo-session"));
EOF
```

如果你前面的测试脚本跑过，这里预期输出：

```text
true
```

下一章开始接记忆系统：[04-memory.md](./04-memory.md)
