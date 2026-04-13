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
