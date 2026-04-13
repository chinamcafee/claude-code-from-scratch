# 第 12-2 节：补上内建命令、技能调用并收口到最终版 `cli.ts`

这一小节会把 `src/cli.ts` 收口到最终版。

你会在上一小节的基础上补上完整 REPL 分支逻辑：`/clear /plan /cost /compact /memory /skills`、技能调用分发，以及最终的一比一源码验收。

## 本小节目标

1. 支持完整 REPL 内建命令。
2. 支持 `/<skill-name>` 的技能调用入口。
3. 可以用 `diff` 确认当前 `src/cli.ts` 与参考仓库零差异。
4. 成功编译当前工程。

## 这份阶段版源码来自哪里

这一小节直接使用参考仓库最终版 `src/cli.ts`：

- 第 1-416 行

## 手把手实操

### 步骤 1：用最终版覆盖 `src/cli.ts`

把 `$TARGET_REPO/src/cli.ts` 整个替换成下面这份最终代码。

#### 最终版 `src/cli.ts` 完整代码

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

  // plan 模式退出时，不是简单 yes/no，而是四选一审批流程。
  agent.setPlanApprovalFn((planContent: string) => {
    return new Promise((resolve) => {
      printPlanForApproval(planContent);
      printPlanApprovalOptions();

      const askChoice = () => {
        rl.question("  Enter choice (1-4): ", (answer) => {
          const choice = answer.trim();
          if (choice === "1") {
            // 清空上下文后执行，适合长 planning 结束后重新聚焦。
            resolve({ choice: "clear-and-execute" });
          } else if (choice === "2") {
            // 保留上下文继续执行，减少重新解释成本。
            resolve({ choice: "execute" });
          } else if (choice === "3") {
            // 切回正常权限模式，后续编辑仍逐次确认。
            resolve({ choice: "manual-execute" });
          } else if (choice === "4") {
            // 用户反馈会被重新送回模型，让它继续规划。
            rl.question("  Feedback (what to change): ", (feedback) => {
              resolve({ choice: "keep-planning", feedback: feedback.trim() || undefined });
            });
          } else {
            console.log("  Invalid choice. Enter 1, 2, 3, or 4.");
            askChoice();
          }
        });
      };
      askChoice();
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

      // 先拦截 REPL 内建命令。
      if (input === "/clear") {
        agent.clearHistory();
        askQuestion();
        return;
      }
      if (input === "/plan") {
        // 返回值目前只是给调用者用；这里不用打印，因为 toggle 内部已输出信息。
        const newMode = agent.togglePlanMode();
        askQuestion();
        return;
      }
      if (input === "/cost") {
        agent.showCost();
        askQuestion();
        return;
      }
      if (input === "/compact") {
        try {
          await agent.compact();
        } catch (e: any) {
          printError(e.message);
        }
        askQuestion();
        return;
      }
      if (input === "/memory") {
        const memories = listMemories();
        if (memories.length === 0) {
          printInfo("No memories saved yet.");
        } else {
          // 只打印轻量摘要，不直接展示每条记忆正文。
          printInfo(`${memories.length} memories:`);
          for (const m of memories) {
            console.log(`    [${m.type}] ${m.name} — ${m.description}`);
          }
        }
        askQuestion();
        return;
      }
      if (input === "/skills") {
        const skills = discoverSkills();
        if (skills.length === 0) {
          printInfo("No skills found. Add skills to .claude/skills/<name>/SKILL.md");
        } else {
          // 用户可调用的技能显示成 `/name`，自动技能则只显示名字。
          printInfo(`${skills.length} skills:`);
          for (const s of skills) {
            const tag = s.userInvocable ? `/${s.name}` : s.name;
            console.log(`    ${tag} (${s.source}) — ${s.description}`);
          }
        }
        askQuestion();
        return;
      }

      // `/foo xxx` 这种输入优先尝试解释成“手动调用技能”。
      if (input.startsWith("/")) {
        const spaceIdx = input.indexOf(" ");
        const cmdName = spaceIdx > 0 ? input.slice(1, spaceIdx) : input.slice(1);
        const cmdArgs = spaceIdx > 0 ? input.slice(spaceIdx + 1) : "";
        const skill = getSkillByName(cmdName);
        if (skill && skill.userInvocable) {
          printInfo(`Invoking skill: ${skill.name}`);
          try {
            if (skill.context === "fork") {
              // fork 技能不直接在 CLI 里展开，而是交回 agent 的 `skill` 工具处理，
              // 这样它内部才能走统一的子代理逻辑。
              const forkResult = executeSkill(skill.name, cmdArgs);
              if (forkResult) {
                await agent.chat(`Use the skill tool to invoke "${skill.name}" with args: ${cmdArgs || "(none)"}`);
              }
            } else {
              // inline 技能直接把 prompt 模板展开后送给当前主代理。
              const resolved = resolveSkillPrompt(skill, cmdArgs);
              await agent.chat(resolved);
            }
          } catch (e: any) {
            // 用户主动中断不再重复报错，其余错误统一打印。
            if (e.name !== "AbortError" && !e.message?.includes("aborted")) {
              printError(e.message);
            }
          }
          askQuestion();
          return;
        }
        // 如果 `/xxx` 不是已知命令或技能，就把它当普通自然语言输入。
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

### 步骤 2：确认和参考仓库零差异

```bash
diff -u "$REFERENCE_REPO/src/cli.ts" "$TARGET_REPO/src/cli.ts"
```

### 步骤 3：重新编译

```bash
cd "$TARGET_REPO"
npm run build
```

### 步骤 4：测试完整 CLI 内建命令

```bash
cd "$TARGET_REPO"
node dist/cli.js --help

printf "/memory\n/skills\n/clear\n/cost\n/plan\nexit\n" | env ANTHROPIC_API_KEY=dummy node dist/cli.js
```

## 现在你应该看到什么

1. `diff -u` 没有输出。
2. `npm run build` 可以通过。
3. 第二条命令进入 REPL 后，会依次执行 `/memory`、`/skills`、`/clear`、`/cost`、`/plan`，最后读到 `exit` 退出。
4. 因为这些命令都在真正发起模型请求之前被拦截，所以即使只给了一个 dummy API key，也能完成这组测试。

## 本小节的“手把手测试流程”

1. 先执行“步骤 1”覆盖最终版 `src/cli.ts`。
2. 再执行“步骤 2”的 `diff -u`。
3. 然后执行“步骤 3”的 `npm run build`。
4. 最后执行“步骤 4”的两条命令，确认完整帮助页和 REPL 内建命令都已可用。
