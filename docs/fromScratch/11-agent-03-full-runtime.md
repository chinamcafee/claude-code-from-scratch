# 第 11-3 节：替换成最终版 `src/agent.ts`，接上完整 runtime

这一小节会把 `src/agent.ts` 替换成参考仓库里的最终版完整文件。

从这一小节结束开始，你的 Agent 才真正具备：

1. 完整的 `chatAnthropic()` / `chatOpenAI()`。
2. 工具桥接。
3. Plan Mode 完整审批流。
4. Skill / Sub-agent。
5. 上下文压缩流水线。
6. MCP 和记忆预取接入。

## 本小节目标

本小节结束后，你应该拿到和参考仓库完全一致的 `src/agent.ts`。

## 这一步的源码基准

- `$REFERENCE_REPO/src/agent.ts`（1615 行）

## 手把手实操

### 步骤 1：用最终版覆盖 `src/agent.ts`

把 `$TARGET_REPO/src/agent.ts` 整个替换成下面这份最终代码。

#### 最终版 `src/agent.ts` 完整代码

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

  async chat(userMessage: string): Promise<void> {
    // MCP 只在主代理首次对话时初始化，子代理不重复连外部服务器。
    if (!this.mcpInitialized && !this.isSubAgent) {
      this.mcpInitialized = true;
      try {
        await this.mcpManager.loadAndConnect();
        const mcpDefs = this.mcpManager.getToolDefinitions();
        if (mcpDefs.length > 0) {
          // MCP 工具发现成功后，直接拼进当前可见工具列表。
          this.tools = [...this.tools, ...mcpDefs as ToolDef[]];
        }
      } catch (err: any) {
        console.error(`[mcp] Init failed: ${err.message}`);
      }
    }
    // 每轮 chat 都新建一个 abortController，只作用于当前轮。
    this.abortController = new AbortController();
    try {
      if (this.useOpenAI) {
        await this.chatOpenAI(userMessage);
      } else {
        await this.chatAnthropic(userMessage);
      }
    } finally {
      this.abortController = null;
    }
    if (!this.isSubAgent) {
      // 主代理在每轮结束后打印分隔线并自动保存会话。
      printDivider();
      this.autoSave();
    }
  }

  // ─── 子代理一次性运行入口 ─────────────────────────────────

  async runOnce(prompt: string): Promise<{ text: string; tokens: { input: number; output: number } }> {
    // 子代理通过 outputBuffer 把本轮文本输出截获下来，不直接写终端。
    this.outputBuffer = [];
    const prevInput = this.totalInputTokens;
    const prevOutput = this.totalOutputTokens;
    await this.chat(prompt);
    const text = this.outputBuffer.join("");
    this.outputBuffer = null;
    return {
      text,
      tokens: {
        input: this.totalInputTokens - prevInput,
        output: this.totalOutputTokens - prevOutput,
      },
    };
  }

  // ─── 输出辅助：主代理直接打印，子代理改成缓冲 ───────────────

  private emitText(text: string): void {
    if (this.outputBuffer) {
      this.outputBuffer.push(text);
    } else {
      printAssistantText(text);
    }
  }

  // ─── 面向 CLI 的公共操作 ──────────────────────────────────

  clearHistory() {
    // 两套 history 都清空；OpenAI 模式要把 system message 补回去。
    this.anthropicMessages = [];
    this.openaiMessages = [];
    if (this.useOpenAI) {
      this.openaiMessages.push({ role: "system", content: this.systemPrompt });
    }
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.lastInputTokenCount = 0;
    printInfo("Conversation cleared.");
  }

  showCost() {
    // 把累计 token、估算成本、预算进度一次打印出来。
    const total = this.getCurrentCostUsd();
    const budgetInfo = this.maxCostUsd ? ` / $${this.maxCostUsd} budget` : "";
    const turnInfo = this.maxTurns ? ` | Turns: ${this.currentTurns}/${this.maxTurns}` : "";
    printInfo(
      `Tokens: ${this.totalInputTokens} in / ${this.totalOutputTokens} out\n  Estimated cost: $${total.toFixed(4)}${budgetInfo}${turnInfo}`
    );
  }

  // ─── 预算控制 ─────────────────────────────────────────────

  private getCurrentCostUsd(): number {
    // 这里沿用 UI 中同样的粗估单价。
    const costIn = (this.totalInputTokens / 1_000_000) * 3;
    const costOut = (this.totalOutputTokens / 1_000_000) * 15;
    return costIn + costOut;
  }

  private checkBudget(): { exceeded: boolean; reason?: string } {
    // 成本和轮数任一超限都停止继续 agent loop。
    if (this.maxCostUsd !== undefined && this.getCurrentCostUsd() >= this.maxCostUsd) {
      return { exceeded: true, reason: `Cost limit reached ($${this.getCurrentCostUsd().toFixed(4)} >= $${this.maxCostUsd})` };
    }
    if (this.maxTurns !== undefined && this.currentTurns >= this.maxTurns) {
      return { exceeded: true, reason: `Turn limit reached (${this.currentTurns} >= ${this.maxTurns})` };
    }
    return { exceeded: false };
  }

  async compact() {
    await this.compactConversation();
  }

  // ─── 会话恢复与自动保存 ────────────────────────────────────

  restoreSession(data: { anthropicMessages?: any[]; openaiMessages?: any[] }) {
    if (data.anthropicMessages) this.anthropicMessages = data.anthropicMessages;
    if (data.openaiMessages) this.openaiMessages = data.openaiMessages;
    printInfo(`Session restored (${this.getMessageCount()} messages).`);
  }

  private getMessageCount(): number {
    // 两套 history 结构不同，但都能用长度粗略表示规模。
    return this.useOpenAI ? this.openaiMessages.length : this.anthropicMessages.length;
  }

  private autoSave() {
    try {
      // 自动保存只落最小必要信息：metadata + 当前后端的消息历史。
      saveSession(this.sessionId, {
        metadata: {
          id: this.sessionId,
          model: this.model,
          cwd: process.cwd(),
          startTime: this.sessionStartTime,
          messageCount: this.getMessageCount(),
        },
        anthropicMessages: this.useOpenAI ? undefined : this.anthropicMessages,
        openaiMessages: this.useOpenAI ? this.openaiMessages : undefined,
      });
    } catch {
      // 保存失败不影响对话主流程。
    }
  }

  // ─── 自动压缩：在上下文接近极限前先收缩历史 ─────────────────

  private async checkAndCompact(): Promise<void> {
    // 当最近一次 prompt token 已逼近安全窗口 85% 时，触发高成本摘要压缩。
    if (this.lastInputTokenCount > this.effectiveWindow * 0.85) {
      printInfo("Context window filling up, compacting conversation...");
      await this.compactConversation();
    }
  }

  private async compactConversation(): Promise<void> {
    // Anthropic / OpenAI 的消息结构不同，因此各自有一套 compact 逻辑。
    if (this.useOpenAI) {
      await this.compactOpenAI();
    } else {
      await this.compactAnthropic();
    }
    printInfo("Conversation compacted.");
  }

  private async compactAnthropic(): Promise<void> {
    // 消息太少时不值得做摘要。
    if (this.anthropicMessages.length < 4) return;
    const lastUserMsg = this.anthropicMessages[this.anthropicMessages.length - 1];
    const summaryReq: Anthropic.MessageParam[] = [
      {
        role: "user",
        content:
          "Summarize the conversation so far in a concise paragraph, preserving key decisions, file paths, and context needed to continue the work.",
      },
    ];
    const summaryResp = await this.anthropicClient!.messages.create({
      model: this.model,
      max_tokens: 2048,
      system: "You are a conversation summarizer. Be concise but preserve important details.",
      messages: [
        ...this.anthropicMessages.slice(0, -1),
        ...summaryReq,
      ],
    });
    const summaryText =
      summaryResp.content[0]?.type === "text"
        ? summaryResp.content[0].text
        : "No summary available.";
    // 压缩后保留：
    // 1. 摘要
    // 2. 一条 assistant 确认消息
    // 3. 最新用户消息（如果最后一条本来就是用户）
    this.anthropicMessages = [
      { role: "user", content: `[Previous conversation summary]\n${summaryText}` },
      { role: "assistant", content: "Understood. I have the context from our previous conversation. How can I continue helping?" },
    ];
    if (lastUserMsg.role === "user") this.anthropicMessages.push(lastUserMsg);
    this.lastInputTokenCount = 0;
  }

  private async compactOpenAI(): Promise<void> {
    if (this.openaiMessages.length < 5) return;
    const systemMsg = this.openaiMessages[0];
    const lastUserMsg = this.openaiMessages[this.openaiMessages.length - 1];
    const summaryResp = await this.openaiClient!.chat.completions.create({
      model: this.model,
      max_tokens: 2048,
      messages: [
        { role: "system", content: "You are a conversation summarizer. Be concise but preserve important details." },
        ...this.openaiMessages.slice(1, -1),
        { role: "user", content: "Summarize the conversation so far in a concise paragraph, preserving key decisions, file paths, and context needed to continue the work." },
      ],
    });
    const summaryText = summaryResp.choices[0]?.message?.content || "No summary available.";
    // OpenAI 模式下要特别保留最前面的 system message。
    this.openaiMessages = [
      systemMsg,
      { role: "user", content: `[Previous conversation summary]\n${summaryText}` },
      { role: "assistant", content: "Understood. I have the context from our previous conversation. How can I continue helping?" },
    ];
    if ((lastUserMsg as any).role === "user") this.openaiMessages.push(lastUserMsg);
    this.lastInputTokenCount = 0;
  }

  // ─── 多层压缩流水线 ───────────────────────────────────────
  // 层次如下：
  // 1. budget：大结果按预算缩短
  // 2. snip：把旧结果替换成占位文本
  // 3. microcompact：长时间空闲后更激进清理
  // 4. auto-compact：真的快爆窗口时，额外调用模型做摘要
  //
  // 前三层完全在本地消息数组上操作，不消耗额外 token。

  private runCompressionPipeline(): void {
    if (this.useOpenAI) {
      this.budgetToolResultsOpenAI();
      this.snipStaleResultsOpenAI();
      this.microcompactOpenAI();
    } else {
      this.budgetToolResultsAnthropic();
      this.snipStaleResultsAnthropic();
      this.microcompactAnthropic();
    }
  }

  // 第一层：随着上下文利用率升高，动态缩短历史工具结果。
  private budgetToolResultsAnthropic(): void {
    const utilization = this.lastInputTokenCount / this.effectiveWindow;
    if (utilization < 0.5) return;
    // 利用率越高，给每条历史工具结果分配的预算越紧。
    const budget = utilization > 0.7 ? 15000 : 30000;

    for (const msg of this.anthropicMessages) {
      if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
      for (let i = 0; i < msg.content.length; i++) {
        const block = msg.content[i] as any;
        if (block.type === "tool_result" && typeof block.content === "string" && block.content.length > budget) {
          const keepEach = Math.floor((budget - 80) / 2);
          // 头尾各保留一段，中间插入说明，尽量保留“开始 + 结尾”两侧信息。
          block.content = block.content.slice(0, keepEach) +
            `\n\n[... budgeted: ${block.content.length - keepEach * 2} chars truncated ...]\n\n` +
            block.content.slice(-keepEach);
        }
      }
    }
  }

  private budgetToolResultsOpenAI(): void {
    const utilization = this.lastInputTokenCount / this.effectiveWindow;
    if (utilization < 0.5) return;
    const budget = utilization > 0.7 ? 15000 : 30000;

    for (const msg of this.openaiMessages) {
      // OpenAI 工具结果单独存在 role=tool 的消息里。
      if ((msg as any).role === "tool" && typeof (msg as any).content === "string") {
        const content = (msg as any).content as string;
        if (content.length > budget) {
          const keepEach = Math.floor((budget - 80) / 2);
          (msg as any).content = content.slice(0, keepEach) +
            `\n\n[... budgeted: ${content.length - keepEach * 2} chars truncated ...]\n\n` +
            content.slice(-keepEach);
        }
      }
    }
  }

  // 第二层：把“旧的、重复的”工具结果替换成一个轻量占位文本。
  private snipStaleResultsAnthropic(): void {
    const utilization = this.lastInputTokenCount / this.effectiveWindow;
    if (utilization < SNIP_THRESHOLD) return;

    // 先收集所有 `tool_result`，并找到它对应的工具名/文件路径。
    const results: { msgIdx: number; blockIdx: number; toolName: string; filePath?: string }[] = [];
    for (let mi = 0; mi < this.anthropicMessages.length; mi++) {
      const msg = this.anthropicMessages[mi];
      if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
      for (let bi = 0; bi < msg.content.length; bi++) {
        const block = msg.content[bi] as any;
        if (block.type === "tool_result" && typeof block.content === "string" && block.content !== SNIP_PLACEHOLDER) {
          // 根据 tool_use_id 反查触发它的 tool_use，拿到工具名和输入参数。
          const toolUseId = block.tool_use_id;
          const toolInfo = this.findToolUseById(toolUseId);
          if (toolInfo && SNIPPABLE_TOOLS.has(toolInfo.name)) {
            results.push({ msgIdx: mi, blockIdx: bi, toolName: toolInfo.name, filePath: toolInfo.input?.file_path });
          }
        }
      }
    }

    if (results.length <= KEEP_RECENT_RESULTS) return;

    // 策略：
    // 1. 重复读取同一文件时，优先裁掉旧读结果
    // 2. 其余结果中，只保留最近 N 条
    const toSnip = new Set<number>();
    const seenFiles = new Map<string, number[]>();

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.toolName === "read_file" && r.filePath) {
        const existing = seenFiles.get(r.filePath) || [];
        existing.push(i);
        seenFiles.set(r.filePath, existing);
      }
    }

    // 同一文件被多次 read 时，旧结果全部标记成可裁掉。
    for (const indices of seenFiles.values()) {
      if (indices.length > 1) {
        for (let j = 0; j < indices.length - 1; j++) toSnip.add(indices[j]);
      }
    }

    // 即便没有重复读取，太老的结果也会被 snip。
    const snipBefore = results.length - KEEP_RECENT_RESULTS;
    for (let i = 0; i < snipBefore; i++) toSnip.add(i);

    for (const idx of toSnip) {
      const r = results[idx];
      const block = (this.anthropicMessages[r.msgIdx].content as any[])[r.blockIdx];
      block.content = SNIP_PLACEHOLDER;
    }
  }

  private snipStaleResultsOpenAI(): void {
    const utilization = this.lastInputTokenCount / this.effectiveWindow;
    if (utilization < SNIP_THRESHOLD) return;

    // OpenAI 模式下每条工具结果都是独立消息，处理更简单。
    const toolMsgs: { idx: number; toolCallId: string }[] = [];
    for (let i = 0; i < this.openaiMessages.length; i++) {
      const msg = this.openaiMessages[i] as any;
      if (msg.role === "tool" && typeof msg.content === "string" && msg.content !== SNIP_PLACEHOLDER) {
        toolMsgs.push({ idx: i, toolCallId: msg.tool_call_id });
      }
    }

    if (toolMsgs.length <= KEEP_RECENT_RESULTS) return;

    // 直接裁掉最老的若干条，只保留最近 N 条。
    const snipCount = toolMsgs.length - KEEP_RECENT_RESULTS;
    for (let i = 0; i < snipCount; i++) {
      (this.openaiMessages[toolMsgs[i].idx] as any).content = SNIP_PLACEHOLDER;
    }
  }

  // 第三层：长时间空闲后，把更老的结果进一步清成极短占位。
  private microcompactAnthropic(): void {
    if (!this.lastApiCallTime || (Date.now() - this.lastApiCallTime) < MICROCOMPACT_IDLE_MS) return;

    // 收集所有仍未被 snip 的工具结果。
    const allResults: { msgIdx: number; blockIdx: number }[] = [];
    for (let mi = 0; mi < this.anthropicMessages.length; mi++) {
      const msg = this.anthropicMessages[mi];
      if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
      for (let bi = 0; bi < msg.content.length; bi++) {
        const block = msg.content[bi] as any;
        if (block.type === "tool_result" && typeof block.content === "string" &&
            block.content !== SNIP_PLACEHOLDER && block.content !== "[Old result cleared]") {
          allResults.push({ msgIdx: mi, blockIdx: bi });
        }
      }
    }

    // 保留最近 N 条，其余全部换成更短的占位文本。
    const clearCount = allResults.length - KEEP_RECENT_RESULTS;
    for (let i = 0; i < clearCount && i < allResults.length; i++) {
      const r = allResults[i];
      (this.anthropicMessages[r.msgIdx].content as any[])[r.blockIdx].content = "[Old result cleared]";
    }
  }

  private microcompactOpenAI(): void {
    if (!this.lastApiCallTime || (Date.now() - this.lastApiCallTime) < MICROCOMPACT_IDLE_MS) return;

    const toolMsgs: number[] = [];
    for (let i = 0; i < this.openaiMessages.length; i++) {
      const msg = this.openaiMessages[i] as any;
      if (msg.role === "tool" && typeof msg.content === "string" &&
          msg.content !== SNIP_PLACEHOLDER && msg.content !== "[Old result cleared]") {
        toolMsgs.push(i);
      }
    }

    // OpenAI 版本同样只保留最近 N 条 tool 消息。
    const clearCount = toolMsgs.length - KEEP_RECENT_RESULTS;
    for (let i = 0; i < clearCount && i < toolMsgs.length; i++) {
      (this.openaiMessages[toolMsgs[i]] as any).content = "[Old result cleared]";
    }
  }

  // 根据 tool_use_id 回溯 assistant 历史，找到原始工具调用信息。
  private findToolUseById(toolUseId: string): { name: string; input: any } | null {
    for (const msg of this.anthropicMessages) {
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
      for (const block of msg.content as any[]) {
        if (block.type === "tool_use" && block.id === toolUseId) {
          return { name: block.name, input: block.input };
        }
      }
    }
    return null;
  }

  // ─── 大结果持久化 ──────────────────────────────────────────
  // 某些工具结果（尤其 shell / grep / read）可能特别大。
  // 超过阈值时，不把全文塞回上下文，而是落盘并返回“摘要 + 文件路径”。

  private persistLargeResult(toolName: string, result: string): string {
    const THRESHOLD = 30 * 1024;
    if (Buffer.byteLength(result) <= THRESHOLD) return result;

    const dir = join(homedir(), ".mini-claude", "tool-results");
    mkdirSync(dir, { recursive: true });
    const filename = `${Date.now()}-${toolName}.txt`;
    const filepath = join(dir, filename);
    writeFileSync(filepath, result);

    const lines = result.split("\n");
    // 给模型保留前 200 行预览，同时告诉它如果需要可再 read_file 全文。
    const preview = lines.slice(0, 200).join("\n");
    const sizeKB = (Buffer.byteLength(result) / 1024).toFixed(1);

    return `[Result too large (${sizeKB} KB, ${lines.length} lines). Full output saved to ${filepath}. You can use read_file to see the full result.]\n\nPreview (first 200 lines):\n${preview}`;
  }

  // 统一的工具调用分发入口。
  private async executeToolCall(
    name: string,
    input: Record<string, any>
  ): Promise<string> {
    // plan mode 工具、agent、skill 都要在这里特殊分流。
    if (name === "enter_plan_mode" || name === "exit_plan_mode") return await this.executePlanModeTool(name);
    if (name === "agent") return this.executeAgentTool(input);
    if (name === "skill") return this.executeSkillTool(input);
    // MCP 前缀工具转发到 McpManager。
    if (this.mcpManager.isMcpTool(name)) return this.mcpManager.callTool(name, input);
    // 其余本地工具交给 tools.ts。
    return executeTool(name, input, this.readFileState);
  }

  // ─── skill 工具：inline / fork 两种执行模式 ────────────────

  private async executeSkillTool(input: Record<string, any>): Promise<string> {
    // 这里延迟 import，避免 agent.ts 与 skills.ts 提前形成复杂耦合。
    const { executeSkill } = await import("./skills.js");
    const result = executeSkill(input.skill_name, input.args || "");
    if (!result) return `Unknown skill: ${input.skill_name}`;

    if (result.context === "fork") {
      // fork 模式下单独创建子代理，隔离上下文和工具集。
      const tools = result.allowedTools
        ? this.tools.filter(t => result.allowedTools!.includes(t.name))
        : this.tools.filter(t => t.name !== "agent");

      printSubAgentStart("skill-fork", input.skill_name);
      const subAgent = new Agent({
        model: this.model,
        apiBase: this.useOpenAI ? this.openaiClient?.baseURL : undefined,
        customSystemPrompt: result.prompt,
        customTools: tools,
        isSubAgent: true,
        // 子代理默认 bypassPermissions，除非父代理正处于 plan mode。
        permissionMode: this.permissionMode === "plan" ? "plan" : "bypassPermissions",
      });

      try {
        const subResult = await subAgent.runOnce(input.args || "Execute this skill task.");
        // 子代理消耗的 token 也计入父代理总账。
        this.totalInputTokens += subResult.tokens.input;
        this.totalOutputTokens += subResult.tokens.output;
        printSubAgentEnd("skill-fork", input.skill_name);
        return subResult.text || "(Skill produced no output)";
      } catch (e: any) {
        printSubAgentEnd("skill-fork", input.skill_name);
        return `Skill fork error: ${e.message}`;
      }
    }

    // inline 模式不直接执行，只返回展开后的 prompt，让主模型继续当前上下文。
    return `[Skill "${input.skill_name}" activated]\n\n${result.prompt}`;
  }

  // ─── plan mode 相关辅助函数 ────────────────────────────────

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

  private async executePlanModeTool(name: string): Promise<string> {
    if (name === "enter_plan_mode") {
      if (this.permissionMode === "plan") {
        return "Already in plan mode.";
      }
      // 从普通模式切到 plan 模式时，保存原模式供稍后恢复。
      this.prePlanMode = this.permissionMode;
      this.permissionMode = "plan";
      this.planFilePath = this.generatePlanFilePath();
      this.systemPrompt = this.baseSystemPrompt + this.buildPlanModePrompt();
      if (this.useOpenAI && this.openaiMessages.length > 0) {
        (this.openaiMessages[0] as any).content = this.systemPrompt;
      }
      printInfo("Entered plan mode (read-only). Plan file: " + this.planFilePath);
      return `Entered plan mode. You are now in read-only mode.\n\nYour plan file: ${this.planFilePath}\nWrite your plan to this file. This is the only file you can edit.\n\nWhen your plan is complete, call exit_plan_mode.`;
    }

    if (name === "exit_plan_mode") {
      if (this.permissionMode !== "plan") {
        return "Not in plan mode.";
      }
      // 退出前先把 plan 文件正文读出来，等会儿要给用户审批。
      let planContent = "(No plan file found)";
      if (this.planFilePath && existsSync(this.planFilePath)) {
        planContent = readFileSync(this.planFilePath, "utf-8");
      }

      // 主 CLI 提供审批回调时，走完整的人机审批流程。
      if (this.planApprovalFn) {
        const result = await this.planApprovalFn(planContent);

        if (result.choice === "keep-planning") {
          // 用户要求继续规划时，不退出 plan mode，而是把反馈回传给模型。
          const feedback = result.feedback || "Please revise the plan.";
          return `User rejected the plan and wants to keep planning.\n\nUser feedback: ${feedback}\n\nPlease revise your plan based on this feedback. When done, call exit_plan_mode again.`;
        }

        // 用户通过后，要根据选项决定执行阶段切到哪种权限模式。
        let targetMode: PermissionMode;
        if (result.choice === "clear-and-execute") {
          targetMode = "acceptEdits";
        } else if (result.choice === "execute") {
          targetMode = "acceptEdits";
        } else {
          // 手动审批编辑时恢复原模式，通常是 default。
          targetMode = this.prePlanMode || "default";
        }

        // 真正退出 plan mode，并恢复基础 system prompt。
        this.permissionMode = targetMode;
        this.prePlanMode = null;
        const savedPlanPath = this.planFilePath;
        this.planFilePath = null;
        this.systemPrompt = this.baseSystemPrompt;
        if (this.useOpenAI && this.openaiMessages.length > 0) {
          (this.openaiMessages[0] as any).content = this.systemPrompt;
        }

        // 选了 clear-and-execute 时，要把历史清空，并把“已批准计划”作为新的用户消息灌回去。
        if (result.choice === "clear-and-execute") {
          this.clearHistoryKeepSystem();
          this.contextCleared = true;
          printInfo(`Plan approved. Context cleared, executing in ${targetMode} mode.`);
          return `User approved the plan. Context was cleared. Permission mode: ${targetMode}\n\nPlan file: ${savedPlanPath}\n\n## Approved Plan:\n${planContent}\n\nProceed with implementation.`;
        }

        printInfo(`Plan approved. Executing in ${targetMode} mode.`);
        return `User approved the plan. Permission mode: ${targetMode}\n\n## Approved Plan:\n${planContent}\n\nProceed with implementation.`;
      }

      // 如果没有审批回调（例如子代理里），就直接退出，不走交互审批。
      this.permissionMode = this.prePlanMode || "default";
      this.prePlanMode = null;
      this.planFilePath = null;
      this.systemPrompt = this.baseSystemPrompt;
      if (this.useOpenAI && this.openaiMessages.length > 0) {
        (this.openaiMessages[0] as any).content = this.systemPrompt;
      }
      printInfo("Exited plan mode. Restored to " + this.permissionMode + " mode.");
      return `Exited plan mode. Permission mode restored to: ${this.permissionMode}\n\n## Your Plan:\n${planContent}`;
    }

    return `Unknown plan mode tool: ${name}`;
  }

  // 清空历史但保留 system prompt，专供“批准计划并清上下文”使用。
  private clearHistoryKeepSystem() {
    this.anthropicMessages = [];
    this.openaiMessages = [];
    if (this.useOpenAI) {
      this.openaiMessages.push({ role: "system", content: this.systemPrompt });
    }
    this.lastInputTokenCount = 0;
  }

  private async executeAgentTool(input: Record<string, any>): Promise<string> {
    // agent 工具把一段 prompt 交给指定类型的子代理独立完成。
    const type = (input.type || "general") as SubAgentType;
    const description = input.description || "sub-agent task";
    const prompt = input.prompt || "";

    printSubAgentStart(type, description);

    const config = getSubAgentConfig(type);
    const subAgent = new Agent({
      model: this.model,
      // 当前实现里子代理不显式透传 key；Anthropic SDK 会从环境变量读取，
      // OpenAI 路径也主要依赖 baseURL 与现有环境配置。
      apiKey: undefined,
      apiBase: this.useOpenAI ? this.openaiClient?.baseURL : undefined,
      customSystemPrompt: config.systemPrompt,
      customTools: config.tools,
      isSubAgent: true,
      // 父代理处于 plan 模式时，子代理也必须被限制在只读模式。
      permissionMode: this.permissionMode === "plan" ? "plan" : "bypassPermissions",
    });

    try {
      const result = await subAgent.runOnce(prompt);
      // 子代理 token 使用量并入父代理。
      this.totalInputTokens += result.tokens.input;
      this.totalOutputTokens += result.tokens.output;
      printSubAgentEnd(type, description);
      return result.text || "(Sub-agent produced no output)";
    } catch (e: any) {
      printSubAgentEnd(type, description);
      return `Sub-agent error: ${e.message}`;
    }
  }

  // ─── Anthropic 后端主循环 ──────────────────────────────────

  private async chatAnthropic(userMessage: string): Promise<void> {
    // Anthropic 历史里 system prompt 不占位，因此第一步就是追加用户消息。
    this.anthropicMessages.push({ role: "user", content: userMessage });

    // 用户消息进入后，立即异步启动记忆预取，但不阻塞首轮模型调用。
    let memoryPrefetch: MemoryPrefetch | null = null;
    if (!this.isSubAgent) {
      const sq = this.buildSideQuery();
      if (sq) {
        memoryPrefetch = startMemoryPrefetch(
          userMessage, sq,
          this.alreadySurfacedMemories, this.sessionMemoryBytes,
          this.abortController?.signal,
        );
      }
    }

    // 这是典型 agent loop：直到模型不再请求工具为止。
    while (true) {
      if (this.abortController?.signal.aborted) break;

      // 每次请求模型前先做本地压缩，尽量节省上下文。
      this.runCompressionPipeline();

      // 记忆预取一旦完成，就在下一轮调用模型前把结果注入历史。
      // 注意：Anthropic 要求 user / assistant 交替，因此这里优先把记忆拼到最后一条 user 消息上。
      if (memoryPrefetch && memoryPrefetch.settled && !memoryPrefetch.consumed) {
        memoryPrefetch.consumed = true;
        try {
          const memories = await memoryPrefetch.promise;
          if (memories.length > 0) {
            const injectionText = formatMemoriesForInjection(memories);
            const last = this.anthropicMessages[this.anthropicMessages.length - 1];
            if (last && last.role === "user") {
              // Append to existing user message to maintain alternation
              if (typeof last.content === "string") {
                last.content = last.content + "\n\n" + injectionText;
              } else if (Array.isArray(last.content)) {
                (last.content as any[]).push({ type: "text", text: injectionText });
              }
            } else {
              this.anthropicMessages.push({ role: "user", content: injectionText });
            }
            for (const m of memories) {
              this.alreadySurfacedMemories.add(m.path);
              this.sessionMemoryBytes += Buffer.byteLength(m.content);
            }
          }
        } catch {
          // 预取阶段的报错已经在 memory.ts 中记录，这里静默即可。
        }
      }

      // 主代理等待模型回复时显示 spinner。
      if (!this.isSubAgent) startSpinner();

      // Anthropic 流式响应支持“工具块还没整条返回完时就提前开跑”。
      // 对于并发安全且权限可自动放行的工具，能把执行和模型生成重叠起来。
      const earlyExecutions = new Map<string, Promise<string>>();

      const response = await this.callAnthropicStream((block) => {
        const input = block.input as Record<string, any>;
        if (CONCURRENCY_SAFE_TOOLS.has(block.name)) {
          const perm = checkPermission(block.name, input, this.permissionMode, this.planFilePath || undefined);
          if (perm.action === "allow") {
            earlyExecutions.set(block.id, this.executeToolCall(block.name, input));
          }
        }
      });
      if (!this.isSubAgent) stopSpinner();
      this.lastApiCallTime = Date.now();
      // Anthropic 返回 usage，所以这里顺手累计 token。
      this.totalInputTokens += response.usage.input_tokens;
      this.totalOutputTokens += response.usage.output_tokens;
      this.lastInputTokenCount = response.usage.input_tokens;

      const toolUses: Anthropic.ToolUseBlock[] = [];

      for (const block of response.content) {
        if (block.type === "tool_use") {
          toolUses.push(block);
        }
      }

      // assistant 整条回复（文本 + tool_use）都要写入历史。
      this.anthropicMessages.push({
        role: "assistant",
        content: response.content,
      });

      if (toolUses.length === 0) {
        // 没有工具调用说明本轮对话结束，主代理输出成本统计。
        if (!this.isSubAgent) {
          printCost(this.totalInputTokens, this.totalOutputTokens);
        }
        break;
      }

      // 一轮“模型请求工具”算一个 agentic turn，先做预算检查。
      this.currentTurns++;
      const budget = this.checkBudget();
      if (budget.exceeded) {
        printInfo(`Budget exceeded: ${budget.reason}`);
        break;
      }

      // 稍后要以 user/tool_result 形式把所有工具结果回填给模型。
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      // 逐个处理 tool_use：
      // 1. 已经提前开始执行的，直接 await 结果
      // 2. 未提前执行的，正常做权限检查 -> 执行 -> 回填
      let contextBreak = false;
      for (const toolUse of toolUses) {
        if (contextBreak || this.abortController?.signal.aborted) break;
        const input = toolUse.input as Record<string, any>;
        printToolCall(toolUse.name, input);

        // 如果流式阶段已经开跑，就复用那个 promise，避免重复执行。
        const earlyPromise = earlyExecutions.get(toolUse.id);
        if (earlyPromise) {
          const raw = await earlyPromise;
          const res = this.persistLargeResult(toolUse.name, raw);
          printToolResult(toolUse.name, res);
          toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: res });
          continue;
        }

        // 没提前执行的工具，在这里做完整权限判定。
        const perm = checkPermission(toolUse.name, input, this.permissionMode, this.planFilePath || undefined);
        if (perm.action === "deny") {
          printInfo(`Denied: ${perm.message}`);
          toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: `Action denied: ${perm.message}` });
          continue;
        }
        if (perm.action === "confirm" && perm.message && !this.confirmedPaths.has(perm.message)) {
          const confirmed = await this.confirmDangerous(perm.message);
          if (!confirmed) {
            toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: "User denied this action." });
            continue;
          }
          this.confirmedPaths.add(perm.message);
        }

        const raw = await this.executeToolCall(toolUse.name, input);
        const res = this.persistLargeResult(toolUse.name, raw);
        printToolResult(toolUse.name, res);

        if (this.contextCleared) {
          // clear-and-execute 场景下，plan 审批会清空历史。
          // 此时不能再继续把其它 tool_result 塞回旧上下文，而是直接把批准后的计划
          // 当成新的 user 消息，跳出当前批次，让下一轮从新上下文继续。
          this.contextCleared = false;
          this.anthropicMessages.push({ role: "user", content: res });
          contextBreak = true;
          break;
        }
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: res });
      }

      if (!contextBreak && !this.contextCleared && toolResults.length > 0) {
        this.anthropicMessages.push({ role: "user", content: toolResults });
      }
      this.contextCleared = false;

      // 回到循环顶部前，看看是否需要摘要压缩。
      await this.checkAndCompact();
    }
  }

  /**
   * 发起一次 Anthropic 流式调用。
   * 关键点在于：当某个 tool_use block 在流里完成时，会立刻触发回调，
   * 这样主循环就能“边收模型输出，边提前执行安全工具”。
   */
  private async callAnthropicStream(
    onToolBlockComplete?: (block: Anthropic.ToolUseBlock) => void,
  ): Promise<Anthropic.Message> {
    return withRetry(async (signal) => {
      const maxOutput = getMaxOutputTokens(this.model);
      // Anthropic 每次请求都直接传 system、tools、messages。
      const createParams: any = {
        model: this.model,
        max_tokens: this.thinkingMode !== "disabled" ? maxOutput : 16384,
        system: this.systemPrompt,
        tools: getActiveToolDefinitions(this.tools),
        messages: this.anthropicMessages,
      };

      // adaptive / enabled 两种模式最终都要下发 thinking 配置，只是前置判断不同。
      if (this.thinkingMode === "adaptive") {
        createParams.thinking = { type: "enabled", budget_tokens: maxOutput - 1 };
      } else if (this.thinkingMode === "enabled") {
        createParams.thinking = { type: "enabled", budget_tokens: maxOutput - 1 };
      }

      const stream = this.anthropicClient!.messages.stream(createParams, { signal });

      // 普通文本 token 通过高层 `text` 事件持续输出。
      let firstText = true;
      stream.on("text", (text: string) => {
        if (firstText) { stopSpinner(); this.emitText("\n"); firstText = false; }
        this.emitText(text);
      });

      // 更底层的 `streamEvent` 事件同时承载：
      // 1. thinking 文本
      // 2. tool_use 的输入 JSON 碎片
      //
      // 这里用 `event.index` 跟踪每个进行中的 block。
      const toolBlocksByIndex = new Map<number, { id: string; name: string; inputJson: string }>();
      let inThinking = false;

      stream.on("streamEvent" as any, (event: any) => {
        // thinking block 单独以 dim 样式透传到终端。
        if (event.type === "content_block_start" && event.content_block?.type === "thinking") {
          if (this.thinkingMode !== "disabled") {
            inThinking = true;
            stopSpinner();
            this.emitText("\n" + chalk.dim("  [thinking] "));
          }
        } else if (event.type === "content_block_delta" && event.delta?.type === "thinking_delta" && inThinking) {
          this.emitText(chalk.dim(event.delta.thinking));
        }

        // tool_use 的参数 JSON 不是一次性给全，而是增量拼出来的。
        if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
          toolBlocksByIndex.set(event.index, {
            id: event.content_block.id,
            name: event.content_block.name,
            inputJson: "",
          });
        } else if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
          const tb = toolBlocksByIndex.get(event.index);
          if (tb) tb.inputJson += event.delta.partial_json;
        }

        // 某个 block 结束时：
        // 1. 如果是 thinking，就补一个换行收尾
        // 2. 如果是 tool_use，就解析累积 JSON 并触发回调
        if (event.type === "content_block_stop") {
          if (inThinking) { this.emitText("\n"); inThinking = false; }
          const tb = toolBlocksByIndex.get(event.index);
          if (tb && onToolBlockComplete) {
            let parsedInput: Record<string, any> = {};
            try { parsedInput = JSON.parse(tb.inputJson || "{}"); } catch {}
            onToolBlockComplete({ type: "tool_use", id: tb.id, name: tb.name, input: parsedInput });
            toolBlocksByIndex.delete(event.index);
          }
        }
      });

      const finalMessage = await stream.finalMessage();

      // thinking 只给用户看，不写入正式消息历史，避免污染后续上下文。
      finalMessage.content = finalMessage.content.filter(
        (block: any) => block.type !== "thinking"
      );

      return finalMessage;
    }, this.abortController?.signal);
  }

  // ─── OpenAI-compatible 后端主循环 ──────────────────────────

  private async chatOpenAI(userMessage: string): Promise<void> {
    // OpenAI 模式里 system 已经在消息历史第一条，所以这里只需要追加 user。
    this.openaiMessages.push({ role: "user", content: userMessage });

    // 同样先启动异步记忆召回。
    let memoryPrefetch: MemoryPrefetch | null = null;
    if (!this.isSubAgent) {
      const sq = this.buildSideQuery();
      if (sq) {
        memoryPrefetch = startMemoryPrefetch(
          userMessage, sq,
          this.alreadySurfacedMemories, this.sessionMemoryBytes,
        );
      }
    }

    while (true) {
      if (this.abortController?.signal.aborted) break;

      // 请求前压缩历史。
      this.runCompressionPipeline();

      // 预取完成后，把记忆注入到最后一条 user 消息里。
      if (memoryPrefetch && memoryPrefetch.settled && !memoryPrefetch.consumed) {
        memoryPrefetch.consumed = true;
        try {
          const memories = await memoryPrefetch.promise;
          if (memories.length > 0) {
            const injectionText = formatMemoriesForInjection(memories);
            const last = this.openaiMessages[this.openaiMessages.length - 1];
            if (last && last.role === "user") {
              last.content = (last.content || "") + "\n\n" + injectionText;
            } else {
              this.openaiMessages.push({ role: "user", content: injectionText });
            }
            for (const m of memories) {
              this.alreadySurfacedMemories.add(m.path);
              this.sessionMemoryBytes += Buffer.byteLength(m.content);
            }
          }
        } catch {
          // 预取错误已在下层记录。
        }
      }

      if (!this.isSubAgent) startSpinner();
      const response = await this.callOpenAIStream();
      if (!this.isSubAgent) stopSpinner();
      this.lastApiCallTime = Date.now();

      // OpenAI 流式调用的 usage 在最后一个 chunk 里返回，这里统一累计。
      if (response.usage) {
        this.totalInputTokens += response.usage.prompt_tokens;
        this.totalOutputTokens += response.usage.completion_tokens;
        this.lastInputTokenCount = response.usage.prompt_tokens;
      }

      const choice = response.choices?.[0];
      if (!choice) break;
      const message = choice.message;

      // assistant 回复要先写入历史，然后再处理其中可能带的 tool_calls。
      this.openaiMessages.push(message);

      // 没有 tool_calls 说明这轮已经得到最终文本答案。
      const toolCalls = message.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        if (!this.isSubAgent) {
          printCost(this.totalInputTokens, this.totalOutputTokens);
        }
        break;
      }

      // 有工具调用时，计作一个 turn 并检查预算。
      this.currentTurns++;
      const budget = this.checkBudget();
      if (budget.exceeded) {
        printInfo(`Budget exceeded: ${budget.reason}`);
        break;
      }

      // 第一阶段：串行解析所有 tool call，并完成权限检查。
      // 之所以先串行，是因为这里可能需要用户交互确认。
      type OAIChecked = { tc: typeof toolCalls[0]; fnName: string; input: Record<string, any>; allowed: boolean; result?: string };
      const oaiChecked: OAIChecked[] = [];
      for (const tc of toolCalls) {
        if (this.abortController?.signal.aborted) break;
        if (tc.type !== "function") continue;
        const fnName = tc.function.name;
        let input: Record<string, any>;
        // function arguments 是 JSON 字符串，先解析成对象。
        try { input = JSON.parse(tc.function.arguments); } catch { input = {}; }

        printToolCall(fnName, input);

        const perm = checkPermission(fnName, input, this.permissionMode, this.planFilePath || undefined);
        if (perm.action === "deny") {
          printInfo(`Denied: ${perm.message}`);
          oaiChecked.push({ tc, fnName, input, allowed: false, result: `Action denied: ${perm.message}` });
          continue;
        }
        if (perm.action === "confirm" && perm.message && !this.confirmedPaths.has(perm.message)) {
          const confirmed = await this.confirmDangerous(perm.message);
          if (!confirmed) {
            oaiChecked.push({ tc, fnName, input, allowed: false, result: "User denied this action." });
            continue;
          }
          this.confirmedPaths.add(perm.message);
        }
        oaiChecked.push({ tc, fnName, input, allowed: true });
      }

      // 第二阶段：把连续的“可并发安全工具”聚成 batch 并行执行。
      // 为什么是“连续的”：
      // 因为要尽量保持模型原始 tool call 顺序，不跨越中间的危险/串行工具。
      type OAIBatch = { concurrent: boolean; items: OAIChecked[] };
      const oaiBatches: OAIBatch[] = [];
      for (const ct of oaiChecked) {
        const safe = ct.allowed && CONCURRENCY_SAFE_TOOLS.has(ct.fnName);
        if (safe && oaiBatches.length > 0 && oaiBatches[oaiBatches.length - 1].concurrent) {
          oaiBatches[oaiBatches.length - 1].items.push(ct);
        } else {
          oaiBatches.push({ concurrent: safe, items: [ct] });
        }
      }

      let oaiContextBreak = false;
      for (const batch of oaiBatches) {
        if (oaiContextBreak || this.abortController?.signal.aborted) break;

        if (batch.concurrent) {
          // 同一个并发 batch 里的工具结果统一并行拉起。
          const results = await Promise.all(
            batch.items.map(async (ct) => {
              const raw = await this.executeToolCall(ct.fnName, ct.input);
              const res = this.persistLargeResult(ct.fnName, raw);
              printToolResult(ct.fnName, res);
              return { ct, res };
            })
          );
          for (const { ct, res } of results) {
            // OpenAI 要把每个工具结果单独作为 role=tool 的消息追加回去。
            this.openaiMessages.push({ role: "tool", tool_call_id: ct.tc.id, content: res });
          }
        } else {
          for (const ct of batch.items) {
            if (!ct.allowed) {
              this.openaiMessages.push({ role: "tool", tool_call_id: ct.tc.id, content: ct.result! });
              continue;
            }
            const raw = await this.executeToolCall(ct.fnName, ct.input);
            const res = this.persistLargeResult(ct.fnName, raw);
            printToolResult(ct.fnName, res);

            if (this.contextCleared) {
              // 与 Anthropic 一样，清空上下文时改成注入一条新的 user 消息并中断本轮。
              this.contextCleared = false;
              this.openaiMessages.push({ role: "user", content: res });
              oaiContextBreak = true;
              break;
            }
            this.openaiMessages.push({ role: "tool", tool_call_id: ct.tc.id, content: res });
          }
        }
      }

      this.contextCleared = false;
      await this.checkAndCompact();
    }
  }

  private async callOpenAIStream(): Promise<OpenAI.ChatCompletion> {
    return withRetry(async (signal) => {
      // OpenAI 这里统一走 stream=true，再把 chunk 重新组装成一个 ChatCompletion 形态。
      const stream = await this.openaiClient!.chat.completions.create({
        model: this.model,
        max_tokens: 16384,
        tools: toOpenAITools(getActiveToolDefinitions(this.tools)),
        messages: this.openaiMessages,
        stream: true,
        stream_options: { include_usage: true },
      }, { signal });

      // 用几个局部变量拼装出最后完整的 assistant message。
      let content = "";
      let firstText = true;
      const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();
      let finishReason = "";
      let usage: { prompt_tokens: number; completion_tokens: number } | undefined;

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;

        // usage 通常出现在最后一个 chunk，此时可能没有 delta。
        if (chunk.usage) {
          usage = {
            prompt_tokens: chunk.usage.prompt_tokens,
            completion_tokens: chunk.usage.completion_tokens,
          };
        }

        if (!delta) continue;

        // 普通文本 token 直接流式输出到终端/缓冲。
        if (delta.content) {
          if (firstText) { stopSpinner(); this.emitText("\n"); firstText = false; }
          this.emitText(delta.content);
          content += delta.content;
        }

        // tool_call 的 arguments 同样可能被切成多个 chunk。
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const existing = toolCalls.get(tc.index);
            if (existing) {
              if (tc.function?.arguments) existing.arguments += tc.function.arguments;
            } else {
              toolCalls.set(tc.index, {
                id: tc.id || "",
                name: tc.function?.name || "",
                arguments: tc.function?.arguments || "",
              });
            }
          }
        }

        if (chunk.choices[0]?.finish_reason) {
          finishReason = chunk.choices[0].finish_reason;
        }
      }

      // 把按 index 收集的 tool_calls 恢复为有序数组。
      const assembledToolCalls = toolCalls.size > 0
        ? Array.from(toolCalls.entries())
            .sort(([a], [b]) => a - b)
            .map(([idx, tc]) => ({
              id: tc.id,
              type: "function" as const,
              function: { name: tc.name, arguments: tc.arguments },
            }))
        : undefined;

      // 返回一个“仿完整版”的 ChatCompletion，供上层沿用非流式处理逻辑。
      return {
        id: "stream",
        object: "chat.completion",
        created: Date.now(),
        model: this.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant" as const,
              content: content || null,
              tool_calls: assembledToolCalls,
              refusal: null,
            },
            finish_reason: finishReason || "stop",
            logprobs: null,
          },
        ],
        usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      } as OpenAI.ChatCompletion;
    }, this.abortController?.signal);
  }

  // ─── 共享交互辅助 ──────────────────────────────────────────

  private async confirmDangerous(command: string): Promise<boolean> {
    printConfirmation(command);
    // REPL 模式优先复用外部传进来的 confirmFn，
    // 这样就不会在同一个 stdin 上创建第二个 readline。
    if (this.confirmFn) {
      return this.confirmFn(command);
    }
    // one-shot 模式下没有共享 readline，只能临时建一个来询问。
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    return new Promise((resolve) => {
      rl.question("  Allow? (y/n): ", (answer) => {
        rl.close();
        resolve(answer.toLowerCase().startsWith("y"));
      });
    });
  }
}
````

### 步骤 2：确认和参考仓库零差异

````bash
cd "$TARGET_REPO"
diff -u "$REFERENCE_REPO/src/agent.ts" "$TARGET_REPO/src/agent.ts"
````

### 步骤 3：重新编译

````bash
cd "$TARGET_REPO"
npm run build
````

### 步骤 4：先做一个不访问模型的本地 smoke test

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

### 步骤 5：可选，做一次真实最小对话

如果你已经配置了真实模型环境变量，可以执行下面任意一组。

Anthropic 方式：

````bash
cd "$TARGET_REPO"
export ANTHROPIC_API_KEY=你的真实密钥
export MINI_CLAUDE_MODEL=claude-sonnet-4-6
node --input-type=module <<'EOF'
import { Agent } from "./dist/agent.js";

const agent = new Agent({
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: process.env.MINI_CLAUDE_MODEL || "claude-sonnet-4-6"
});

const result = await agent.runOnce("Reply with exactly: AGENT_OK");
console.log(result.text.trim());
console.log(result.tokens);
EOF
````

OpenAI-compatible 方式：

````bash
cd "$TARGET_REPO"
export OPENAI_API_KEY=你的真实密钥
export OPENAI_BASE_URL=你的兼容接口地址
node --input-type=module <<'EOF'
import { Agent } from "./dist/agent.js";

const agent = new Agent({
  apiKey: process.env.OPENAI_API_KEY,
  apiBase: process.env.OPENAI_BASE_URL,
  model: "gpt-4o-mini"
});

const result = await agent.runOnce("Reply with exactly: AGENT_OK");
console.log(result.text.trim());
console.log(result.tokens);
EOF
````

## 本小节的“手把手测试流程”

````bash
cd "$TARGET_REPO"
diff -u "$REFERENCE_REPO/src/agent.ts" "$TARGET_REPO/src/agent.ts"
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

到这里，Agent 内核章节完成。下一章把占位 CLI 换成正式入口：[12-cli.md](./12-cli.md)
