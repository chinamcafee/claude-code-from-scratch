# 第 7-1 节：先搭好内置 / 自定义 agent 的配置返回

这一小节结束后，你拿到的不是最终版 `src/subagent.ts`，而是一个已经能返回子代理配置的阶段版。

这个阶段版会先把三类内置 agent、只读工具集、自定义 agent 扫描，以及 `getSubAgentConfig()` 全部接上。

## 本小节目标

1. 导出 `getSubAgentConfig()`。
2. 能为 `explore`、`plan`、`general` 返回正确的 system prompt 和工具集合。
3. 能读取 `.claude/agents/*.md` 作为自定义 agent。
4. 成功编译当前工程。

## 这份阶段版源码来自哪里

这一小节的阶段版 `src/subagent.ts` 完全由参考文件中的这些原始片段拼成：

- 第 1-192 行

## 手把手实操

### 步骤 1：用第一阶段版本覆盖 `src/subagent.ts`

把 `$TARGET_REPO/src/subagent.ts` 整个替换成下面这份阶段版代码。

#### 当前阶段版 `src/subagent.ts` 完整代码

````ts
// 这个模块负责“子代理”能力：
// 1. 内置 explore / plan / general 三种 agent 类型。
// 2. 从 `.claude/agents/*.md` 发现用户自定义 agent。
// 3. 为上层返回某个 agent 对应的 system prompt 与工具白名单。
//
// 它本身不执行模型调用，只负责“配置解析与装配”。

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { ToolDef } from "./tools.js";
import { toolDefinitions } from "./tools.js";
import { parseFrontmatter } from "./frontmatter.js";

// ─── 类型定义 ───────────────────────────────────────────────

// 子代理类型既可以是内置字符串，也可以是用户自定义 agent 名称。
export type SubAgentType = string;

export interface SubAgentConfig {
  // 子代理启动时要注入的 system prompt。
  systemPrompt: string;
  // 子代理允许使用的工具集合。
  tools: ToolDef[];
}

interface CustomAgentDef {
  // 对外暴露给主代理调用的名字。
  name: string;
  // 简短说明，用于系统提示词展示 agent 能力。
  description: string;
  // 如果 frontmatter 指定了 allowed-tools，则只暴露这些工具。
  allowedTools?: string[];
  // markdown 正文会直接作为自定义 agent 的系统提示词。
  systemPrompt: string;
}

// ─── 只读工具集合（explore / plan 共用） ────────────────────

// 只读 agent 必须严格限制到不会修改文件或执行 shell 的工具。
const READ_ONLY_TOOLS = new Set(["read_file", "list_files", "grep_search"]);

function getReadOnlyTools(): ToolDef[] {
  // 直接从全量工具中过滤，确保工具定义只在一个地方维护。
  return toolDefinitions.filter((t) => READ_ONLY_TOOLS.has(t.name));
}

// ─── 内置 agent 的默认 system prompt ────────────────────────

// `explore` 代理专注快速检索，强调只读与高搜索效率。
const EXPLORE_PROMPT = `You are a file search specialist for Mini Claude Code. You excel at thoroughly navigating and exploring codebases.

=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
This is a READ-ONLY exploration task. You are STRICTLY PROHIBITED from:
- Creating new files (no write_file, touch, or file creation of any kind)
- Modifying existing files (no edit_file operations)
- Deleting files (no rm or deletion)
- Running ANY commands that change system state

Your role is EXCLUSIVELY to search and analyze existing code.

Your strengths:
- Rapidly finding files using glob patterns
- Searching code and text with powerful regex patterns
- Reading and analyzing file contents

Guidelines:
- Use list_files for broad file pattern matching
- Use grep_search for searching file contents with regex
- Use read_file when you know the specific file path you need to read
- Adapt your search approach based on the thoroughness level specified by the caller

NOTE: You are meant to be a fast agent that returns output as quickly as possible. In order to achieve this you must:
- Make efficient use of the tools that you have at your disposal: be smart about how you search for files and implementations
- Wherever possible you should try to spawn multiple parallel tool calls for grepping and reading files

Complete the user's search request efficiently and report your findings clearly.`;

// `plan` 代理只做分析和设计，输出结构化实施方案。
const PLAN_PROMPT = `You are a Plan agent — a READ-ONLY sub-agent specialized for designing implementation plans.

IMPORTANT CONSTRAINTS:
- You are READ-ONLY. You only have access to read_file, list_files, and grep_search.
- Do NOT attempt to modify any files.

Your job:
- Analyze the codebase to understand the current architecture
- Design a step-by-step implementation plan
- Identify critical files that need modification
- Consider architectural trade-offs

Return a structured plan with:
1. Summary of current state
2. Step-by-step implementation steps
3. Critical files for implementation
4. Potential risks or considerations`;

// `general` 代理是全功能默认子代理，适合分派相对独立的小任务。
const GENERAL_PROMPT = `You are an agent for Mini Claude Code. Given the user's message, you should use the tools available to complete the task. Complete the task fully—don't gold-plate, but don't leave it half-done. When you complete the task, respond with a concise report covering what was done and any key findings — the caller will relay this to the user, so it only needs the essentials.

Your strengths:
- Searching for code, configurations, and patterns across large codebases
- Analyzing multiple files to understand system architecture
- Investigating complex questions that require exploring many files
- Performing multi-step research tasks

Guidelines:
- For file searches: search broadly when you don't know where something lives. Use read_file when you know the specific file path.
- For analysis: Start broad and narrow down. Use multiple search strategies if the first doesn't yield results.
- Be thorough: Check multiple locations, consider different naming conventions, look for related files.
- NEVER create files unless they're absolutely necessary for achieving your goal. ALWAYS prefer editing an existing file to creating a new one.`;

// ─── 自定义 agent 发现与缓存 ────────────────────────────────

// 发现结果做进程级缓存，避免每轮对话都扫磁盘。
let cachedCustomAgents: Map<string, CustomAgentDef> | null = null;

function discoverCustomAgents(): Map<string, CustomAgentDef> {
  // 已经加载过时直接返回缓存。
  if (cachedCustomAgents) return cachedCustomAgents;

  const agents = new Map<string, CustomAgentDef>();

  // 用户级目录优先加载，优先级较低。
  loadAgentsFromDir(join(homedir(), ".claude", "agents"), agents);
  // 项目级目录后加载，同名时覆盖用户级定义，便于项目定制。
  loadAgentsFromDir(join(process.cwd(), ".claude", "agents"), agents);

  cachedCustomAgents = agents;
  return agents;
}

function loadAgentsFromDir(dir: string, agents: Map<string, CustomAgentDef>): void {
  // 没有目录就说明这个层级没定义 agent，直接返回。
  if (!existsSync(dir)) return;
  let entries: string[];
  // 目录读失败时也静默返回，不让坏配置影响主流程。
  try { entries = readdirSync(dir); } catch { return; }

  for (const entry of entries) {
    // 只有 markdown 文件会被当成 agent 定义。
    if (!entry.endsWith(".md")) continue;
    const filePath = join(dir, entry);
    try {
      const raw = readFileSync(filePath, "utf-8");
      const { meta, body } = parseFrontmatter(raw);
      // frontmatter 可显式指定 name，否则默认用文件名。
      const name = meta.name || entry.replace(/\.md$/, "");
      const allowedTools = meta["allowed-tools"]
        ? meta["allowed-tools"].split(",").map((s: string) => s.trim())
        : undefined;
      // 同名 agent 直接覆盖，最终优先级由加载顺序决定。
      agents.set(name, {
        name,
        description: meta.description || "",
        allowedTools,
        systemPrompt: body,
      });
    } catch {
      // 坏掉的 agent 文件跳过，不中断整个发现流程。
    }
  }
}

// ─── 根据类型生成子代理配置 ─────────────────────────────────

export function getSubAgentConfig(type: SubAgentType): SubAgentConfig {
  // 先查自定义 agent，让项目/用户定义优先于内置类型。
  const custom = discoverCustomAgents().get(type);
  if (custom) {
    // 自定义 agent 未声明 allowedTools 时，默认拿到除 `agent` 外的全部工具，
    // 避免子代理继续无限生成子代理，导致递归膨胀。
    const tools = custom.allowedTools
      ? toolDefinitions.filter((t) => custom.allowedTools!.includes(t.name))
      : toolDefinitions.filter((t) => t.name !== "agent");
    return { systemPrompt: custom.systemPrompt, tools };
  }

  // 否则退回内置 agent 类型。
  switch (type) {
    case "explore":
      return { systemPrompt: EXPLORE_PROMPT, tools: getReadOnlyTools() };
    case "plan":
      return { systemPrompt: PLAN_PROMPT, tools: getReadOnlyTools() };
    case "general":
    default:
      return {
        systemPrompt: GENERAL_PROMPT,
        tools: toolDefinitions.filter((t) => t.name !== "agent"),
      };
  }
}
````

### 步骤 2：创建一个最小自定义 agent

```bash
cd "$TARGET_REPO"
mkdir -p .claude/agents
cat > .claude/agents/reviewer.md <<'EOF'
---
name: reviewer
description: review a patch before merge
allowed-tools: read_file,grep_search
---
You are a patch review specialist. Focus on regressions and missing tests.
EOF
```

### 步骤 3：先编译

```bash
cd "$TARGET_REPO"
npm run build
```

### 步骤 4：测试内置和自定义 agent 配置

```bash
cd "$TARGET_REPO"
node --input-type=module <<'EOF'
import { getSubAgentConfig } from "./dist/subagent.js";

for (const name of ["explore", "plan", "general", "reviewer"]) {
  const config = getSubAgentConfig(name);
  console.log(name, config.tools.map((t) => t.name));
  console.log(config.systemPrompt.split("\n")[0]);
}
EOF
```

## 现在你应该看到什么

1. `npm run build` 可以通过。
2. `explore` 和 `plan` 打印出的工具列表应该只包含只读工具。
3. `general` 的工具列表里不应该包含 `agent`。
4. `reviewer` 的工具列表应该只包含你在 frontmatter 里声明的 `read_file` 和 `grep_search`。

## 本小节的“手把手测试流程”

1. 先执行“步骤 1”覆盖第一阶段 `src/subagent.ts`。
2. 再执行“步骤 2”准备一个真实的自定义 agent 文件。
3. 然后执行“步骤 3”的 `npm run build`。
4. 最后执行“步骤 4”的脚本，确认内置和自定义 agent 都能返回正确配置。
