# 第 13 章：最终 1:1 验收

前面 12 章做的是“施工”。

这一章做的是“验收”。

不要跳过这一章。你这套从零重建工程到底是不是 1:1，对照检查只看这里。

## 本章目标

本章结束后，你应该能非常明确地回答：

1. 我的源码是不是和参考仓库一致。
2. 我的根配置是不是和参考仓库一致。
3. 我的核心功能是不是都至少跑过一遍。

## 验收 1：做零差异源码校验

### 先动手

```bash
cd "$TARGET_REPO"
diff -u "$REFERENCE_REPO/package.json" "$TARGET_REPO/package.json"
diff -u "$REFERENCE_REPO/tsconfig.json" "$TARGET_REPO/tsconfig.json"
diff -ruN "$REFERENCE_REPO/src" "$TARGET_REPO/src"
```

### 再理解

这是最硬的一条验收线。

只要这里有输出，就说明你还没有完成“1:1 复刻”。

## 验收 2：重新做一次完整构建

### 先动手

```bash
cd "$TARGET_REPO"
rm -rf dist
npm run build
```

### 再理解

清空 `dist/` 后再编译，能排除“上一次残留编译产物刚好蒙对了”的假象。

## 验收 3：做一组本地无模型检查

### 先动手

```bash
cd "$TARGET_REPO"
node --input-type=module <<'EOF'
import { parseFrontmatter } from "./dist/frontmatter.js";
import { getLatestSessionId } from "./dist/session.js";
import { buildMemoryPromptSection } from "./dist/memory.js";
import { discoverSkills } from "./dist/skills.js";
import { getDeferredToolNames } from "./dist/tools.js";
import { getAvailableAgentTypes } from "./dist/subagent.js";
import { buildSystemPrompt } from "./dist/prompt.js";

console.log(parseFrontmatter(`---\nname: ok\n---\nbody`).meta.name);
console.log(typeof getLatestSessionId());
console.log(buildMemoryPromptSection().includes("Memory System"));
console.log(discoverSkills().length >= 1);
console.log(getDeferredToolNames().includes("enter_plan_mode"));
console.log(getAvailableAgentTypes().length >= 3);
console.log(buildSystemPrompt().includes("Working directory:"));
EOF
```

### 再理解

这一组检查确保核心模块在“不访问模型”的前提下仍然都是活的。

## 验收 4：跑 CLI 帮助页和 REPL 启动

### 先动手

```bash
cd "$TARGET_REPO"
node dist/cli.js --help
```

然后再执行：

```bash
cd "$TARGET_REPO"
node dist/cli.js
```

在 REPL 里至少做这 3 个动作：

1. 输入 `/skills`
2. 输入 `/memory`
3. 输入 `exit`

### 再理解

这一步验证的是“整机通电”。

也就是：

1. CLI 入口能跑。
2. REPL 能跑。
3. 本地命令分发能跑。

## 验收 5：做一次真实模型对话

### 先动手

如果你有 Anthropic key：

```bash
cd "$TARGET_REPO"
export ANTHROPIC_API_KEY=你的真实密钥
node dist/cli.js "Reply with exactly FINAL_OK"
```

如果你走 OpenAI-compatible：

```bash
cd "$TARGET_REPO"
export OPENAI_API_KEY=你的真实密钥
export OPENAI_BASE_URL=你的兼容接口地址
node dist/cli.js --model gpt-4o-mini "Reply with exactly FINAL_OK"
```

### 再理解

这一步才是真正的“端到端验收”。

它同时覆盖：

1. CLI
2. Agent
3. Prompt
4. 模型后端
5. UI 输出

## 验收 6：按功能主题做一次加餐测试

如果你还想更扎实一点，直接回参考仓库原有的测试文档继续补测：

- [../14-testing.md](../14-testing.md)

推荐至少补这几项：

1. MCP 工具调用
2. 技能调用
3. `/plan` 和 plan 审批流
4. `--resume`
5. 子代理 `agent` 工具
6. 大结果持久化

## 出现差异时怎么处理

如果 `diff` 有输出，不要直接手改到“看起来差不多”。

正确处理顺序是：

1. 找到差异属于哪一章。
2. 回到那一章，重新对照参考文件复制。
3. 再跑一遍该章的 `diff -u`。
4. 最后回到这一章重跑总验收。

## 你现在应该得到的最终状态

你的 `$TARGET_REPO` 里，正式源码应该完整覆盖这 11 个文件：

```text
src/
├─ agent.ts
├─ cli.ts
├─ frontmatter.ts
├─ mcp.ts
├─ memory.ts
├─ prompt.ts
├─ session.ts
├─ skills.ts
├─ subagent.ts
├─ tools.ts
└─ ui.ts
```

只要下面 3 条同时成立，就说明你已经完成这一系列文档的目标：

1. `src/` 零差异。
2. 配置零差异。
3. CLI 和真实对话都跑通。

到这里，你已经完成了“从零创建一个新工程，再逐步复制到 1:1 功能”的整套实操闭环。
