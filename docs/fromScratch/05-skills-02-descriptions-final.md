# 第 5-2 节：补上技能说明文本并收口到最终版 `skills.ts`

这一小节会把 `src/skills.ts` 收口到最终版。

你会在上一节的基础上补上 `buildSkillDescriptions()` 和 `resetSkillCache()`，让这个文件既能服务 CLI，也能服务后面的 system prompt 拼装逻辑。

## 本小节目标

1. 导出 `buildSkillDescriptions()` 和 `resetSkillCache()`。
2. 可以生成“用户可手动调用”和“仅自动调用”的技能说明文本。
3. 可以用 `diff` 确认当前 `src/skills.ts` 与参考仓库零差异。
4. 成功编译当前工程。

## 这份阶段版源码来自哪里

这一小节直接使用参考仓库最终版 `src/skills.ts`：

- 第 1-207 行

## 手把手实操

### 步骤 1：用最终版覆盖 `src/skills.ts`

把 `$TARGET_REPO/src/skills.ts` 整个替换成下面这份最终代码。

#### 最终版 `src/skills.ts` 完整代码

````ts
// 这个模块实现项目里的“技能系统”：
// 1. 从用户目录和项目目录扫描 `.claude/skills/*/SKILL.md`。
// 2. 解析 frontmatter，得到技能的名字、描述、工具限制、执行上下文。
// 3. 把技能正文当作 prompt 模板，并按调用参数做变量替换。

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import { parseFrontmatter } from "./frontmatter.js";

// ─── 技能定义结构 ───────────────────────────────────────────

export interface SkillDefinition {
  // 技能的唯一名字；用户可通过 `/<name>` 显式调用。
  name: string;
  // 显示给模型/用户看的简介。
  description: string;
  // 告诉模型“什么场景下应该考虑调用这个技能”。
  whenToUse?: string;
  // 如果配置了 allowed-tools，执行这个技能时只能用这里列出的工具。
  allowedTools?: string[];
  // `false` 表示不允许用户手动 `/skill-name` 调，只能由模型自动调用。
  userInvocable: boolean;
  // inline = 直接把 prompt 注入当前对话；fork = 用子代理隔离执行。
  context: "inline" | "fork";
  // SKILL.md 正文作为 prompt 模板保存。
  promptTemplate: string;
  // 技能来自项目目录还是用户主目录。
  source: "project" | "user";
  // 技能所在目录路径，用于展开 `${CLAUDE_SKILL_DIR}`。
  skillDir: string;
}

// ─── 技能发现与缓存 ─────────────────────────────────────────

// 发现结果做缓存，避免每轮都扫磁盘。
let cachedSkills: SkillDefinition[] | null = null;

export function discoverSkills(): SkillDefinition[] {
  if (cachedSkills) return cachedSkills;

  // 用 Map 是为了让后加载的同名技能覆盖前面的定义。
  const skills = new Map<string, SkillDefinition>();

  // 用户级技能优先级较低。
  const userDir = join(homedir(), ".claude", "skills");
  loadSkillsFromDir(userDir, "user", skills);

  // 项目级技能后加载，可覆盖同名用户级技能。
  const projectDir = join(process.cwd(), ".claude", "skills");
  loadSkillsFromDir(projectDir, "project", skills);

  cachedSkills = Array.from(skills.values());
  return cachedSkills;
}

function loadSkillsFromDir(
  baseDir: string,
  source: "project" | "user",
  skills: Map<string, SkillDefinition>
): void {
  // 对应目录不存在时直接返回，不视为错误。
  if (!existsSync(baseDir)) return;
  let entries: string[];
  try {
    entries = readdirSync(baseDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const skillDir = join(baseDir, entry);
    try {
      // 技能约定为“目录 + SKILL.md”，普通文件不是技能。
      if (!statSync(skillDir).isDirectory()) continue;
    } catch {
      continue;
    }
    const skillFile = join(skillDir, "SKILL.md");
    if (!existsSync(skillFile)) continue;

    const skill = parseSkillFile(skillFile, source, skillDir);
    // 解析成功后按技能名写入 Map。
    if (skill) skills.set(skill.name, skill);
  }
}

function parseSkillFile(
  filePath: string,
  source: "project" | "user",
  skillDir: string
): SkillDefinition | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const { meta, body } = parseFrontmatter(raw);

    // name 默认用目录名，避免要求每个技能都必须手写 frontmatter。
    const name = meta.name || basename(skillDir) || "unknown";
    // 默认为可手动调用；只有显式写 `false` 才禁用。
    const userInvocable = meta["user-invocable"] !== "false";
    // `context: fork` 表示技能要跑在独立子代理里；否则默认 inline。
    const context = meta.context === "fork" ? "fork" as const : "inline" as const;

    // `allowed-tools` 兼容两种写法：
    // 1. 逗号分隔字符串
    // 2. JSON 数组字符串
    let allowedTools: string[] | undefined;
    if (meta["allowed-tools"]) {
      const raw = meta["allowed-tools"];
      if (raw.startsWith("[")) {
        try { allowedTools = JSON.parse(raw); } catch {
          // JSON 解析失败时退回朴素字符串切分，增强容错。
          allowedTools = raw.replace(/[\[\]]/g, "").split(",").map((s) => s.trim());
        }
      } else {
        allowedTools = raw.split(",").map((s) => s.trim());
      }
    }

    return {
      name,
      description: meta.description || "",
      // frontmatter 同时兼容 snake_case 和 kebab-case。
      whenToUse: meta.when_to_use || meta["when-to-use"],
      allowedTools,
      userInvocable,
      context,
      promptTemplate: body,
      source,
      skillDir,
    };
  } catch {
    // 单个技能文件损坏时静默跳过，不让整个 CLI 因一个技能报错。
    return null;
  }
}

// ─── 技能查询与模板变量替换 ─────────────────────────────────

export function getSkillByName(name: string): SkillDefinition | null {
  return discoverSkills().find((s) => s.name === name) || null;
}

export function resolveSkillPrompt(skill: SkillDefinition, args: string): string {
  let prompt = skill.promptTemplate;
  // `$ARGUMENTS` 与 `${ARGUMENTS}` 都替换成用户传入的参数文本。
  prompt = prompt.replace(/\$ARGUMENTS|\$\{ARGUMENTS\}/g, args);
  // `${CLAUDE_SKILL_DIR}` 让技能能引用自身目录下的脚本/资源文件。
  prompt = prompt.replace(/\$\{CLAUDE_SKILL_DIR\}/g, skill.skillDir);
  return prompt;
}

export function executeSkill(
  skillName: string,
  args: string
): { prompt: string; allowedTools?: string[]; context: "inline" | "fork" } | null {
  const skill = getSkillByName(skillName);
  if (!skill) return null;
  // 对执行方来说，只需要最终 prompt、工具白名单和上下文模式。
  return {
    prompt: resolveSkillPrompt(skill, args),
    allowedTools: skill.allowedTools,
    context: skill.context,
  };
}

// ─── 生成 system prompt 中的“技能说明”小节 ──────────────────

export function buildSkillDescriptions(): string {
  const skills = discoverSkills();
  if (skills.length === 0) return "";

  const lines = ["# Available Skills", ""];
  // 可手动调用和只能自动调用的技能分开展示，避免混淆。
  const invocable = skills.filter((s) => s.userInvocable);
  const autoOnly = skills.filter((s) => !s.userInvocable);

  if (invocable.length > 0) {
    lines.push("User-invocable skills (user types /<name> to invoke):");
    for (const s of invocable) {
      lines.push(`- **/${s.name}**: ${s.description}`);
      // `whenToUse` 是给模型看的选择提示，也保留到说明里。
      if (s.whenToUse) lines.push(`  When to use: ${s.whenToUse}`);
    }
    lines.push("");
  }

  if (autoOnly.length > 0) {
    lines.push("Auto-invocable skills (use the skill tool when appropriate):");
    for (const s of autoOnly) {
      lines.push(`- **${s.name}**: ${s.description}`);
      if (s.whenToUse) lines.push(`  When to use: ${s.whenToUse}`);
    }
    lines.push("");
  }

  // 最后一行明确告诉模型：程序化调用要走 `skill` 工具，而不是直接复述 prompt。
  lines.push(
    "To invoke a skill programmatically, use the `skill` tool with the skill name and optional arguments."
  );
  return lines.join("\n");
}

// 测试或热重载场景下可清空缓存。
export function resetSkillCache(): void {
  cachedSkills = null;
}
````

### 步骤 2：确认和参考仓库零差异

```bash
diff -u "$REFERENCE_REPO/src/skills.ts" "$TARGET_REPO/src/skills.ts"
```

### 步骤 3：再准备一个只允许自动调用的技能

```bash
cd "$TARGET_REPO"
mkdir -p .claude/skills/auto-review
cat > .claude/skills/auto-review/SKILL.md <<'EOF'
---
name: auto-review
description: review a patch automatically
user-invocable: false
when-to-use: When code review is requested implicitly.
---
Review this patch carefully: $ARGUMENTS
EOF
```

### 步骤 4：重新编译

```bash
cd "$TARGET_REPO"
npm run build
```

### 步骤 5：测试技能说明文本

```bash
cd "$TARGET_REPO"
node --input-type=module <<'EOF'
import { buildSkillDescriptions, resetSkillCache } from "./dist/skills.js";

resetSkillCache();
console.log(buildSkillDescriptions());
EOF
```

## 现在你应该看到什么

1. `diff -u` 没有输出。
2. `npm run build` 可以通过。
3. 输出文本里会出现 `# Available Skills`。
4. 你会同时看到 `User-invocable skills` 和 `Auto-invocable skills` 两个分组。
5. `/explain-error` 会以带斜杠的形式出现，而 `auto-review` 会出现在自动调用分组里。

## 本小节的“手把手测试流程”

1. 先执行“步骤 1”覆盖最终版 `src/skills.ts`。
2. 再执行“步骤 2”的 `diff -u`。
3. 然后执行“步骤 3”准备第二个测试技能。
4. 接着执行“步骤 4”的 `npm run build`。
5. 最后执行“步骤 5”的脚本，确认技能说明文本已经完整。
