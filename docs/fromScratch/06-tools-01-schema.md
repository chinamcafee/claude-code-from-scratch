# 第 6-1 节：先搭好工具类型、schema 和 deferred 激活

这一小节结束后，你得到的不是最终版 `src/tools.ts`，而是一个“可编译的阶段版”。

这个阶段版只包含两类东西：

1. 工具类型、工具集合和 schema。
2. deferred tool 的激活状态管理。

## 本小节目标

本小节结束后，你应该能：

1. 在 `src/tools.ts` 中导出 `PermissionMode`、`CONCURRENCY_SAFE_TOOLS`、`ToolDef`、`toolDefinitions`。
2. 调用 `getDeferredToolNames()` 和 `getActiveToolDefinitions()`。
3. 成功编译当前工程。

## 这份阶段版源码来自哪里

这一小节的阶段版 `src/tools.ts` 完全由参考文件的下面这段原始源码组成：

- `$REFERENCE_REPO/src/tools.ts` 第 1-283 行

## 手把手实操

### 步骤 1：覆盖当前的 `src/tools.ts`

先把 `$TARGET_REPO/src/tools.ts` 整个替换成下面这份阶段版代码。

#### 当前阶段版 `src/tools.ts` 完整代码

````ts
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { execSync, execFileSync } from "child_process";
import { glob } from "glob";
import { dirname, join, basename, extname, resolve } from "path";
import { homedir } from "os";

const isWin = process.platform === "win32";
import { getMemoryDir } from "./memory.js";
import type Anthropic from "@anthropic-ai/sdk";
// 这里集中定义“主代理可调用的所有本地工具”。
// 真正执行 skill / agent 的逻辑在 agent.ts 中，因为它们会递归调模型，
// 放在这里容易产生循环依赖。

// ─── 权限模式 ───────────────────────────────────────────────
// 这些模式决定工具调用是自动放行、自动拒绝、还是需要交互确认。

export type PermissionMode = "default" | "plan" | "acceptEdits" | "bypassPermissions" | "dontAsk";

// 读工具始终被认为是安全的。
const READ_TOOLS = new Set(["read_file", "list_files", "grep_search", "web_fetch"]);
// 写工具会修改文件系统。
const EDIT_TOOLS = new Set(["write_file", "edit_file"]);

// 这些工具可以并发执行，因为它们只读且没有副作用。
export const CONCURRENCY_SAFE_TOOLS = new Set(["read_file", "list_files", "grep_search", "web_fetch"]);

// `deferred` 表示这个工具默认不把完整 schema 发给模型，需要时再激活。
export type ToolDef = Anthropic.Tool & { deferred?: boolean };

// ─── 工具 schema 定义 ────────────────────────────────────────
// 这里的对象会直接送给模型，所以 description / input_schema 要尽量清晰。

export const toolDefinitions: ToolDef[] = [
  // 读文件：返回带行号的内容，方便模型后续引用与 edit。
  {
    name: "read_file",
    description:
      "Read the contents of a file. Returns the file content with line numbers.",
    input_schema: {
      type: "object" as const,
      properties: {
        file_path: {
          type: "string",
          description: "The path to the file to read",
        },
      },
      required: ["file_path"],
    },
  },
  // 写文件：整文件覆盖，适合创建新文件或大改。
  {
    name: "write_file",
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does.",
    input_schema: {
      type: "object" as const,
      properties: {
        file_path: {
          type: "string",
          description: "The path to the file to write",
        },
        content: {
          type: "string",
          description: "The content to write to the file",
        },
      },
      required: ["file_path", "content"],
    },
  },
  // 精确字符串替换：用于受控的小范围编辑。
  {
    name: "edit_file",
    description:
      "Edit a file by replacing an exact string match with new content. The old_string must match exactly (including whitespace and indentation).",
    input_schema: {
      type: "object" as const,
      properties: {
        file_path: {
          type: "string",
          description: "The path to the file to edit",
        },
        old_string: {
          type: "string",
          description: "The exact string to find and replace",
        },
        new_string: {
          type: "string",
          description: "The string to replace it with",
        },
      },
      required: ["file_path", "old_string", "new_string"],
    },
  },
  // glob 列文件。
  {
    name: "list_files",
    description:
      "List files matching a glob pattern. Returns matching file paths.",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: {
          type: "string",
          description:
            'Glob pattern to match files (e.g., "**/*.ts", "src/**/*")',
        },
        path: {
          type: "string",
          description:
            "Base directory to search from. Defaults to current directory.",
        },
      },
      required: ["pattern"],
    },
  },
  // grep 搜内容。
  {
    name: "grep_search",
    description:
      "Search for a pattern in files. Returns matching lines with file paths and line numbers.",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: {
          type: "string",
          description: "The regex pattern to search for",
        },
        path: {
          type: "string",
          description: "Directory or file to search in. Defaults to current directory.",
        },
        include: {
          type: "string",
          description:
            'File glob pattern to include (e.g., "*.ts", "*.py")',
        },
      },
      required: ["pattern"],
    },
  },
  // shell 兜底工具，留给测试、git、安装依赖等场景。
  {
    name: "run_shell",
    description:
      "Execute a shell command and return its output. Use this for running tests, installing packages, git operations, etc.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute",
        },
        timeout: {
          type: "number",
          description: "Timeout in milliseconds (default: 30000)",
        },
      },
      required: ["command"],
    },
  },
  // 技能工具：让模型能在运行时主动拉起 skill。
  {
    name: "skill",
    description:
      "Invoke a registered skill by name. Skills are prompt templates loaded from .claude/skills/. Returns the skill's resolved prompt to follow.",
    input_schema: {
      type: "object" as const,
      properties: {
        skill_name: {
          type: "string",
          description: "The name of the skill to invoke",
        },
        args: {
          type: "string",
          description: "Optional arguments to pass to the skill",
        },
      },
      required: ["skill_name"],
    },
  },
  // 拉取网页/文本内容。
  {
    name: "web_fetch",
    description:
      "Fetch a URL and return its content as text. For HTML pages, tags are stripped to return readable text. For JSON/text responses, content is returned directly.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "The URL to fetch" },
        max_length: {
          type: "number",
          description: "Maximum content length in characters (default 50000)",
        },
      },
      required: ["url"],
    },
  },
  // plan 模式切换工具默认做成 deferred，减少常规场景 token 开销。
  {
    name: "enter_plan_mode",
    description:
      "Enter plan mode to switch to a read-only planning phase. In plan mode, you can only read files and write to the plan file. Use this when you need to explore the codebase and design an implementation plan before making changes.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
    deferred: true,
  },
  {
    name: "exit_plan_mode",
    description:
      "Exit plan mode after you have finished writing your plan to the plan file. The user will review and approve the plan before you proceed with implementation.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
    deferred: true,
  },
  // 子代理工具，让主代理把某些子任务分出去。
  {
    name: "agent",
    description:
      "Launch a sub-agent to handle a task autonomously. Sub-agents have isolated context and return their result. Types: 'explore' (read-only, fast search), 'plan' (read-only, structured planning), 'general' (full tools).",
    input_schema: {
      type: "object" as const,
      properties: {
        description: {
          type: "string",
          description: "Short (3-5 word) description of the sub-agent's task",
        },
        prompt: {
          type: "string",
          description: "Detailed task instructions for the sub-agent",
        },
        type: {
          type: "string",
          enum: ["explore", "plan", "general"],
          description: "Agent type: explore (read-only), plan (planning), general (full tools). Default: general",
        },
      },
      required: ["description", "prompt"],
    },
  },
  // deferred tool 查询工具：模型通过它“按需激活”隐藏 schema。
  {
    name: "tool_search",
    description:
      "Search for available tools by name or keyword. Returns full schema definitions for matching deferred tools so you can use them.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Tool name or search keywords" },
      },
      required: ["query"],
    },
  },
];

// ─── deferred tool 激活状态 ─────────────────────────────────
// deferred 工具平时只在 system prompt 里告诉模型“它存在”，
// 真正 schema 要等模型调用 `tool_search` 后再放进后续 API 请求里。

const activatedTools = new Set<string>();

export function resetActivatedTools(): void {
  activatedTools.clear();
}

export function getActiveToolDefinitions(allTools?: ToolDef[]): Anthropic.Tool[] {
  const tools = allTools || toolDefinitions;
  return tools
    // 未激活的 deferred 工具在这里被过滤掉。
    .filter(t => !t.deferred || activatedTools.has(t.name))
    // `deferred` 只是本地辅助字段，发给模型前要去掉。
    .map(({ deferred, ...rest }) => rest);
}

export function getDeferredToolNames(allTools?: ToolDef[]): string[] {
  const tools = allTools || toolDefinitions;
  return tools
    .filter(t => t.deferred && !activatedTools.has(t.name))
    .map(t => t.name);
}
````

### 步骤 2：先编译

````bash
cd "$TARGET_REPO"
npm run build
````

### 步骤 3：验证 schema 和 deferred 激活接口

````bash
cd "$TARGET_REPO"
node --input-type=module <<'EOF'
import { toolDefinitions, getDeferredToolNames, getActiveToolDefinitions } from "./dist/tools.js";

console.log(toolDefinitions.map((t) => t.name));
console.log(getDeferredToolNames());
console.log(getActiveToolDefinitions().map((t) => t.name));
EOF
````

## 现在你应该看到什么

你至少应该能看到：

1. `toolDefinitions` 里有 `read_file`、`write_file`、`run_shell`、`tool_search`。
2. `getDeferredToolNames()` 里包含 `enter_plan_mode` 和 `exit_plan_mode`。
3. `getActiveToolDefinitions()` 默认不会把 deferred tools 放进去。

## 本小节的“手把手测试流程”

````bash
cd "$TARGET_REPO"
npm run build
node --input-type=module <<'EOF'
import { getDeferredToolNames } from "./dist/tools.js";
console.log(getDeferredToolNames().includes("enter_plan_mode"));
EOF
````

预期输出：

````text
true
````

下一小节继续把真正的工具执行器接上：[06-tools-02-execution.md](./06-tools-02-execution.md)
