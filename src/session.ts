import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// 会话都落到用户主目录下，避免污染项目仓库本身。
const SESSION_DIR = join(homedir(), ".mini-claude", "sessions");

interface SessionMetadata {
  // 简短会话 ID，用来恢复最近一次会话。
  id: string;
  // 保存模型名，恢复时便于理解这段会话是谁生成的。
  model: string;
  // 记录当时的工作目录，便于定位这段会话属于哪个项目。
  cwd: string;
  // ISO 时间戳，用于排序“最近一次会话”。
  startTime: string;
  // 粗略记录消息数，方便展示会话规模。
  messageCount: number;
}

interface SessionData {
  // 元数据始终存在。
  metadata: SessionMetadata;
  // Anthropic / OpenAI 两套消息历史分开存，谁在用就恢复谁。
  anthropicMessages?: any[];
  openaiMessages?: any[];
}

function ensureDir() {
  // 写会话前保证目录存在；`recursive` 能处理首次启动场景。
  if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });
}

export function saveSession(
  id: string,
  data: Omit<SessionData, "metadata"> & { metadata: SessionMetadata }
): void {
  // 每个会话一个独立 JSON 文件，读写简单，调试也直观。
  ensureDir();
  writeFileSync(join(SESSION_DIR, `${id}.json`), JSON.stringify(data, null, 2));
}

export function loadSession(id: string): SessionData | null {
  const file = join(SESSION_DIR, `${id}.json`);
  // 会话文件不存在时直接返回 null，让上层决定如何提示用户。
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    // JSON 损坏时静默失败，避免恢复流程把 CLI 直接打崩。
    return null;
  }
}

export function listSessions(): SessionMetadata[] {
  ensureDir();
  // 只看 json 文件，其他杂项文件一律忽略。
  const files = readdirSync(SESSION_DIR).filter((f) => f.endsWith(".json"));
  return files
    .map((f) => {
      try {
        // 列表场景只需要 metadata，不需要把整段消息历史都返回给调用方。
        const data = JSON.parse(readFileSync(join(SESSION_DIR, f), "utf-8"));
        return data.metadata as SessionMetadata;
      } catch {
        // 单个文件损坏不应该影响其它会话展示。
        return null;
      }
    })
    .filter(Boolean) as SessionMetadata[];
}

export function getLatestSessionId(): string | null {
  const sessions = listSessions();
  if (sessions.length === 0) return null;
  // 用开始时间倒序，取最近的一次会话。
  sessions.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
  return sessions[0].id;
}
