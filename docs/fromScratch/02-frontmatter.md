# 第 2 章：先接入 `frontmatter.ts`

从这一章开始，所有正式源码都必须 100% 对齐参考仓库的 `src/`。

这一章只做一个很小但很关键的基础模块：`src/frontmatter.ts`。

## 本章目标

本章结束后，你会得到：

1. 一个和参考仓库完全一致的 `src/frontmatter.ts`。
2. 一个可用的 frontmatter 解析器。
3. 一个可用的 frontmatter 格式化器。

## 本章新增的正式源码

- `src/frontmatter.ts`（57 行）
- 源码基准：`$REFERENCE_REPO/src/frontmatter.ts`

## 步骤 1：创建目标文件

### 先动手

```bash
cd "$TARGET_REPO"
touch src/frontmatter.ts
```

### 再理解

你现在只做文件落位，不急着理解实现。

## 步骤 2：原封不动复制参考源码

### 先动手

打开这两个文件：

- 参考文件：`$REFERENCE_REPO/src/frontmatter.ts`
- 目标文件：`$TARGET_REPO/src/frontmatter.ts`

把参考文件的 57 行代码一行不改地复制进去。

直接照抄下面这份完整代码：

#### `src/frontmatter.ts` 完整代码

````ts
// 这个模块给 memory / skill 等 markdown 文件提供最简 frontmatter 解析能力。
// 它只支持最常见的 `--- ... ---` 包裹、以及 `key: value` 这一种简单键值格式。
// 这里故意没有引入完整 YAML 解析器，因为项目只需要轻量、可控的子集。

export interface FrontmatterResult {
  // 头部元数据，按字符串键值对返回。
  meta: Record<string, string>;
  // 去掉 frontmatter 后剩余的正文内容。
  body: string;
}

export function parseFrontmatter(content: string): FrontmatterResult {
  // 逐行解析最容易处理 `---` 分隔符，也方便后面按行切片正文。
  const lines = content.split("\n");
  // 第一行不是 `---`，说明这个文件没有 frontmatter，直接把整段当正文。
  if (lines[0]?.trim() !== "---") return { meta: {}, body: content };

  // 从第二行开始寻找结束分隔符。
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    // 一旦遇到第二个 `---`，frontmatter 头部就结束了。
    if (lines[i].trim() === "---") { endIdx = i; break; }
  }
  // 只有起始分隔符、没有结束分隔符时，也按“无 frontmatter”处理，避免误吞正文。
  if (endIdx === -1) return { meta: {}, body: content };

  // 逐行解析 `key: value`。
  const meta: Record<string, string> = {};
  for (let i = 1; i < endIdx; i++) {
    // 只按第一个冒号切分，这样值里还能继续包含冒号。
    const colonIdx = lines[i].indexOf(":");
    // 没有冒号的行不是合法键值，直接跳过。
    if (colonIdx === -1) continue;
    const key = lines[i].slice(0, colonIdx).trim();
    const value = lines[i].slice(colonIdx + 1).trim();
    // 空 key 没有意义，不写入结果。
    if (key) meta[key] = value;
  }

  // 正文是结束分隔符之后的全部内容，最后 `trim()` 是为了去掉常见的头尾空行。
  const body = lines.slice(endIdx + 1).join("\n").trim();
  return { meta, body };
}

export function formatFrontmatter(meta: Record<string, string>, body: string): string {
  // 按 frontmatter 标准格式重新拼回 markdown 文本。
  const lines = ["---"];
  for (const [key, value] of Object.entries(meta)) {
    // 这里不做 YAML 转义，保持和 parseFrontmatter 一样的轻量约束。
    lines.push(`${key}: ${value}`);
  }
  // 空行用于把头部和正文分开，便于人类阅读。
  lines.push("---");
  lines.push("");
  lines.push(body);
  return lines.join("\n");
}
````

复制后立刻执行：

```bash
diff -u "$REFERENCE_REPO/src/frontmatter.ts" "$TARGET_REPO/src/frontmatter.ts"
```

没有输出才算复制完成。

### 再理解

这个模块后面会被 3 处核心能力复用：

1. `memory.ts` 解析记忆文件。
2. `skills.ts` 解析 `SKILL.md`。
3. `subagent.ts` 解析自定义 agent 的 markdown frontmatter。

所以它虽然小，但属于必须先站稳的地基。

## 步骤 3：重新构建

### 先动手

```bash
cd "$TARGET_REPO"
npm run build
```

### 再理解

这里先只验证“新增模块能编译通过”，不急着进入更大模块。

## 步骤 4：做一个最小功能验证

### 先动手

```bash
cd "$TARGET_REPO"
node --input-type=module <<'EOF'
import { parseFrontmatter, formatFrontmatter } from "./dist/frontmatter.js";

const raw = `---
name: demo
description: sample
type: project
---
This is the body.`;

console.log(parseFrontmatter(raw));
console.log(formatFrontmatter(
  { name: "demo", description: "sample", type: "project" },
  "This is the body."
));
EOF
```

### 再理解

你现在验证的是：

1. `parseFrontmatter()` 能拆出 `meta` 和 `body`。
2. `formatFrontmatter()` 能把对象重新拼回 markdown 文本。

## 本章原理解释

这份实现刻意保持极简，只支持项目里真正需要的那一小撮 YAML 语法：

1. 只认 `---` 包裹。
2. 只认 `key: value`。
3. 不引入第三方 YAML 解析器。

原因很简单：项目只需要轻量、可控、可读的 frontmatter 子集，不需要完整 YAML 生态。

## 手把手测试流程

```bash
cd "$TARGET_REPO"
diff -u "$REFERENCE_REPO/src/frontmatter.ts" "$TARGET_REPO/src/frontmatter.ts"
npm run build
node --input-type=module <<'EOF'
import { parseFrontmatter } from "./dist/frontmatter.js";
const result = parseFrontmatter(`---\nname: ok\n---\nbody`);
console.log(result.meta.name);
console.log(result.body);
EOF
```

预期至少看到两行：

```text
ok
body
```

下一章继续接入会话存储：[03-session.md](./03-session.md)
