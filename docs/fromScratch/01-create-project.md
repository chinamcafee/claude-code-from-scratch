# 第 1 章：从零创建一个新工程

这一章只做一件事：把一个全新的 TypeScript CLI 工程跑起来。

注意，这一章里的 `src/cli.ts` 只是占位文件。第 12 章你会用最终版 `src/cli.ts` 把它整个替换掉。

## 本章目标

本章结束后，你应该得到一个满足下面条件的新工程：

1. 有独立目录。
2. 有 `package.json` 和 `tsconfig.json`。
3. 能正常 `npm install`。
4. 能正常 `npm run build`。
5. 能运行一个最小占位 CLI。

## 本章新增文件

- `package.json`
- `tsconfig.json`
- `src/cli.ts`（占位版，不是最终源码）

## 步骤 1：创建新工程目录

### 先动手

```bash
mkdir -p "$TARGET_REPO"
cd "$TARGET_REPO"
mkdir -p src
git init
```

### 再理解

你后面会不断在这个目录里追加正式源码，所以第一步先把干净目录和 `src/` 准备好。

## 步骤 2：复制根配置文件

### 先动手

把参考仓库里的这两个文件原封不动复制到新工程：

- `$REFERENCE_REPO/package.json`（32 行）
- `$REFERENCE_REPO/tsconfig.json`（16 行）

直接照抄下面这两份完整内容即可。

#### `package.json` 完整内容

````json
{
  "name": "claude-code-from-scratch",
  "version": "1.0.0",
  "description": "A minimal coding agent inspired by Claude Code, built from scratch in ~3000 lines",
  "type": "module",
  "bin": {
    "mini-claude": "./dist/cli.js"
  },
  "scripts": {
    "build": "tsc",
    "start": "node dist/cli.js",
    "dev": "tsc && node dist/cli.js"
  },
  "keywords": [
    "claude-code",
    "coding-agent",
    "cli",
    "ai",
    "llm"
  ],
  "license": "MIT",
  "dependencies": {
    "@anthropic-ai/sdk": "^0.52.0",
    "chalk": "^5.4.1",
    "glob": "^11.0.1",
    "openai": "^6.33.0"
  },
  "devDependencies": {
    "@types/node": "^22.15.3",
    "typescript": "^5.8.3"
  }
}
````

#### `tsconfig.json` 完整内容

````json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"]
}
````

复制完成后，立刻执行：

```bash
diff -u "$REFERENCE_REPO/package.json" "$TARGET_REPO/package.json"
diff -u "$REFERENCE_REPO/tsconfig.json" "$TARGET_REPO/tsconfig.json"
```

如果没有任何输出，说明你复制对了。

### 再理解

这两个文件虽然不在 `src/` 里，但它们决定了整个重建工程的运行边界：

1. `package.json` 决定依赖、脚本、CLI 入口和 ESM 模式。
2. `tsconfig.json` 决定源码目录、编译输出目录和 TS 编译行为。

## 步骤 3：安装依赖

### 先动手

```bash
cd "$TARGET_REPO"
npm install
```

### 再理解

后面所有正式源码都依赖这几个包：

- `@anthropic-ai/sdk`
- `openai`
- `chalk`
- `glob`
- `typescript`
- `@types/node`

现在一次性装好，后面每章都只专注于代码本身。

## 步骤 4：先写一个占位版 `src/cli.ts`

### 先动手

在 `$TARGET_REPO/src/cli.ts` 里先写入下面这段占位代码：

```ts
#!/usr/bin/env node

console.log("mini-claude bootstrap ready");
```

### 再理解

如果你现在什么都不放，`tsc` 会直接报 `TS18003: No inputs were found`。

所以我们先用一个最小入口把编译链路打通，第 12 章再用最终版 `src/cli.ts` 完全替换。

## 步骤 5：第一次构建和运行

### 先动手

```bash
cd "$TARGET_REPO"
npm run build
node dist/cli.js
```

预期输出：

```text
mini-claude bootstrap ready
```

### 再理解

你现在验证的是三件事：

1. TypeScript 编译链路是通的。
2. `dist/` 输出目录是正确的。
3. CLI 入口和 `type: module` 的组合没有问题。

## 手把手测试流程

按这个顺序跑，不要跳：

```bash
cd "$TARGET_REPO"
npm install
npm run build
node dist/cli.js
```

只要最后看到 `mini-claude bootstrap ready`，这一章就算完成。

## 本章完成状态

现在你的工程应该至少长这样：

```text
$TARGET_REPO
├─ package.json
├─ tsconfig.json
└─ src
   └─ cli.ts
```

下一章开始接第一份正式源码：[02-frontmatter.md](./02-frontmatter.md)
