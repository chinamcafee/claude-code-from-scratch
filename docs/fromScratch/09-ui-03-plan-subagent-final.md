# 第 9-3 节：补上计划审批和子代理提示，收口到最终版 `ui.ts`

这一小节会把 `src/ui.ts` 收口到最终版。

你会在上一节基础上补上 plan mode 审批展示和子代理起止提示。做完以后，这个文件就和参考仓库完全一致。

## 本小节目标

1. 导出 `printPlanForApproval()`、`printPlanApprovalOptions()`、`printSubAgentStart()`、`printSubAgentEnd()`。
2. 可以用 `diff` 确认当前 `src/ui.ts` 与参考仓库零差异。
3. 成功编译当前工程。
4. 可以完整演示终端输出层的所有主要函数。

## 这份阶段版源码来自哪里

这一小节直接使用参考仓库最终版 `src/ui.ts`：

- 第 1-235 行

## 手把手实操

### 步骤 1：用最终版覆盖 `src/ui.ts`

把 `$TARGET_REPO/src/ui.ts` 整个替换成下面这份最终代码。

#### 最终版 `src/ui.ts` 完整代码

````ts
import chalk from "chalk";

export function printWelcome() {
  // 欢迎信息只在 REPL 启动时打印一次，用于提示基本交互方式。
  console.log(
    chalk.bold.cyan("\n  Mini Claude Code") +
      chalk.gray(" — A minimal coding agent\n")
  );
  console.log(chalk.gray("  Type your request, or 'exit' to quit."));
  console.log(chalk.gray("  Commands: /clear /plan /cost /compact /memory /skills\n"));
}

export function printUserPrompt() {
  // 只写提示符，不换行，让 readline 在同一行接用户输入。
  process.stdout.write(chalk.bold.green("\n> "));
}

export function printAssistantText(text: string) {
  // 模型的流式文本要原样输出，不能额外包裹 console.log，否则会插入多余换行。
  process.stdout.write(text);
}

export function printToolCall(name: string, input: Record<string, any>) {
  // 工具调用会先显示“图标 + 工具名 + 摘要”，帮助用户快速扫一眼发生了什么。
  const icon = getToolIcon(name);
  const summary = getToolSummary(name, input);
  console.log(chalk.yellow(`\n  ${icon} ${name}`) + chalk.gray(` ${summary}`));
}

export function printToolResult(name: string, result: string) {
  // 文件改动结果会额外高亮 diff，方便用户直接看增删行。
  if ((name === "edit_file" || name === "write_file") && !result.startsWith("Error")) {
    printFileChangeResult(name, result);
    return;
  }
  // 普通工具结果统一做长度截断，避免终端被超长输出刷爆。
  const maxLen = 500;
  const truncated =
    result.length > maxLen
      ? result.slice(0, maxLen) + chalk.gray(`\n  ... (${result.length} chars total)`)
      : result;
  const lines = truncated.split("\n").map((l) => "  " + l);
  console.log(chalk.dim(lines.join("\n")));
}

function printFileChangeResult(name: string, result: string) {
  const lines = result.split("\n");
  // 第一行是“成功写入/编辑”的摘要信息。
  console.log(chalk.dim("  " + lines[0]));

  // 后续内容是文件预览或 diff，显示时做行数上限控制。
  const maxDisplayLines = 40;
  const contentLines = lines.slice(1);
  const displayLines = contentLines.slice(0, maxDisplayLines);

  for (const line of displayLines) {
    // 空白行不打印，减少视觉噪音。
    if (!line.trim()) continue;
    if (line.startsWith("@@")) {
      // `@@` 是 unified diff 的块头，单独染成青色。
      console.log(chalk.cyan("  " + line));
    } else if (line.startsWith("- ")) {
      // 删除行用红色。
      console.log(chalk.red("  " + line));
    } else if (line.startsWith("+ ")) {
      // 新增行用绿色。
      console.log(chalk.green("  " + line));
    } else {
      // 其余行一般是文件预览或上下文。
      console.log(chalk.dim("  " + line));
    }
  }
  // 超出部分只提示还有多少行，避免刷屏。
  if (contentLines.length > maxDisplayLines) {
    console.log(chalk.gray(`  ... (${contentLines.length - maxDisplayLines} more lines)`));
  }
}

export function printError(msg: string) {
  // 错误统一走 stderr，便于外部脚本区分正常输出与异常输出。
  console.error(chalk.red(`\n  Error: ${msg}`));
}

export function printConfirmation(command: string): void {
  // 危险命令确认提示会单独高亮出来。
  console.log(
    chalk.yellow("\n  ⚠ Dangerous command: ") + chalk.white(command)
  );
}

export function printDivider() {
  // 每轮主对话结束后打一条分隔线，帮助区分轮次。
  console.log(chalk.gray("\n  " + "─".repeat(50)));
}

export function printCost(inputTokens: number, outputTokens: number) {
  // 这里直接用固定单价粗估成本，方便快速感知，而不是追求计费绝对精确。
  const costIn = (inputTokens / 1_000_000) * 3;
  const costOut = (outputTokens / 1_000_000) * 15;
  const total = costIn + costOut;
  console.log(
    chalk.gray(
      `\n  Tokens: ${inputTokens} in / ${outputTokens} out (~$${total.toFixed(4)})`
    )
  );
}

export function printRetry(attempt: number, max: number, reason: string) {
  // 网络/API 重试时打印当前是第几次以及触发原因。
  console.log(
    chalk.yellow(`\n  ↻ Retry ${attempt}/${max}: ${reason}`)
  );
}

export function printInfo(msg: string) {
  // 信息提示和错误/正文区分开，统一使用 cyan。
  console.log(chalk.cyan(`\n  ℹ ${msg}`));
}

// ─── API 调用中的转圈动画 ──────────────────────────────────

// 终端转圈动画使用一组 braille 字符帧。
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// 用模块级变量保存 spinner 状态，这样任何调用方都能复用同一个动画。
let spinnerTimer: ReturnType<typeof setInterval> | null = null;
let spinnerFrame = 0;

export function startSpinner(label = "Thinking") {
  // 已经有 spinner 在跑时，不要重复启动第二个。
  if (spinnerTimer) return;
  spinnerFrame = 0;
  process.stdout.write(chalk.gray(`\n  ${SPINNER_FRAMES[0]} ${label}...`));
  spinnerTimer = setInterval(() => {
    spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
    // 使用回车符回到行首并重写这一行，形成动画效果。
    process.stdout.write(`\r${chalk.gray(`  ${SPINNER_FRAMES[spinnerFrame]} ${label}...`)}`);
  }, 80);
}

export function stopSpinner() {
  if (spinnerTimer) {
    clearInterval(spinnerTimer);
    spinnerTimer = null;
    // `\x1b[K` 会清掉当前行从光标到结尾的内容。
    process.stdout.write("\r\x1b[K");
  }
}

// ─── 计划审批阶段的终端展示 ─────────────────────────────────

export function printPlanForApproval(planContent: string) {
  // 批准计划前，先把 plan 文件主体打印给用户看。
  console.log(chalk.cyan("\n  ━━━ Plan for Approval ━━━"));
  const lines = planContent.split("\n");
  const maxLines = 60;
  const display = lines.slice(0, maxLines);
  for (const line of display) {
    console.log(chalk.white("  " + line));
  }
  // 计划太长时只显示前 60 行，剩余内容给出计数提示。
  if (lines.length > maxLines) {
    console.log(chalk.gray(`  ... (${lines.length - maxLines} more lines)`));
  }
  console.log(chalk.cyan("  ━━━━━━━━━━━━━━━━━━━━━━━━\n"));
}

export function printPlanApprovalOptions() {
  // 四种选项分别对应不同的上下文清理/权限模式。
  console.log(chalk.yellow("  Choose an option:"));
  console.log(chalk.white("    1) Yes, clear context and execute") + chalk.gray(" — fresh start with auto-accept edits"));
  console.log(chalk.white("    2) Yes, and execute") + chalk.gray(" — keep context, auto-accept edits"));
  console.log(chalk.white("    3) Yes, manually approve edits") + chalk.gray(" — keep context, confirm each edit"));
  console.log(chalk.white("    4) No, keep planning") + chalk.gray(" — provide feedback to revise"));
}

// ─── 子代理起止提示 ─────────────────────────────────────────

export function printSubAgentStart(type: string, description: string) {
  // 子代理开始执行时，在主终端打一条明显的“分支任务开始”提示。
  console.log(
    chalk.magenta(`\n  ┌─ Sub-agent [${type}]: ${description}`)
  );
}

export function printSubAgentEnd(type: string, description: string) {
  // 结束时闭合对应提示，便于视觉上成对出现。
  console.log(
    chalk.magenta(`  └─ Sub-agent [${type}] completed`)
  );
}

// ─── 工具图标与摘要生成 ─────────────────────────────────────

function getToolIcon(name: string): string {
  // 不同工具对应不同图标，让终端输出更易扫读。
  const icons: Record<string, string> = {
    read_file: "📖",
    write_file: "✏️",
    edit_file: "🔧",
    list_files: "📁",
    grep_search: "🔍",
    run_shell: "💻",
    skill: "⚡",
    agent: "🤖",
  };
  return icons[name] || "🔨";
}

function getToolSummary(name: string, input: Record<string, any>): string {
  // 摘要尽量只保留最有辨识度的信息，比如文件路径、pattern、命令前缀。
  switch (name) {
    case "read_file":
      return input.file_path;
    case "write_file":
      return input.file_path;
    case "edit_file":
      return input.file_path;
    case "list_files":
      return input.pattern;
    case "grep_search":
      return `"${input.pattern}" in ${input.path || "."}`;
    case "run_shell":
      // shell 命令可能很长，所以这里只展示前 60 个字符。
      return input.command.length > 60
        ? input.command.slice(0, 60) + "..."
        : input.command;
    case "skill":
      return input.skill_name;
    case "agent":
      return `[${input.type || "general"}] ${input.description || ""}`;
    default:
      return "";
  }
}
````

### 步骤 2：确认和参考仓库零差异

```bash
diff -u "$REFERENCE_REPO/src/ui.ts" "$TARGET_REPO/src/ui.ts"
```

### 步骤 3：重新编译

```bash
cd "$TARGET_REPO"
npm run build
```

### 步骤 4：完整测试终端输出层

```bash
cd "$TARGET_REPO"
node --input-type=module <<'EOF'
import { printPlanForApproval, printPlanApprovalOptions, printSubAgentStart, printSubAgentEnd, printDivider } from "./dist/ui.js";

printPlanForApproval([
  "# Demo Plan",
  "",
  "1. Read files",
  "2. Edit code",
  "3. Run tests",
].join("\n"));
printPlanApprovalOptions();
printSubAgentStart("explore", "scan the repo for api routes");
printSubAgentEnd("explore", "scan the repo for api routes");
printDivider();
EOF
```

## 现在你应该看到什么

1. `diff -u` 没有输出。
2. `npm run build` 可以通过。
3. 终端会打印一个带边框标题的计划审批预览。
4. 紧接着你会看到 4 条审批选项，以及一对子代理开始 / 结束提示。

## 本小节的“手把手测试流程”

1. 先执行“步骤 1”覆盖最终版 `src/ui.ts`。
2. 再执行“步骤 2”的 `diff -u`。
3. 然后执行“步骤 3”的 `npm run build`。
4. 最后执行“步骤 4”的脚本，确认计划审批和子代理提示都已经接好。
