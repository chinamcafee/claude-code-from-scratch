# 第 8-2 节：补上 Git 上下文采集

这一小节仍然不是最终版 `src/prompt.ts`。

你会在上一节基础上继续扩展：让这个模块不仅会读 `CLAUDE.md` 和 rules，还能把当前 Git 分支、最近提交和工作区状态整理成一段文本。

## 本小节目标

1. 导出 `getGitContext()`。
2. 能采集当前 Git 分支、最近 5 条提交和 `git status --short`。
3. 继续保留上一节的 `loadClaudeMd()` 能力。
4. 成功编译当前工程。

## 这份阶段版源码来自哪里

这一小节的阶段版 `src/prompt.ts` 完全由参考文件中的这段原始源码组成：

- 第 1-138 行

## 手把手实操

### 步骤 1：用第二阶段版本覆盖 `src/prompt.ts`

把上一节的阶段版 `src/prompt.ts` 整个替换成下面这份第二阶段代码。

#### 当前阶段版 `src/prompt.ts` 完整代码

````ts
import { readFileSync, existsSync, readdirSync } from "fs";
import { join, resolve, dirname } from "path";
import { execSync } from "child_process";
import * as os from "os";
import { buildMemoryPromptSection } from "./memory.js";
import { buildSkillDescriptions } from "./skills.js";
import { buildAgentDescriptions } from "./subagent.js";
import { getDeferredToolNames } from "./tools.js";

// 这个模块负责组装发给模型的 system prompt。
// 它会把运行环境、Git 状态、CLAUDE.md、memory/skills/agents 信息
// 一起拼进一个长模板里，形成每轮调用共享的基础上下文。

// ─── `@include` 指令展开 ────────────────────────────────────
// CLAUDE.md / rule 文件里允许写独占一行的 `@./path`、`@~/path`、`@/path`。
// 这里会递归把这类引用替换成目标文件内容，效果类似“包含另一个片段”。

const INCLUDE_REGEX = /^@(\.\/[^\s]+|~\/[^\s]+|\/[^\s]+)$/gm;
const MAX_INCLUDE_DEPTH = 5;

function resolveIncludes(
  content: string,
  basePath: string,
  visited: Set<string> = new Set(),
  depth: number = 0
): string {
  // 限制递归深度，避免 include 链过深导致爆炸式展开。
  if (depth >= MAX_INCLUDE_DEPTH) return content;
  return content.replace(INCLUDE_REGEX, (_match, rawPath: string) => {
    // 先把三种写法统一解析成绝对路径。
    let resolved: string;
    if (rawPath.startsWith("~/")) {
      resolved = join(os.homedir(), rawPath.slice(2));
    } else if (rawPath.startsWith("/")) {
      resolved = rawPath;
    } else {
      // 相对路径相对于当前被解析文件所在目录展开。
      resolved = resolve(basePath, rawPath);
    }
    // 再走一次 `resolve` 统一规范化路径，便于循环引用检测。
    resolved = resolve(resolved);
    // 遇到已经访问过的文件，插入 HTML 注释占位，提醒调用方出现循环引用。
    if (visited.has(resolved)) return `<!-- circular: ${rawPath} -->`;
    // include 的目标文件不存在时也用注释保留痕迹，而不是直接抛错。
    if (!existsSync(resolved)) return `<!-- not found: ${rawPath} -->`;
    try {
      visited.add(resolved);
      const included = readFileSync(resolved, "utf-8");
      // 递归展开被包含文件内部可能继续出现的 `@include`。
      return resolveIncludes(included, dirname(resolved), visited, depth + 1);
    } catch {
      // 读取失败时同样保留错误标记，方便排查具体是哪条 include 有问题。
      return `<!-- error reading: ${rawPath} -->`;
    }
  });
}

// ─── 自动加载 `.claude/rules/*.md` ──────────────────────────

function loadRulesDir(dir: string): string {
  const rulesDir = join(dir, ".claude", "rules");
  // 没有 rules 目录时返回空串，上层直接跳过拼接。
  if (!existsSync(rulesDir)) return "";
  try {
    const files = readdirSync(rulesDir)
      .filter((f) => f.endsWith(".md"))
      .sort();
    // 排序后输出稳定，便于调试和测试。
    if (files.length === 0) return "";
    const parts: string[] = [];
    for (const file of files) {
      try {
        let content = readFileSync(join(rulesDir, file), "utf-8");
        // rule 文件同样支持 include 指令。
        content = resolveIncludes(content, rulesDir);
        // 用 HTML 注释保留来源文件名，方便定位这段规则来自哪里。
        parts.push(`<!-- rule: ${file} -->\n${content}`);
      } catch {
        // 单个规则文件损坏不影响其它规则注入。
      }
    }
    // 只有至少成功读到一个规则文件时才返回 `## Rules` 小节。
    return parts.length > 0 ? "\n\n## Rules\n" + parts.join("\n\n") : "";
  } catch {
    return "";
  }
}

// ─── 递归加载各级目录的 `CLAUDE.md` ─────────────────────────

export function loadClaudeMd(): string {
  const parts: string[] = [];
  let dir = process.cwd();
  while (true) {
    const file = join(dir, "CLAUDE.md");
    if (existsSync(file)) {
      try {
        let content = readFileSync(file, "utf-8");
        // 每个 CLAUDE.md 自己的 include 基准路径是其所在目录。
        content = resolveIncludes(content, dir);
        // 由于是从当前目录一路向上找，所以要 `unshift`，让上层规则排前面。
        parts.unshift(content);
      } catch {
        // 某一层的 CLAUDE.md 读失败时忽略，不影响其它层级。
      }
    }
    const parent = resolve(dir, "..");
    // 到达文件系统根目录时停止。
    if (parent === dir) break;
    dir = parent;
  }
  // rule 目录只读取当前项目 cwd 下的 `.claude/rules`。
  const rules = loadRulesDir(process.cwd());
  const claudeMd = parts.length > 0
    ? "\n\n# Project Instructions (CLAUDE.md)\n" + parts.join("\n\n---\n\n")
    : "";
  return claudeMd + rules;
}

// ─── Git 上下文收集 ──────────────────────────────────────────

export function getGitContext(): string {
  try {
    // 所有 git 命令都走短超时，避免在坏仓库状态里卡太久。
    const opts = { encoding: "utf-8" as const, timeout: 3000, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"] };
    const branch = execSync("git rev-parse --abbrev-ref HEAD", opts).trim();
    const log = execSync("git log --oneline -5", opts).trim();
    const status = execSync("git status --short", opts).trim();
    let result = `\nGit branch: ${branch}`;
    // 有内容时才追加对应小节，避免 system prompt 塞一堆空标题。
    if (log) result += `\nRecent commits:\n${log}`;
    if (status) result += `\nGit status:\n${status}`;
    return result;
  } catch {
    // 非 git 仓库或 git 调用失败时，系统提示词里就不注入 git 信息。
    return "";
  }
}
````

### 步骤 2：先编译

```bash
cd "$TARGET_REPO"
npm run build
```

### 步骤 3：测试 `loadClaudeMd()` 和 `getGitContext()`

```bash
cd "$TARGET_REPO"
node --input-type=module <<'EOF'
import { loadClaudeMd, getGitContext } from "./dist/prompt.js";
console.log(loadClaudeMd());
console.log("--- git ---");
console.log(getGitContext());
EOF
```

## 现在你应该看到什么

1. `npm run build` 可以通过。
2. `loadClaudeMd()` 的输出仍然包含上一节准备的 `CLAUDE.md` 和 rules 内容。
3. `getGitContext()` 的输出里通常会至少出现 `Git branch:`。
4. 如果当前仓库有提交记录，你还会看到 `Recent commits:` 和可能的 `Git status:`。

## 本小节的“手把手测试流程”

1. 先执行“步骤 1”，把 `src/prompt.ts` 升级到第二阶段。
2. 再执行“步骤 2”的 `npm run build`。
3. 最后执行“步骤 3”的脚本，确认 `CLAUDE.md` 加载和 Git 上下文采集都已可用。
