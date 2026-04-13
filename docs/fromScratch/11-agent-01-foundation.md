# 第 11-1 节：先搭好 Agent 的构造器、状态和 Plan Mode 基础切换

这一小节结束后，你拿到的不是最终版 `src/agent.ts`，而是一个“可以实例化、可以切 Plan Mode”的阶段版。

## 本小节目标

本小节结束后，你应该能：

1. 成功 `new Agent(...)`。
2. 调用 `getPermissionMode()`。
3. 调用 `togglePlanMode()`。
4. 调用 `getTokenUsage()`。

## 这份阶段版源码来自哪里

这一小节的阶段版 `src/agent.ts` 完全由参考文件中的这些原始片段拼成：

- 第 1-396 行
- 第 901-929 行
- 第 1615 行

拼接原因是：前面的构造器和 `togglePlanMode()` 会依赖 `generatePlanFilePath()` 与 `buildPlanModePrompt()`，所以第一阶段必须把这两个辅助方法一起带上。

## 手把手实操

### 步骤 1：覆盖当前的 `src/agent.ts`

把 `$TARGET_REPO/src/agent.ts` 整个替换成下面这份阶段版代码。

#### 当前阶段版 `src/agent.ts` 完整代码

````ts
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import chalk from "chalk";
import { toolDefinitions, executeTool, checkPermission, CONCURRENCY_SAFE_TOOLS, getActiveToolDefinitions, getDeferredToolNames, type ToolDef, type PermissionMode } from "./tools.js";
import {
  printAssistantText,
  printToolCall,
  printToolResult,
  printError,
  printConfirmation,
  printDivider,
  printCost,
  printRetry,
  printInfo,
  printSubAgentStart,
  printSubAgentEnd,
  startSpinner,
  stopSpinner,
} from "./ui.js";
import { saveSession } from "./session.js";
import { buildSystemPrompt } from "./prompt.js";
import { getSubAgentConfig, type SubAgentType } from "./subagent.js";
import {
  startMemoryPrefetch, formatMemoriesForInjection,
  type MemoryPrefetch, type RelevantMemory, type SideQueryFn,
} from "./memory.js";
import { McpManager } from "./mcp.js";
import * as readline from "readline";
import { randomUUID } from "crypto";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// 这个文件是整个 CLI 的核心：
// 1. 管理与 Anthropic / OpenAI 两类后端的消息历史。
// 2. 驱动“模型输出 -> 工具调用 -> 工具结果回填 -> 再次调用模型”的 agent loop。
// 3. 处理预算、压缩、记忆注入、MCP、plan mode、sub-agent 等横切能力。

// ─── 重试与指数退避 ─────────────────────────────────────────

function isRetryable(error: any): boolean {
  // 只对典型临时性错误做重试：限流、服务过载、网络抖动。
  const status = error?.status || error?.statusCode;
  if ([429, 503, 529].includes(status)) return true;
  if (error?.code === "ECONNRESET" || error?.code === "ETIMEDOUT") return true;
  if (error?.message?.includes("overloaded")) return true;
  return false;
}

async function withRetry<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  maxRetries = 3
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(signal);
    } catch (error: any) {
      // 如果是用户主动 abort，直接把错误抛出去，不做重试。
      if (signal?.aborted) throw error;
      // 达到最大重试次数，或错误本身不适合重试时，直接失败。
      if (attempt >= maxRetries || !isRetryable(error)) throw error;
      // 指数退避 + 少量随机抖动，避免多请求同时重试形成雪崩。
      const delay = Math.min(1000 * Math.pow(2, attempt), 30000) + Math.random() * 1000;
      const reason = error?.status ? `HTTP ${error.status}` : error?.code || "network error";
      printRetry(attempt + 1, maxRetries, reason);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ─── 模型上下文窗口估算 ─────────────────────────────────────

const MODEL_CONTEXT: Record<string, number> = {
  "claude-opus-4-6": 200000,
  "claude-sonnet-4-6": 200000,
  "claude-sonnet-4-20250514": 200000,
  "claude-haiku-4-5-20251001": 200000,
  "claude-opus-4-20250514": 200000,
  "gpt-4o": 128000,
  "gpt-4o-mini": 128000,
};

function getContextWindow(model: string): number {
  // 未知模型回退到一个保守但足够大的默认值。
  return MODEL_CONTEXT[model] || 200000;
}

// ─── thinking 支持检测 ──────────────────────────────────────
// 这里只是策略判断：并不是所有模型都支持 thinking，而且不同 Claude 代际的
// 开关方式和推荐 token 预算也不同。

function modelSupportsThinking(model: string): boolean {
  const m = model.toLowerCase();
  // Claude 3.x / 3.5 / 3.7 不走这里的 thinking 能力。
  if (m.includes("claude-3-") || m.includes("3-5-") || m.includes("3-7-")) return false;
  // Claude 4 系列（opus/sonnet/haiku）视为支持。
  if (m.includes("claude") && (m.includes("opus") || m.includes("sonnet") || m.includes("haiku"))) return true;
  // 非 Claude 模型统一禁用。
  return false;
}

function modelSupportsAdaptiveThinking(model: string): boolean {
  const m = model.toLowerCase();
  // 目前只对 4.6 系列开启 adaptive。
  return m.includes("opus-4-6") || m.includes("sonnet-4-6");
}

// 不同模型允许的输出 token 上限不同。
function getMaxOutputTokens(model: string): number {
  const m = model.toLowerCase();
  if (m.includes("opus-4-6")) return 64000;
  if (m.includes("sonnet-4-6")) return 32000;
  if (m.includes("opus-4") || m.includes("sonnet-4") || m.includes("haiku-4")) return 32000;
  return 16384;
}

// ─── Anthropic 工具 schema 转 OpenAI function 格式 ──────────

function toOpenAITools(tools: ToolDef[]): OpenAI.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema as Record<string, unknown>,
    },
  }));
}

// ─── 多层压缩策略常量 ────────────────────────────────────────
// 目标是在不额外请求模型的前提下，先尽量削减旧工具结果对上下文的占用。

// 这些工具往往产出大文本，是最值得被预算/裁剪的对象。
const SNIPPABLE_TOOLS = new Set(["read_file", "grep_search", "list_files", "run_shell"]);
// 老结果被“抽干”后保留的占位文本。
const SNIP_PLACEHOLDER = "[Content snipped - re-read if needed]";
// 上下文使用率超过 60% 后开始做更激进的 snip。
const SNIP_THRESHOLD = 0.60;
// 长时间没有 API 调用后，认为 prompt cache 可能已冷，可以更狠地 microcompact。
const MICROCOMPACT_IDLE_MS = 5 * 60 * 1000;
// 始终保留最近几次工具结果，给模型维持短期工作记忆。
const KEEP_RECENT_RESULTS = 3;

// ─── Agent 配置项 ───────────────────────────────────────────

interface AgentOptions {
  // 初始权限模式。
  permissionMode?: PermissionMode;
  // 老选项兼容：等价于 bypassPermissions。
  yolo?: boolean;
  // 要使用的模型名。
  model?: string;
  // OpenAI-compatible base URL。
  apiBase?: string;
  // Anthropic 代理地址。
  anthropicBaseURL?: string;
  // API key。
  apiKey?: string;
  // 是否请求开启 thinking。
  thinking?: boolean;
  // 预算上限。
  maxCostUsd?: number;
  maxTurns?: number;
  // 外部确认函数，由 REPL 注入，避免 agent 自己重复创建 readline。
  confirmFn?: (message: string) => Promise<boolean>;
  // 子代理专用覆盖项。
  customSystemPrompt?: string;
  customTools?: ToolDef[];
  isSubAgent?: boolean;
}

export class Agent {
  // 两种后端客户端二选一；谁存在就走谁。
  private anthropicClient?: Anthropic;
  private openaiClient?: OpenAI;
  // true 表示走 OpenAI-compatible API。
  private useOpenAI: boolean;
  // 当前运行的权限模式。
  private permissionMode: PermissionMode;
  // 用户有没有要求 thinking。
  private thinking: boolean;
  // 结合模型能力后真正采用的 thinking 策略。
  private thinkingMode: "adaptive" | "enabled" | "disabled";
  // 当前模型名。
  private model: string;
  // 当前生效的 system prompt（可能包含 plan mode 附加说明）。
  private systemPrompt: string;
  // 当前这台 agent 可见的工具列表。
  private tools: ToolDef[];
  // 粗粒度 token 统计。
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private lastInputTokenCount = 0;
  // 为避免贴边爆 context，内部留出 20k 的缓冲。
  private effectiveWindow: number;
  // 会话 ID 用于自动保存。
  private sessionId: string;
  private sessionStartTime: string;
  // 子代理不会打印分隔线、不会自动保存、也不会再初始化 MCP。
  private isSubAgent: boolean;

  // MCP 连接器由主代理按需惰性初始化。
  private mcpManager = new McpManager();
  private mcpInitialized = false;

  // 预算控制。
  private maxCostUsd?: number;
  private maxTurns?: number;
  private currentTurns = 0;

  // 记录上一次 API 调用时间，供 microcompact 判断是否“空闲太久”。
  private lastApiCallTime = 0;

  // 每轮 chat 都会创建一个 AbortController，供 Ctrl+C 中断。
  private abortController: AbortController | null = null;

  // 已确认过的危险操作做会话级白名单，避免重复确认同一路径/命令。
  private confirmedPaths: Set<string> = new Set();

  // plan mode 需要保存切换前模式、plan 文件路径，以及是否清空过上下文。
  private prePlanMode: PermissionMode | null = null;
  private planFilePath: string | null = null;
  private baseSystemPrompt: string = "";
  private contextCleared: boolean = false;

  // 外部确认函数。
  private confirmFn?: (message: string) => Promise<boolean>;

  // plan 审批回调，由 CLI REPL 注入。
  private planApprovalFn?: (planContent: string) => Promise<{
    choice: "clear-and-execute" | "execute" | "manual-execute" | "keep-planning";
    feedback?: string;
  }>;

  // 子代理运行时不直接打印，而是把输出缓存起来回传给父代理。
  private outputBuffer: string[] | null = null;

  // 记录“某文件最近一次被 read_file 看到时的 mtime”，用于读后写保护。
  private readFileState: Map<string, number> = new Map();

  // 记忆召回的会话级状态。
  private alreadySurfacedMemories: Set<string> = new Set();
  private sessionMemoryBytes = 0;

  // Anthropic / OpenAI 两种后端维护各自独立的消息历史结构。
  private anthropicMessages: Anthropic.MessageParam[] = [];
  private openaiMessages: OpenAI.ChatCompletionMessageParam[] = [];

  constructor(options: AgentOptions = {}) {
    // 权限模式优先级：显式 permissionMode > 兼容 yolo > default。
    this.permissionMode = options.permissionMode
      || (options.yolo ? "bypassPermissions" : "default");
    this.thinking = options.thinking || false;
    this.model = options.model || "claude-opus-4-6";
    this.thinkingMode = this.resolveThinkingMode();
    this.useOpenAI = !!options.apiBase;
    this.isSubAgent = options.isSubAgent || false;
    this.tools = options.customTools || toolDefinitions;
    this.maxCostUsd = options.maxCostUsd;
    this.maxTurns = options.maxTurns;
    this.confirmFn = options.confirmFn;
    this.effectiveWindow = getContextWindow(this.model) - 20000;
    this.sessionId = randomUUID().slice(0, 8);
    this.sessionStartTime = new Date().toISOString();

    // baseSystemPrompt 是“不含 plan mode 动态附加段”的基础版本。
    this.baseSystemPrompt = options.customSystemPrompt || buildSystemPrompt();
    if (this.permissionMode === "plan") {
      this.planFilePath = this.generatePlanFilePath();
      // plan 模式会把额外约束文字拼到 system prompt 末尾。
      this.systemPrompt = this.baseSystemPrompt + this.buildPlanModePrompt();
    } else {
      this.systemPrompt = this.baseSystemPrompt;
    }

    if (this.useOpenAI) {
      // OpenAI 后端把 system prompt 作为 history 第一条 system message 保存。
      this.openaiClient = new OpenAI({
        baseURL: options.apiBase,
        apiKey: options.apiKey,
      });
      this.openaiMessages.push({ role: "system", content: this.systemPrompt });
    } else {
      // Anthropic 后端每次请求单独传 `system` 字段，因此这里不往消息历史里塞 system。
      this.anthropicClient = new Anthropic({
        apiKey: options.apiKey,
        ...(options.anthropicBaseURL ? { baseURL: options.anthropicBaseURL } : {}),
      });
    }
  }

  private resolveThinkingMode(): "adaptive" | "enabled" | "disabled" {
    // 用户没开 thinking 时直接禁用。
    if (!this.thinking) return "disabled";
    // 模型不支持时也必须禁用。
    if (!modelSupportsThinking(this.model)) return "disabled";
    // 4.6 系列走 adaptive，其余支持 thinking 的模型走 enabled。
    if (modelSupportsAdaptiveThinking(this.model)) return "adaptive";
    return "enabled";
  }

  // 把“发一个轻量查询给同一模型”的逻辑封装成统一接口，供 memory selector 复用。
  private buildSideQuery(): SideQueryFn | null {
    if (this.anthropicClient) {
      const client = this.anthropicClient;
      const model = this.model;
      return async (system, userMessage, signal) => {
        // sideQuery 不需要工具，也不需要长输出，所以 token 配额固定很小。
        const resp = await client.messages.create({
          model, max_tokens: 256, system,
          messages: [{ role: "user", content: userMessage }],
        }, { signal });
        return resp.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text).join("");
      };
    }
    if (this.openaiClient) {
      const client = this.openaiClient;
      const model = this.model;
      return async (system, userMessage, _signal) => {
        const resp = await client.chat.completions.create({
          model, max_tokens: 256,
          messages: [
            { role: "system", content: system },
            { role: "user", content: userMessage },
          ],
        });
        return resp.choices?.[0]?.message?.content || "";
      };
    }
    return null;
  }

  abort() {
    // 外部 Ctrl+C 会调用这里，真正终止当前 API 请求/流程。
    this.abortController?.abort();
  }

  get isProcessing(): boolean {
    // 只要当前轮还持有 abortController，就认为正在处理中。
    return this.abortController !== null;
  }

  setConfirmFn(fn: (message: string) => Promise<boolean>) {
    // 由 CLI 注入交互式确认逻辑。
    this.confirmFn = fn;
  }

  setPlanApprovalFn(fn: (planContent: string) => Promise<{
    choice: "clear-and-execute" | "execute" | "manual-execute" | "keep-planning";
    feedback?: string;
  }>) {
    // 同样由 CLI 注入 plan 审批逻辑。
    this.planApprovalFn = fn;
  }

  // REPL 下手动切换 plan mode。
  togglePlanMode(): string {
    if (this.permissionMode === "plan") {
      // 退出时恢复切换前的权限模式。
      this.permissionMode = this.prePlanMode || "default";
      this.prePlanMode = null;
      this.planFilePath = null;
      this.systemPrompt = this.baseSystemPrompt;
      if (this.useOpenAI && this.openaiMessages.length > 0) {
        // OpenAI 的 system prompt 存在消息历史里，也要同步更新。
        (this.openaiMessages[0] as any).content = this.systemPrompt;
      }
      printInfo(`Exited plan mode → ${this.permissionMode} mode`);
      return this.permissionMode;
    } else {
      // 进入时先记住之前模式，稍后退出才知道要恢复成什么。
      this.prePlanMode = this.permissionMode;
      this.permissionMode = "plan";
      this.planFilePath = this.generatePlanFilePath();
      this.systemPrompt = this.baseSystemPrompt + this.buildPlanModePrompt();
      if (this.useOpenAI && this.openaiMessages.length > 0) {
        (this.openaiMessages[0] as any).content = this.systemPrompt;
      }
      printInfo(`Entered plan mode. Plan file: ${this.planFilePath}`);
      return "plan";
    }
  }

  getPermissionMode(): string {
    // 主要给外部界面/调试使用。
    return this.permissionMode;
  }

  getTokenUsage() {
    // 暴露累计 token 统计。
    return { input: this.totalInputTokens, output: this.totalOutputTokens };
  }

  private generatePlanFilePath(): string {
    const dir = join(homedir(), ".claude", "plans");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // plan 文件名带 sessionId，避免多次会话互相覆盖。
    return join(dir, `plan-${this.sessionId}.md`);
  }

  private buildPlanModePrompt(): string {
    // 这段文字会拼到 system prompt 末尾，把“只读 + plan 文件路径”明确告诉模型。
    return `

# Plan Mode Active

Plan mode is active. You MUST NOT make any edits (except the plan file below), run non-readonly tools, or make any changes to the system.

## Plan File: ${this.planFilePath}
Write your plan incrementally to this file using write_file or edit_file. This is the ONLY file you are allowed to edit.

## Workflow
1. **Explore**: Read code to understand the task. Use read_file, list_files, grep_search.
2. **Design**: Design your implementation approach. Use the agent tool with type="plan" if the task is complex.
3. **Write Plan**: Write a structured plan to the plan file including:
   - **Context**: Why this change is needed
   - **Steps**: Implementation steps with critical file paths
   - **Verification**: How to test the changes
4. **Exit**: Call exit_plan_mode when your plan is ready for user review.

IMPORTANT: When your plan is complete, you MUST call exit_plan_mode. Do NOT ask the user to approve — exit_plan_mode handles that.`;
  }
}
````

### 步骤 2：先编译

````bash
cd "$TARGET_REPO"
npm run build
````

### 步骤 3：跑基础 smoke test

````bash
cd "$TARGET_REPO"
node --input-type=module <<'EOF'
import { Agent } from "./dist/agent.js";

const agent = new Agent({
  permissionMode: "default",
  model: "claude-opus-4-6",
  apiKey: "dummy-key"
});

console.log(agent.getPermissionMode());
console.log(agent.togglePlanMode());
console.log(agent.togglePlanMode());
console.log(agent.getTokenUsage());
EOF
````

## 本小节的“手把手测试流程”

````bash
cd "$TARGET_REPO"
npm run build
node --input-type=module <<'EOF'
import { Agent } from "./dist/agent.js";
const agent = new Agent({ apiKey: "dummy-key" });
console.log(agent.getPermissionMode());
EOF
````

预期输出：

````text
default
````

下一小节补上历史管理、成本和恢复能力：[11-agent-02-history-budget.md](./11-agent-02-history-budget.md)
