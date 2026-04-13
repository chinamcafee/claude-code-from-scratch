# 第 10 章：接入 `mcp.ts`

这一章把外部 MCP server 接进来。

重点是：先把“连接与桥接”打通，不急着和 Agent 整合。Agent 整合在下一章。

## 本章目标

本章结束后，你会得到：

1. 一个和参考仓库完全一致的 `src/mcp.ts`。
2. 通过 stdio 启动 MCP server 的能力。
3. 发现 MCP tools 并转成普通 tool definition 的能力。
4. 调用 MCP tool 的能力。

## 本章新增的正式源码

- `src/mcp.ts`（295 行）
- 源码基准：`$REFERENCE_REPO/src/mcp.ts`

## 步骤 1：创建文件

### 先动手

```bash
cd "$TARGET_REPO"
touch src/mcp.ts
```

### 再理解

老规矩，先放位置。

## 步骤 2：复制正式源码并校验

### 先动手

把 `$REFERENCE_REPO/src/mcp.ts` 的 295 行完整复制到 `$TARGET_REPO/src/mcp.ts`。

直接照抄下面这份完整代码：

#### `src/mcp.ts` 完整代码

````ts
/**
 * 这个模块实现一个最小版 MCP 客户端。
 * 它通过 stdio 启动外部 MCP server，使用原始 JSON-RPC 协议与之通信，
 * 然后把 MCP tool 暴露给主 agent 当作普通工具来调用。
 *
 * 配置来源：
 * 1. ~/.claude/settings.json
 * 2. .claude/settings.json
 * 3. .mcp.json
 *
 * 每个 MCP 工具都会被改名为 `mcp__serverName__toolName`，
 * 这样可以避免和本地内置工具重名。
 */

import { spawn, type ChildProcess } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createInterface, type Interface } from "readline";

// ─── MCP 配置与工具元数据 ───────────────────────────────────

interface McpServerConfig {
  // 启动服务端进程的命令，例如 `npx`、`node`、`uvx`。
  command: string;
  // 传给命令的参数数组。
  args?: string[];
  // 额外环境变量，会 merge 到当前进程环境里。
  env?: Record<string, string>;
}

interface McpToolInfo {
  // MCP 原始工具名。
  name: string;
  // 工具描述，将转发给模型。
  description?: string;
  // MCP 返回的 JSON Schema。
  inputSchema?: any;
  // 这个工具来自哪个 server。
  serverName: string;
}

// ─── 单个 MCP server 连接对象 ───────────────────────────────

class McpConnection {
  // 子进程句柄。
  private process: ChildProcess | null = null;
  // JSON-RPC 自增请求 ID。
  private nextId = 1;
  // 按请求 ID 暂存 promise 的 resolve/reject。
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  // readline 用来把 stdout 按行切成一条条 JSON-RPC 消息。
  private rl: Interface | null = null;

  constructor(private serverName: string, private config: McpServerConfig) {}

  // 启动 MCP server 进程，并把 stdout/stderr/stdin 管起来。
  async connect(): Promise<void> {
    // 服务端可以通过配置注入专属环境变量，但默认继承当前环境。
    const env = { ...process.env, ...(this.config.env || {}) };
    this.process = spawn(this.config.command, this.config.args || [], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    // 默认按“每行一个 JSON-RPC 消息”解析 stdout。
    this.rl = createInterface({ input: this.process.stdout! });
    this.rl.on("line", (line: string) => {
      try {
        const msg = JSON.parse(line);
        // 只有带 id 的响应才和 pending request 相关。
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) {
            // MCP 错误对象转成普通 Error，便于上层统一处理。
            reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
          } else {
            resolve(msg.result);
          }
        }
      } catch {
        // 某些 server 可能往 stdout 打日志，非 JSON 行一律忽略。
      }
    });

    // stderr 只监听不处理，避免因为没人消费而阻塞缓冲区。
    this.process.stderr?.on("data", () => {});

    this.process.on("error", (err) => {
      console.error(`[mcp:${this.serverName}] process error: ${err.message}`);
    });

    this.process.on("exit", (code) => {
      // 进程退出时，把所有仍在等待的请求全部 reject 掉。
      for (const [, { reject }] of this.pending) {
        reject(new Error(`MCP server '${this.serverName}' exited with code ${code}`));
      }
      this.pending.clear();
    });
  }

  // 发送一条标准 JSON-RPC request，并等待相同 id 的 response。
  private sendRequest(method: string, params: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin?.writable) {
        return reject(new Error(`MCP server '${this.serverName}' is not connected`));
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      this.process.stdin.write(msg);
    });
  }

  // notification 没有 id，也不期待响应。
  private sendNotification(method: string, params: any = {}): void {
    if (!this.process?.stdin?.writable) return;
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    this.process.stdin.write(msg);
  }

  // 按 MCP 协议先做 initialize 握手，再发 initialized 通知。
  async initialize(): Promise<void> {
    await this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mini-claude", version: "1.0.0" },
    });
    this.sendNotification("notifications/initialized");
  }

  // 列出当前 server 暴露的所有工具，并整理成统一结构。
  async listTools(): Promise<McpToolInfo[]> {
    const result = await this.sendRequest("tools/list");
    if (!result?.tools || !Array.isArray(result.tools)) return [];
    return result.tools.map((t: any) => ({
      name: t.name,
      description: t.description || "",
      inputSchema: t.inputSchema,
      serverName: this.serverName,
    }));
  }

  // 调用 MCP 工具，并把返回结果尽量转成纯文本。
  async callTool(name: string, args: any): Promise<string> {
    const result = await this.sendRequest("tools/call", { name, arguments: args });
    // MCP 常见返回形态是 `{ content: [{ type: "text", text: "..." }] }`。
    if (result?.content && Array.isArray(result.content)) {
      return result.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
    }
    // 其它结构直接 JSON 字符串化，至少别丢信息。
    return JSON.stringify(result);
  }

  // 主动关闭连接时顺手杀掉子进程。
  close(): void {
    this.rl?.close();
    this.process?.kill();
    this.process = null;
  }
}

// ─── MCP 管理器：负责配置加载、连接池和工具路由 ─────────────

export class McpManager {
  // serverName -> connection
  private connections = new Map<string, McpConnection>();
  // 所有已发现的工具平铺到一个数组里，便于生成 tool definitions。
  private tools: McpToolInfo[] = [];
  // 防止重复初始化。
  private connected = false;

  /**
   * 读取配置、连接所有 MCP server，并发现它们的工具。
   * 这个方法可重入；第一次之后直接 no-op。
   */
  async loadAndConnect(): Promise<void> {
    if (this.connected) return;
    this.connected = true;

    const configs = this.loadConfigs();
    // 没有任何 MCP 配置时直接结束，不视为异常。
    if (Object.keys(configs).length === 0) return;

    const TIMEOUT_MS = 15_000;

    for (const [name, config] of Object.entries(configs)) {
      const conn = new McpConnection(name, config);
      try {
        await conn.connect();
        // initialize / listTools 都加超时保护，避免某个坏 server 无限卡住启动。
        await Promise.race([
          conn.initialize(),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), TIMEOUT_MS)),
        ]);
        const serverTools = await Promise.race([
          conn.listTools(),
          new Promise<McpToolInfo[]>((_, rej) => setTimeout(() => rej(new Error("timeout")), TIMEOUT_MS)),
        ]);
        this.connections.set(name, conn);
        this.tools.push(...serverTools);
        console.error(`[mcp] Connected to '${name}' — ${serverTools.length} tools`);
      } catch (err: any) {
        // 单个 server 连接失败不影响其它 server。
        console.error(`[mcp] Failed to connect to '${name}': ${err.message}`);
        conn.close();
      }
    }
  }

  /**
   * 把 MCP 工具转换成 Anthropic 风格的工具定义。
   */
  getToolDefinitions(): Array<{ name: string; description: string; input_schema: any }> {
    return this.tools.map((t) => ({
      // 统一加 `mcp__` 前缀，避免和本地工具撞名。
      name: `mcp__${t.serverName}__${t.name}`,
      description: t.description || `MCP tool ${t.name} from ${t.serverName}`,
      input_schema: t.inputSchema || { type: "object", properties: {} },
    }));
  }

  // 快速判断某个工具名是否属于 MCP。
  isMcpTool(name: string): boolean {
    return name.startsWith("mcp__");
  }

  // 根据前缀后的 server/tool 名把调用路由到正确的连接对象。
  async callTool(prefixedName: string, args: any): Promise<string> {
    // `mcp__serverName__toolName` => `["mcp", serverName, toolName...]`
    const parts = prefixedName.split("__");
    if (parts.length < 3) throw new Error(`Invalid MCP tool name: ${prefixedName}`);
    const serverName = parts[1];
    // 工具名本身允许包含 `__`，所以后半段全部重新 join 回去。
    const toolName = parts.slice(2).join("__");
    const conn = this.connections.get(serverName);
    if (!conn) throw new Error(`MCP server '${serverName}' not connected`);
    return conn.callTool(toolName, args);
  }

  // 关闭所有连接，通常用于进程退出或测试清理。
  async disconnectAll(): Promise<void> {
    for (const [, conn] of this.connections) {
      conn.close();
    }
    this.connections.clear();
    this.tools = [];
    this.connected = false;
  }

  // ─── 私有：配置文件读取与合并 ───────────────────────────────

  private loadConfigs(): Record<string, McpServerConfig> {
    const merged: Record<string, McpServerConfig> = {};

    // 1. 用户级 settings
    const globalPath = join(homedir(), ".claude", "settings.json");
    this.mergeConfigFile(globalPath, merged);

    // 2. 项目级 settings，后写入的同名 server 会覆盖前面的配置
    const projectPath = join(process.cwd(), ".claude", "settings.json");
    this.mergeConfigFile(projectPath, merged);

    // 3. 兼容 Claude Code 风格的 `.mcp.json`
    const mcpJsonPath = join(process.cwd(), ".mcp.json");
    this.mergeConfigFile(mcpJsonPath, merged);

    return merged;
  }

  private mergeConfigFile(filePath: string, target: Record<string, McpServerConfig>): void {
    if (!existsSync(filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf-8"));
      // 兼容 `{ mcpServers: {...} }` 和直接 `{...}` 两种结构。
      const servers = raw.mcpServers || raw;
      for (const [name, config] of Object.entries(servers)) {
        if (this.isValidConfig(config)) {
          target[name] = config as McpServerConfig;
        }
      }
    } catch {
      // 配置文件格式不合法时静默跳过，避免阻断整个 CLI。
    }
  }

  private isValidConfig(config: any): boolean {
    // 最低限度只要求它是对象且有 `command` 字符串。
    return config && typeof config === "object" && typeof config.command === "string";
  }
}
````

然后执行：

```bash
diff -u "$REFERENCE_REPO/src/mcp.ts" "$TARGET_REPO/src/mcp.ts"
```

### 再理解

`mcp.ts` 的边界也非常清楚：

1. 读配置。
2. 连服务。
3. 拉工具列表。
4. 转发调用。

它不负责 Agent loop，不负责权限，不负责 UI。

## 步骤 3：准备一个最小 `.mcp.json`

### 先动手

```bash
cd "$TARGET_REPO"
cat > .mcp.json <<EOF
{
  "demo": {
    "command": "node",
    "args": ["$REFERENCE_REPO/test/mcp-server.cjs"]
  }
}
EOF
```

### 再理解

这里直接复用参考仓库里现成的测试 MCP server：

- `echo`
- `add`
- `timestamp`

这样你不用先自己再写一个 server。

## 步骤 4：构建

### 先动手

```bash
cd "$TARGET_REPO"
npm run build
```

### 再理解

这一章编译通过后，说明你已经具备“连接外部工具生态”的最低能力了。

## 步骤 5：直接测试 MCP 管理器

### 先动手

```bash
cd "$TARGET_REPO"
node --input-type=module <<'EOF'
import { McpManager } from "./dist/mcp.js";

const mcp = new McpManager();
await mcp.loadAndConnect();

console.log(mcp.getToolDefinitions());
console.log(await mcp.callTool("mcp__demo__echo", { text: "hello-mcp" }));
console.log(await mcp.callTool("mcp__demo__add", { a: 2, b: 3 }));

await mcp.disconnectAll();
EOF
```

### 再理解

你现在验证的是：

1. 配置能读到。
2. 进程能拉起来。
3. 工具列表能发现。
4. 工具调用能成功。
5. `mcp__server__tool` 这种前缀命名是通的。

## 本章原理解释

MCP 集成的关键不是“多复杂”，而是“命名和边界够清楚”。

所以这份实现只做最小的一层桥接：

1. JSON-RPC over stdio。
2. `mcp__server__tool` 命名隔离。
3. 每个 server 独立连接，失败互不影响。

## 手把手测试流程

```bash
cd "$TARGET_REPO"
diff -u "$REFERENCE_REPO/src/mcp.ts" "$TARGET_REPO/src/mcp.ts"
npm run build
node --input-type=module <<'EOF'
import { McpManager } from "./dist/mcp.js";
const mcp = new McpManager();
await mcp.loadAndConnect();
console.log(mcp.isMcpTool("mcp__demo__echo"));
await mcp.disconnectAll();
EOF
```

预期输出：

```text
true
```

下一章装配核心 Agent：[11-agent.md](./11-agent.md)
