# 第 6-3 节：补齐权限系统，完成最终版 `src/tools.ts`

这一小节会把 `src/tools.ts` 从“可执行阶段版”升级到最终版。

本小节新增的核心能力只有一类：权限和安全。

包括：

1. 危险命令检测。
2. 用户级 / 项目级 allow / deny 规则。
3. `checkPermission()` 和 `needsConfirmation()`。
4. Plan Mode 的只读约束。

## 本小节目标

本小节结束后，你应该拿到和参考仓库完全一致的 `src/tools.ts`。

## 这一步的源码基准

这一小节直接使用参考仓库的最终版完整文件：

- `$REFERENCE_REPO/src/tools.ts`（925 行）

## 手把手实操

### 步骤 1：用最终版覆盖 `src/tools.ts`

把 `$TARGET_REPO/src/tools.ts` 整个替换成下面这份最终代码。

#### 最终版 `src/tools.ts` 完整代码

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

// ─── 具体工具执行实现 ────────────────────────────────────────

function readFile(input: { file_path: string }): string {
  try {
    const content = readFileSync(input.file_path, "utf-8");
    const lines = content.split("\n");
    // 带行号返回，后续模型做修改时能更稳地描述定位。
    const numbered = lines
      .map((line, i) => `${String(i + 1).padStart(4)} | ${line}`)
      .join("\n");
    return numbered;
  } catch (e: any) {
    return `Error reading file: ${e.message}`;
  }
}

function writeFile(input: { file_path: string; content: string }): string {
  try {
    const dir = dirname(input.file_path);
    // 父目录不存在时自动创建，降低创建新文件的摩擦。
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(input.file_path, input.content);
    // 如果刚好写到了 memory 目录，就顺手更新 MEMORY.md 索引。
    autoUpdateMemoryIndex(input.file_path);
    // 返回一个带前 30 行预览的结果，方便终端直接展示。
    const lines = input.content.split("\n");
    const lineCount = lines.length;
    const preview = lines.slice(0, 30).map((l, i) =>
      `${String(i + 1).padStart(4)} | ${l}`
    ).join("\n");
    const truncNote = lineCount > 30 ? `\n  ... (${lineCount} lines total)` : "";
    return `Successfully wrote to ${input.file_path} (${lineCount} lines)\n\n${preview}${truncNote}`;
  } catch (e: any) {
    return `Error writing file: ${e.message}`;
  }
}

function autoUpdateMemoryIndex(filePath: string): void {
  try {
    const memDir = getMemoryDir();
    if (filePath.startsWith(memDir) && filePath.endsWith(".md") && !filePath.endsWith("MEMORY.md")) {
      // 这里只是为了写索引，直接用最简单的 fs 逻辑重扫整个 memory 目录。
      const { readdirSync } = require("fs");
      const files = readdirSync(memDir).filter(
        (f: string) => f.endsWith(".md") && f !== "MEMORY.md"
      );
      const lines = ["# Memory Index", ""];
      for (const file of files) {
        try {
          const raw = readFileSync(join(memDir, file), "utf-8");
          // 这里用正则直接从 frontmatter 提取字段，而不是完整 YAML 解析，够快也够用。
          const nameMatch = raw.match(/^name:\s*(.+)$/m);
          const typeMatch = raw.match(/^type:\s*(.+)$/m);
          const descMatch = raw.match(/^description:\s*(.+)$/m);
          if (nameMatch && typeMatch) {
            lines.push(`- **[${nameMatch[1].trim()}](${file})** (${typeMatch[1].trim()}) — ${descMatch?.[1]?.trim() || ""}`);
          }
        } catch {
          // 单个记忆文件损坏时跳过即可。
        }
      }
      writeFileSync(join(memDir, "MEMORY.md"), lines.join("\n"));
    }
  } catch {
    // 记忆索引更新失败不应该让正常写文件失败。
  }
}

// ─── 编辑辅助：引号归一化与 diff 生成 ───────────────────────

function normalizeQuotes(s: string): string {
  return s
    // 把花引号、prime 等字符都折叠成 ASCII 单引号。
    .replace(/[\u2018\u2019\u2032]/g, "'")
    // 同理处理双引号。
    .replace(/[\u201C\u201D\u2033]/g, '"');
}

function findActualString(fileContent: string, searchString: string): string | null {
  // 优先做最严格、成本最低的直接匹配。
  if (fileContent.includes(searchString)) return searchString;
  // 再尝试“只差花引号/直引号”的宽松匹配，提升编辑成功率。
  const normSearch = normalizeQuotes(searchString);
  const normFile = normalizeQuotes(fileContent);
  const idx = normFile.indexOf(normSearch);
  // 命中后返回原文件里的真实子串，保证替换时不破坏原字符集。
  if (idx !== -1) return fileContent.substring(idx, idx + searchString.length);
  return null;
}

function generateDiff(
  oldContent: string, _newContent: string,
  oldString: string, newString: string
): string {
  // 通过“变化前文本中出现 oldString 之前的换行数”估算 diff 起始行号。
  const beforeChange = oldContent.split(oldString)[0];
  const lineNum = (beforeChange.match(/\n/g) || []).length + 1;
  const oldLines = oldString.split("\n");
  const newLines = newString.split("\n");

  const parts: string[] = [`@@ -${lineNum},${oldLines.length} +${lineNum},${newLines.length} @@`];
  // 先列出旧内容，再列出新内容，方便 UI 高亮。
  for (const l of oldLines) parts.push(`- ${l}`);
  for (const l of newLines) parts.push(`+ ${l}`);

  return parts.join("\n");
}

function editFile(input: {
  file_path: string;
  old_string: string;
  new_string: string;
}): string {
  try {
    const content = readFileSync(input.file_path, "utf-8");

    // 查找要替换的片段，支持“花引号差异”的容错。
    const actual = findActualString(content, input.old_string);
    if (!actual) {
      return `Error: old_string not found in ${input.file_path}`;
    }

    // 精确替换要求 old_string 只出现一次，避免误改多个位置。
    const count = content.split(actual).length - 1;
    if (count > 1)
      return `Error: old_string found ${count} times in ${input.file_path}. Must be unique.`;

    // 用 split/join 而不是 replace，避免 `$1` 这类特殊替换符干扰。
    const newContent = content.split(actual).join(input.new_string);
    writeFileSync(input.file_path, newContent);

    // 返回简化 diff，供 UI 直接展示增删内容。
    const diff = generateDiff(content, newContent, actual, input.new_string);
    const quoteNote = actual !== input.old_string ? " (matched via quote normalization)" : "";
    return `Successfully edited ${input.file_path}${quoteNote}\n\n${diff}`;
  } catch (e: any) {
    return `Error editing file: ${e.message}`;
  }
}

async function listFiles(input: {
  pattern: string;
  path?: string;
}): Promise<string> {
  try {
    // `glob` 天然支持 `**/*.ts` 这类模式，适合给模型找文件。
    const files = await glob(input.pattern, {
      cwd: input.path || process.cwd(),
      nodir: true,
      // 默认跳过 node_modules 和 .git，减少噪音。
      ignore: ["node_modules/**", ".git/**"],
    });
    if (files.length === 0) return "No files found matching the pattern.";
    // 返回数量上限，避免一次性把超多文件全塞进上下文。
    return files.slice(0, 200).join("\n") +
      (files.length > 200 ? `\n... and ${files.length - 200} more` : "");
  } catch (e: any) {
    return `Error listing files: ${e.message}`;
  }
}

function grepSearch(input: {
  pattern: string;
  path?: string;
  include?: string;
}): string {
  // 优先走系统 `grep`，性能和兼容性通常都优于纯 JS 遍历。
  if (!isWin) {
    try {
      const args = ["--line-number", "--color=never", "-r"];
      if (input.include) args.push(`--include=${input.include}`);
      args.push("--", input.pattern);
      args.push(input.path || ".");
      const result = execFileSync("grep", args, {
        encoding: "utf-8",
        maxBuffer: 1024 * 1024,
        timeout: 10000,
      });
      const lines = result.split("\n").filter(Boolean);
      // 同样做上限控制，防止一次 grep 产生海量命中。
      return lines.slice(0, 100).join("\n") +
        (lines.length > 100 ? `\n... and ${lines.length - 100} more matches` : "");
    } catch (e: any) {
      // `grep` 返回码 1 代表“没找到”，不算异常。
      if (e.status === 1) return "No matches found.";
      return `Error: ${e.message}`;
    }
  }
  // Windows 环境回退到纯 JS 遍历实现。
  return grepJS(input.pattern, input.path || ".", input.include);
}

function grepJS(pattern: string, dir: string, include?: string): string {
  // 这里用原生 RegExp；如果 pattern 非法会直接抛出，让上层返回错误信息。
  const re = new RegExp(pattern);
  // include 是 glob 风格，这里做一个简单转换成正则。
  const includeRe = include ? new RegExp(include.replace(/\*/g, ".*").replace(/\?/g, ".")) : null;
  const matches: string[] = [];
  function walk(d: string) {
    // 结果达到上限后尽早停止递归。
    if (matches.length >= 200) return;
    let entries: string[];
    try { entries = readdirSync(d); } catch { return; }
    for (const name of entries) {
      // 默认跳过隐藏目录和 node_modules。
      if (name.startsWith(".") || name === "node_modules") continue;
      const full = join(d, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) { walk(full); continue; }
      if (includeRe && !includeRe.test(name)) continue;
      try {
        const text = readFileSync(full, "utf-8");
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          // 命中时返回 `路径:行号:内容`，与 grep 命令行输出保持相似。
          if (re.test(lines[i])) {
            matches.push(`${full}:${i + 1}:${lines[i]}`);
            if (matches.length >= 200) return;
          }
        }
      } catch {}
    }
  }
  walk(dir);
  if (matches.length === 0) return "No matches found.";
  const shown = matches.slice(0, 100);
  return shown.join("\n") +
    (matches.length > 100 ? `\n... and ${matches.length - 100} more matches` : "");
}

function runShell(input: { command: string; timeout?: number }): string {
  try {
    // shell 工具保留给测试、git、包管理等确实需要 shell 的场景。
    const result = execSync(input.command, {
      encoding: "utf-8",
      maxBuffer: 5 * 1024 * 1024,
      // 默认 30 秒，既够跑大多数命令，也不会卡死太久。
      timeout: input.timeout || 30000,
      stdio: ["pipe", "pipe", "pipe"],
      // Windows 默认用 powershell，其它平台走 `/bin/sh`。
      shell: isWin ? "powershell.exe" : "/bin/sh",
    });
    return result || "(no output)";
  } catch (e: any) {
    // 出错时把 stdout/stderr 都带回去，便于模型定位失败原因。
    const stderr = e.stderr ? `\nStderr: ${e.stderr}` : "";
    const stdout = e.stdout ? `\nStdout: ${e.stdout}` : "";
    return `Command failed (exit code ${e.status})${stdout}${stderr}`;
  }
}

// ─── 危险 shell 命令模式 ────────────────────────────────────

const DANGEROUS_PATTERNS = [
  // Unix / git 常见高风险命令。
  /\brm\s/,
  /\bgit\s+(push|reset|clean|checkout\s+\.)/,
  /\bsudo\b/,
  /\bmkfs\b/,
  /\bdd\s/,
  />\s*\/dev\//,
  /\bkill\b/,
  /\bpkill\b/,
  /\breboot\b/,
  /\bshutdown\b/,
  // Windows 等价高风险命令。
  /\bdel\s/i,
  /\brmdir\s/i,
  /\bformat\s/i,
  /\btaskkill\s/i,
  /\bRemove-Item\s/i,
  /\bStop-Process\s/i,
];

export function isDangerous(command: string): boolean {
  // 只要命中任一模式，就要求上层做确认。
  return DANGEROUS_PATTERNS.some((p) => p.test(command));
}

// ─── 权限规则：从配置文件加载 allow/deny ─────────────────────

interface ParsedRule {
  // 工具名，例如 `run_shell` / `write_file`。
  tool: string;
  // 可选的值匹配规则，例如路径前缀或完整命令。
  pattern: string | null;
}

interface PermissionRules {
  // 命中 allow 后可直接放行。
  allow: ParsedRule[];
  // 命中 deny 后直接拒绝，优先级高于 allow。
  deny: ParsedRule[];
}

let cachedRules: PermissionRules | null = null;

function parseRule(rule: string): ParsedRule {
  // 支持两种格式：
  // 1. `run_shell`
  // 2. `write_file(src/*)`
  const match = rule.match(/^([a-z_]+)\((.+)\)$/);
  if (match) {
    return { tool: match[1], pattern: match[2] };
  }
  return { tool: rule, pattern: null };
}

function loadSettings(filePath: string): any {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

export function loadPermissionRules(): PermissionRules {
  // 规则做缓存，避免每次工具调用都重复读磁盘。
  if (cachedRules) return cachedRules;

  const allow: ParsedRule[] = [];
  const deny: ParsedRule[] = [];

  // 先读用户级，再读项目级；二者都会累积到同一个规则集。
  const userSettings = loadSettings(join(homedir(), ".claude", "settings.json"));
  const projectSettings = loadSettings(join(process.cwd(), ".claude", "settings.json"));

  for (const settings of [userSettings, projectSettings]) {
    if (!settings?.permissions) continue;
    if (Array.isArray(settings.permissions.allow)) {
      for (const r of settings.permissions.allow) allow.push(parseRule(r));
    }
    if (Array.isArray(settings.permissions.deny)) {
      for (const r of settings.permissions.deny) deny.push(parseRule(r));
    }
  }

  cachedRules = { allow, deny };
  return cachedRules;
}

function matchesRule(rule: ParsedRule, toolName: string, input: Record<string, any>): boolean {
  // 工具名对不上时直接失败。
  if (rule.tool !== toolName) return false;
  // 没写 pattern 就表示这个工具的所有调用都命中。
  if (!rule.pattern) return true;

  // 根据工具类型挑选最关键的输入字段做匹配。
  let value = "";
  if (toolName === "run_shell") value = input.command || "";
  else if (input.file_path) value = input.file_path;
  else return true;

  const pattern = rule.pattern;
  // 末尾 `*` 表示“前缀匹配”，适合路径白名单。
  if (pattern.endsWith("*")) {
    return value.startsWith(pattern.slice(0, -1));
  }
  // 否则就是严格全等。
  return value === pattern;
}

function checkPermissionRules(
  toolName: string,
  input: Record<string, any>
): "allow" | "deny" | null {
  const rules = loadPermissionRules();

  // deny 优先级最高，先检查。
  for (const rule of rules.deny) {
    if (matchesRule(rule, toolName, input)) return "deny";
  }
  // deny 都没命中时，再检查 allow。
  for (const rule of rules.allow) {
    if (matchesRule(rule, toolName, input)) return "allow";
  }
  // 没规则命中时回落到内建策略。
  return null;
}

// ─── 统一权限检查入口 ────────────────────────────────────────
// 返回值三态：
// - allow: 直接执行
// - deny: 直接阻止
// - confirm: 需要用户确认

export function checkPermission(
  toolName: string,
  input: Record<string, any>,
  mode: PermissionMode = "default",
  planFilePath?: string
): { action: "allow" | "deny" | "confirm"; message?: string } {
  // `--yolo` / bypass 模式下无条件放行。
  if (mode === "bypassPermissions") return { action: "allow" };

  // 第一步：配置文件规则优先。
  const ruleResult = checkPermissionRules(toolName, input);
  if (ruleResult === "deny") {
    return { action: "deny", message: `Denied by permission rule for ${toolName}` };
  }
  if (ruleResult === "allow") {
    return { action: "allow" };
  }

  // 第二步：读工具在任何模式下都自动放行。
  if (READ_TOOLS.has(toolName)) return { action: "allow" };

  // plan 模式下：
  // 1. 只允许读工具
  // 2. 唯一可写文件是 plan 文件本身
  // 3. shell 一律禁用
  if (mode === "plan") {
    if (EDIT_TOOLS.has(toolName)) {
      const filePath = input.file_path || input.path;
      if (planFilePath && filePath === planFilePath) {
        return { action: "allow" };
      }
      return { action: "deny", message: `Blocked in plan mode: ${toolName}` };
    }
    if (toolName === "run_shell") {
      return { action: "deny", message: "Shell commands blocked in plan mode" };
    }
  }

  // 进入/退出 plan 模式本身必须允许，否则模型永远无法切换模式。
  if (toolName === "enter_plan_mode" || toolName === "exit_plan_mode") {
    return { action: "allow" };
  }

  // `acceptEdits` 自动批准文件编辑，但危险 shell 仍需确认。
  if (mode === "acceptEdits" && EDIT_TOOLS.has(toolName)) {
    return { action: "allow" };
  }

  // 第三步：内建危险模式检测。
  let needsConfirm = false;
  let confirmMessage = "";

  if (toolName === "run_shell" && isDangerous(input.command)) {
    needsConfirm = true;
    confirmMessage = input.command;
  } else if (toolName === "write_file" && !existsSync(input.file_path)) {
    // 创建新文件相对不可逆，默认要求确认。
    needsConfirm = true;
    confirmMessage = `write new file: ${input.file_path}`;
  } else if (toolName === "edit_file" && !existsSync(input.file_path)) {
    // 编辑不存在文件通常意味着模型路径判断错了，也要求确认。
    needsConfirm = true;
    confirmMessage = `edit non-existent file: ${input.file_path}`;
  }

  if (needsConfirm) {
    // `dontAsk` 常用于 CI，凡是本来需要确认的操作一律自动拒绝。
    if (mode === "dontAsk") {
      return { action: "deny", message: `Auto-denied (dontAsk mode): ${confirmMessage}` };
    }
    return { action: "confirm", message: confirmMessage };
  }

  return { action: "allow" };
}

// 老接口兼容层：旧代码如果还在调用 `needsConfirmation` 也能正常工作。
export function needsConfirmation(
  toolName: string,
  input: Record<string, any>
): string | null {
  const result = checkPermission(toolName, input);
  if (result.action === "confirm") return result.message || null;
  return null;
}

// ─── 长工具输出截断 ─────────────────────────────────────────

const MAX_RESULT_CHARS = 50000;

function truncateResult(result: string): string {
  // 超长输出保留头尾，中间放占位，兼顾上下文与长度控制。
  if (result.length <= MAX_RESULT_CHARS) return result;
  const keepEach = Math.floor((MAX_RESULT_CHARS - 60) / 2);
  return (
    result.slice(0, keepEach) +
    "\n\n[... truncated " +
    (result.length - keepEach * 2) +
    " chars ...]\n\n" +
    result.slice(-keepEach)
  );
}

// ─── 工具分发执行入口 ────────────────────────────────────────
// `agent` / `skill` 这类需要模型递归调用的工具仍然在 agent.ts 里实现。

export async function executeTool(
  name: string,
  input: Record<string, any>,
  readFileState?: Map<string, number>
): Promise<string> {
  let result: string;
  switch (name) {
    case "read_file":
      result = readFile(input as { file_path: string });
      // 读完文件后记录 mtime，后续编辑时可以检查“读后写”是否过期。
      if (readFileState && !result.startsWith("Error")) {
        const absPath = resolve(input.file_path);
        try { readFileState.set(absPath, statSync(absPath).mtimeMs); } catch {}
      }
      break;
    case "write_file": {
      const absPath = resolve(input.file_path);
      // 已存在文件必须先读后写，避免模型盲写覆盖用户改动。
      if (readFileState && existsSync(absPath)) {
        if (!readFileState.has(absPath)) {
          return "Error: You must read this file before writing. Use read_file first to see its current contents.";
        }
        const cur = statSync(absPath).mtimeMs;
        const rec = readFileState.get(absPath)!;
        // mtime 改变说明用户或其他进程改过文件，要求重新读取最新内容。
        if (cur !== rec) {
          return `Warning: ${input.file_path} was modified externally since your last read. Please read_file again before writing.`;
        }
      }
      result = writeFile(input as { file_path: string; content: string });
      // 写成功后刷新记录的 mtime。
      if (readFileState && !result.startsWith("Error")) {
        try { readFileState.set(absPath, statSync(absPath).mtimeMs); } catch {}
      }
      break;
    }
    case "edit_file": {
      const absPath = resolve(input.file_path);
      // `edit_file` 也遵循同样的读后写保护。
      if (readFileState && existsSync(absPath)) {
        if (!readFileState.has(absPath)) {
          return "Error: You must read this file before editing. Use read_file first to see its current contents.";
        }
        const cur = statSync(absPath).mtimeMs;
        const rec = readFileState.get(absPath)!;
        if (cur !== rec) {
          return `Warning: ${input.file_path} was modified externally since your last read. Please read_file again before editing.`;
        }
      }
      result = editFile(
        input as { file_path: string; old_string: string; new_string: string }
      );
      // 编辑成功后同样更新 mtime。
      if (readFileState && existsSync(absPath) && !result.startsWith("Error")) {
        try { readFileState.set(absPath, statSync(absPath).mtimeMs); } catch {}
      }
      break;
    }
    case "list_files":
      result = await listFiles(input as { pattern: string; path?: string });
      break;
    case "grep_search":
      result = grepSearch(
        input as { pattern: string; path?: string; include?: string }
      );
      break;
    case "run_shell":
      result = runShell(input as { command: string; timeout?: number });
      break;
    case "web_fetch": {
      const url = input.url as string;
      const maxLength = (input.max_length as number) || 50000;
      // `AbortController` 用于 30 秒超时控制。
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: { "User-Agent": "mini-claude/1.0" },
        });
        clearTimeout(timeout);
        if (!res.ok) {
          result = `HTTP error: ${res.status} ${res.statusText}`;
          break;
        }
        const contentType = res.headers.get("content-type") || "";
        let text = await res.text();
        if (contentType.includes("html")) {
          // HTML 响应做最轻量的“去标签”清洗，转成可读文本。
          text = text
            .replace(/<script[\s\S]*?<\/script>/gi, "")
            .replace(/<style[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]*>/g, " ")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/\s{2,}/g, " ")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
        }
        // 远程内容也做最大长度控制。
        if (text.length > maxLength) {
          text = text.slice(0, maxLength) + `\n\n[... truncated at ${maxLength} characters]`;
        }
        result = text || "(empty response)";
      } catch (err: any) {
        clearTimeout(timeout);
        // 把超时和普通网络错误分开表达，便于模型采取不同策略。
        if (err.name === "AbortError") {
          result = "Error: Request timed out (30s)";
        } else {
          result = `Error fetching ${url}: ${err.message}`;
        }
      }
      break;
    }
    case "tool_search": {
      const query = (input.query as string || "").toLowerCase();
      // `tool_search` 只搜索 deferred 工具，因为普通工具本来就已可见。
      const deferred = toolDefinitions.filter(t => t.deferred);
      const matches = deferred.filter(t =>
        t.name.toLowerCase().includes(query) ||
        (t.description || "").toLowerCase().includes(query)
      );
      if (matches.length === 0) return "No matching deferred tools found.";
      // 命中的工具立即激活，后续 API 调用会带上它们的完整 schema。
      for (const m of matches) activatedTools.add(m.name);
      return JSON.stringify(matches.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      })), null, 2);
    }
    // `skill` / `agent` 由 agent.ts 自己处理。
    default:
      return `Unknown tool: ${name}`;
  }
  // 所有工具最终都统一走一次结果截断。
  return truncateResult(result);
}

// 测试辅助：清空权限规则缓存。
export function resetPermissionCache(): void {
  cachedRules = null;
}
````

### 步骤 2：确认和参考仓库零差异

````bash
cd "$TARGET_REPO"
diff -u "$REFERENCE_REPO/src/tools.ts" "$TARGET_REPO/src/tools.ts"
````

### 步骤 3：重新编译

````bash
cd "$TARGET_REPO"
npm run build
````

### 步骤 4：测试权限系统

````bash
cd "$TARGET_REPO"
node --input-type=module <<'EOF'
import { checkPermission, getDeferredToolNames } from "./dist/tools.js";

console.log(getDeferredToolNames().includes("enter_plan_mode"));
console.log(checkPermission("run_shell", { command: "git push" }, "default"));
console.log(checkPermission("run_shell", { command: "rm -rf tmp" }, "default"));
console.log(checkPermission("write_file", { file_path: "sandbox/new.txt" }, "default"));
console.log(checkPermission("read_file", { file_path: "sandbox/demo.txt" }, "default"));
EOF
````

## 本小节的“手把手测试流程”

````bash
cd "$TARGET_REPO"
diff -u "$REFERENCE_REPO/src/tools.ts" "$TARGET_REPO/src/tools.ts"
npm run build
node --input-type=module <<'EOF'
import { checkPermission } from "./dist/tools.js";
console.log(checkPermission("run_shell", { command: "git push" }, "default").action);
EOF
````

预期输出：

````text
confirm
````

到这里，工具系统章节完成。下一章进入子代理配置层：[07-subagent.md](./07-subagent.md)
