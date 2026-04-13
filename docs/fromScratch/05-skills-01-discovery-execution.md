# 第 5-1 节：先搭好技能发现、解析和执行结果整理

这一小节结束后，你拿到的不是最终版 `src/skills.ts`，而是一个可编译、可测试的阶段版。

这个阶段版先把技能系统最核心的三部分接上：扫描目录、解析 `SKILL.md` frontmatter、以及把技能模板展开成最终 prompt。

## 本小节目标

1. 导出 `discoverSkills()`、`getSkillByName()`、`resolveSkillPrompt()`、`executeSkill()`。
2. 能发现项目级技能目录。
3. 能把 `$ARGUMENTS` 和 `${CLAUDE_SKILL_DIR}` 替换进 prompt 模板。
4. 成功编译当前工程。

## 这份阶段版源码来自哪里

这一小节的阶段版 `src/skills.ts` 完全由参考文件中的这段原始源码组成：

- 第 1-165 行

## 手把手实操

### 步骤 1：用第一阶段版本覆盖 `src/skills.ts`

把 `$TARGET_REPO/src/skills.ts` 整个替换成下面这份阶段版代码。

#### 当前阶段版 `src/skills.ts` 完整代码

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
````

### 步骤 2：准备一个最小测试技能

```bash
cd "$TARGET_REPO"
mkdir -p .claude/skills/explain-error
cat > .claude/skills/explain-error/SKILL.md <<'EOF'
---
name: explain-error
description: explain an error message
context: inline
allowed-tools: read_file,grep_search
---
Please explain this error: $ARGUMENTS

Skill dir is ${CLAUDE_SKILL_DIR}.
EOF
```

### 步骤 3：先编译

```bash
cd "$TARGET_REPO"
npm run build
```

### 步骤 4：测试技能发现和模板展开

```bash
cd "$TARGET_REPO"
node --input-type=module <<'EOF'
import { discoverSkills, getSkillByName, resolveSkillPrompt, executeSkill } from "./dist/skills.js";

const skills = discoverSkills();
console.log("skills:", skills.map((s) => s.name));
const skill = getSkillByName("explain-error");
console.log("found:", !!skill);
if (skill) {
  console.log(resolveSkillPrompt(skill, "TS2304"));
  console.log(executeSkill("explain-error", "TS2304"));
}
EOF
```

## 现在你应该看到什么

1. `npm run build` 可以通过。
2. `skills:` 列表里会出现 `explain-error`。
3. `found:` 应该是 `true`。
4. 展开后的 prompt 文本里会出现 `TS2304`，并把 `${CLAUDE_SKILL_DIR}` 替换成真实目录。
5. `executeSkill(...)` 的输出对象里会包含 `allowedTools` 和 `context`。

## 本小节的“手把手测试流程”

1. 先执行“步骤 1”，把第一阶段 `src/skills.ts` 写进去。
2. 再执行“步骤 2”，准备一个真正可被扫描到的 `SKILL.md`。
3. 然后执行“步骤 3”的 `npm run build`。
4. 最后执行“步骤 4”的脚本，确认技能发现、模板展开和执行结果整理都已可用。
