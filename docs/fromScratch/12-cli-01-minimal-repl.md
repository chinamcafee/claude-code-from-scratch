# 第 12-1 节：先接上参数解析、最小 REPL 和主启动流程

这一小节结束后，你拿到的不是最终版 `src/cli.ts`，而是一个“已经能启动、能进 REPL、能退出”的阶段版。

这个阶段版会先把参数解析、最小 REPL 循环、Ctrl+C 处理和主程序入口接起来；内建命令和技能调用放到下一小节再补。

## 本小节目标

1. 支持 `--help`、`--resume`、`--model`、`--max-cost`、`--max-turns` 等参数解析。
2. 支持最小 REPL：空输入继续等待，`exit` / `quit` 可以退出。
3. 能进入主启动流程，并在无真实对话时正常退出。
4. 成功编译当前工程。

## 这份阶段版源码来自哪里

这一小节的阶段版 `src/cli.ts` 完全由参考文件中的这些原始片段拼成：

- 第 1-126 行
- 第 128-144 行
- 第 179-219 行
- 第 310-326 行
- 第 328-416 行

这里故意先不带 `/clear /plan /cost /compact /memory /skills` 和技能分发那一大段分支逻辑，只保留“可启动的最小 CLI 主骨架”。

## 手把手实操

### 步骤 1：用第一阶段版本覆盖 `src/cli.ts`

把第 1 章里的占位版 `$TARGET_REPO/src/cli.ts` 整个替换成下面这份阶段版代码。

#### 当前阶段版 `src/cli.ts` 完整代码

````ts
#!/usr/bin/env node

import * as readline from "readline";
import { Agent } from "./agent.js";
import { printWelcome, printUserPrompt, printError, printInfo, printPlanForApproval, printPlanApprovalOptions } from "./ui.js";
import { loadSession, getLatestSessionId } from "./session.js";
import { listMemories } from "./memory.js";
import { discoverSkills, resolveSkillPrompt, getSkillByName, executeSkill } from "./skills.js";
import type { PermissionMode } from "./tools.js";

// `parseArgs` 最终整理出的 CLI 参数对象。
interface ParsedArgs {
  // 权限模式会直接影响工具调用是否自动放行。
  permissionMode: PermissionMode;
  // 模型名，既支持默认值，也允许命令行覆盖。
  model: string;
  // OpenAI-compatible API 的 base URL；Anthropic 代理地址也复用这个字段承接。
  apiBase?: string;
  // 非交互模式下一次性发送给 agent 的 prompt。
  prompt?: string;
  // 是否恢复最近一次会话。
  resume?: boolean;
  // 是否开启 thinking。
  thinking?: boolean;
  // 成本预算上限（美元）。
  maxCost?: number;
  // 最多允许多少轮 agentic turn。
  maxTurns?: number;
}

function parseArgs(): ParsedArgs {
  // `process.argv` 前两项分别是 node 路径和脚本路径，真正参数从索引 2 开始。
  const args = process.argv.slice(2);
  let permissionMode: PermissionMode = "default";
  let thinking = false;
  // 默认模型可被环境变量覆盖，便于用户长期定制。
  let model = process.env.MINI_CLAUDE_MODEL || "claude-opus-4-6";
  let apiBase: string | undefined;
  let resume = false;
  let maxCost: number | undefined;
  let maxTurns: number | undefined;
  // 非 flag 参数最终会拼成一个 prompt 字符串。
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    // 权限相关 flag 是互斥覆盖关系：后出现的值会覆盖前面的值。
    if (args[i] === "--yolo" || args[i] === "-y") {
      permissionMode = "bypassPermissions";
    } else if (args[i] === "--plan") {
      permissionMode = "plan";
    } else if (args[i] === "--accept-edits") {
      permissionMode = "acceptEdits";
    } else if (args[i] === "--dont-ask") {
      permissionMode = "dontAsk";
    } else if (args[i] === "--thinking") {
      thinking = true;
    } else if (args[i] === "--model" || args[i] === "-m") {
      // `++i` 会直接消费下一个参数作为值；缺省时保留原值。
      model = args[++i] || model;
    } else if (args[i] === "--api-base") {
      apiBase = args[++i];
    } else if (args[i] === "--resume") {
      resume = true;
    } else if (args[i] === "--max-cost") {
      // 无法解析为数字时忽略，保持 undefined。
      const v = parseFloat(args[++i]);
      if (!isNaN(v)) maxCost = v;
    } else if (args[i] === "--max-turns") {
      const v = parseInt(args[++i], 10);
      if (!isNaN(v)) maxTurns = v;
    } else if (args[i] === "--help" || args[i] === "-h") {
      // `--help` 直接打印说明并退出，不进入主流程。
      console.log(`
Usage: mini-claude [options] [prompt]

Options:
  --yolo, -y          Skip all confirmation prompts (bypassPermissions mode)
  --plan              Plan mode: read-only, describe changes without executing
  --accept-edits      Auto-approve file edits, still confirm dangerous shell
  --dont-ask          Auto-deny anything needing confirmation (for CI)
  --thinking          Enable extended thinking (Anthropic only)
  --model, -m         Model to use (default: claude-opus-4-6, or MINI_CLAUDE_MODEL env)
  --api-base URL      Use OpenAI-compatible API endpoint (key via env var)
  --resume            Resume the last session
  --max-cost USD      Stop when estimated cost exceeds this amount
  --max-turns N       Stop after N agentic turns
  --help, -h          Show this help

REPL commands:
  /clear              Clear conversation history
  /plan               Toggle plan mode (read-only ↔ normal)
  /cost               Show token usage and cost
  /compact            Manually compact conversation
  /memory             List saved memories
  /skills             List available skills
  /<skill-name>       Invoke a skill (e.g. /commit "fix types")

Examples:
  mini-claude "fix the bug in src/app.ts"
  mini-claude --yolo "run all tests and fix failures"
  mini-claude --plan "how would you refactor this?"
  mini-claude --accept-edits "add error handling to api.ts"
  mini-claude --max-cost 0.50 --max-turns 20 "implement feature X"
  OPENAI_API_KEY=sk-xxx mini-claude --api-base https://aihubmix.com/v1 --model gpt-4o "hello"
  mini-claude --resume
  mini-claude  # starts interactive REPL
`);
      process.exit(0);
    } else {
      // 其余内容全部视为位置参数，后面会 join 成用户 prompt。
      positional.push(args[i]);
    }
  }

  // 统一把解析结果打包给 `main()` 使用。
  return {
    permissionMode,
    model,
    apiBase,
    resume,
    thinking,
    maxCost,
    maxTurns,
    prompt: positional.length > 0 ? positional.join(" ") : undefined,
  };
}
async function runRepl(agent: Agent) {
  // REPL 的 readline 实例要贯穿整个会话，不能为每次确认都新建一个。
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // 危险操作确认也复用这一套 readline。
  // 这是为了绕开 Node.js 常见坑：同一个 stdin 上开第二个 readline，
  // 在 close 时容易把第一个交互循环也一起“杀掉”。
  agent.setConfirmFn((_message: string) => {
    return new Promise((resolve) => {
      rl.question("  Allow? (y/n): ", (answer) => {
        resolve(answer.toLowerCase().startsWith("y"));
      });
    });
  });
  // Ctrl+C 逻辑分成两类：
  // 1. 正在执行时，第一次 Ctrl+C 只中断当前请求。
  // 2. 空闲状态下，连续两次 Ctrl+C 才退出整个 REPL。
  let sigintCount = 0;
  process.on("SIGINT", () => {
    if (agent.isProcessing) {
      agent.abort();
      console.log("\n  (interrupted)");
      sigintCount = 0;
      printUserPrompt();
    } else {
      sigintCount++;
      if (sigintCount >= 2) {
        console.log("\nBye!\n");
        process.exit(0);
      }
      console.log("\n  Press Ctrl+C again to exit.");
      printUserPrompt();
    }
  });

  printWelcome();

  const askQuestion = (): void => {
    // 每次等待输入前都先打印用户提示符。
    printUserPrompt();
    rl.once("line", async (line) => {
      const input = line.trim();
      sigintCount = 0;

      // 空输入直接忽略，继续等待下一次输入。
      if (!input) {
        askQuestion();
        return;
      }
      // 兼容最常见的退出命令。
      if (input === "exit" || input === "quit") {
        console.log("\nBye!\n");
        rl.close();
        process.exit(0);
      }
      try {
        await agent.chat(input);
      } catch (e: any) {
        if (e.name === "AbortError" || e.message?.includes("aborted")) {
          // Ctrl+C 已经在 SIGINT 处理器里给过提示，这里不重复输出。
        } else {
          printError(e.message);
        }
      }

      // 一轮处理结束后继续进入下一次提问。
      askQuestion();
    });
  };

  askQuestion();
}
async function main() {
  // 所有 CLI 参数都先解析成结构化对象。
  const { permissionMode, model, apiBase, prompt, resume, thinking, maxCost, maxTurns } = parseArgs();

  // API 配置只接受环境变量里的 key，不允许从命令行明文传 key。
  let resolvedApiBase = apiBase;
  let resolvedApiKey: string | undefined;
  let resolvedUseOpenAI = !!apiBase;

  // 优先级规则：
  // 1. 同时提供 OPENAI_API_KEY + OPENAI_BASE_URL -> 走 OpenAI-compatible
  // 2. 否则有 ANTHROPIC_API_KEY -> 走 Anthropic
  // 3. 否则只有 OPENAI_API_KEY -> 也走 OpenAI-compatible
  //
  // 这样可以兼容“用户只设置一套环境变量”的常见情况。
  if (process.env.OPENAI_API_KEY && process.env.OPENAI_BASE_URL) {
    resolvedApiKey = process.env.OPENAI_API_KEY;
    resolvedApiBase = resolvedApiBase || process.env.OPENAI_BASE_URL;
    resolvedUseOpenAI = true;
  } else if (process.env.ANTHROPIC_API_KEY) {
    resolvedApiKey = process.env.ANTHROPIC_API_KEY;
    resolvedApiBase = resolvedApiBase || process.env.ANTHROPIC_BASE_URL;
    resolvedUseOpenAI = false;
  } else if (process.env.OPENAI_API_KEY) {
    resolvedApiKey = process.env.OPENAI_API_KEY;
    resolvedApiBase = resolvedApiBase || process.env.OPENAI_BASE_URL;
    resolvedUseOpenAI = true;
  }

  // 用户显式传了 `--api-base` 但没提供匹配环境变量时，
  // 退回尝试从任一已存在的 API key 里兜底。
  if (!resolvedApiKey && apiBase) {
    resolvedApiKey = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;
    resolvedUseOpenAI = true;
  }

  // 两种 key 都没有时，直接给出明确报错并退出。
  if (!resolvedApiKey) {
    printError(
      `API key is required.\n` +
        `  Set ANTHROPIC_API_KEY (+ optional ANTHROPIC_BASE_URL) for Anthropic format,\n` +
        `  or OPENAI_API_KEY + OPENAI_BASE_URL for OpenAI-compatible format.`
    );
    process.exit(1);
  }

  // 到这里说明模型、权限模式、预算、API 配置都已确定，可以实例化 agent。
  const agent = new Agent({
    permissionMode, model, thinking, maxCostUsd: maxCost, maxTurns,
    apiBase: resolvedUseOpenAI ? resolvedApiBase : undefined,
    anthropicBaseURL: !resolvedUseOpenAI ? resolvedApiBase : undefined,
    apiKey: resolvedApiKey,
  });

  // 如要求恢复会话，则默认恢复最近的一次。
  if (resume) {
    const sessionId = getLatestSessionId();
    if (sessionId) {
      const session = loadSession(sessionId);
      if (session) {
        // 这里只恢复消息历史，不强行覆盖当前命令行传入的模型/权限模式。
        agent.restoreSession({
          anthropicMessages: session.anthropicMessages,
          openaiMessages: session.openaiMessages,
        });
      } else {
        printInfo("No session found to resume.");
      }
    } else {
      printInfo("No previous sessions found.");
    }
  }

  if (prompt) {
    // 传了 prompt 就走 one-shot 模式：执行一次后退出。
    try {
      await agent.chat(prompt);
    } catch (e: any) {
      printError(e.message);
      process.exit(1);
    }
  } else {
    // 没传 prompt 则进入交互式 REPL。
    await runRepl(agent);
  }
}

// CLI 程序入口。
main();
````

### 步骤 2：先编译

```bash
cd "$TARGET_REPO"
npm run build
```

### 步骤 3：测试帮助页和最小 REPL

```bash
cd "$TARGET_REPO"
node dist/cli.js --help

printf "exit\n" | env ANTHROPIC_API_KEY=dummy node dist/cli.js
```

## 现在你应该看到什么

1. `npm run build` 可以通过。
2. `node dist/cli.js --help` 会打印完整帮助页。
3. 第二条命令会进入一次 REPL，然后在读到 `exit` 后打印 `Bye!` 并退出。

## 本小节的“手把手测试流程”

1. 先执行“步骤 1”，用最小 CLI 阶段版替换占位文件。
2. 再执行“步骤 2”的 `npm run build`。
3. 最后执行“步骤 3”的两条命令，确认帮助页和最小 REPL 都已经可用。
