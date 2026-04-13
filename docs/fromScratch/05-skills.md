# 第 5 章：技能系统总览

`src/skills.ts` 既负责发现技能，也负责 prompt 模板变量替换、执行结果整理，以及给 system prompt 生成技能说明。

所以这一章拆成 2 个独立文件。你按顺序做完后，`src/skills.ts` 就会和参考仓库完全一致。

## 本章路线

1. [05-skills-01-discovery-execution.md](./05-skills-01-discovery-execution.md)：先搭好技能发现、解析和执行结果整理。
2. [05-skills-02-descriptions-final.md](./05-skills-02-descriptions-final.md)：补上技能说明文本和最终版收口。

## 这一章做完后的验收目标

1. `diff -u "$REFERENCE_REPO/src/skills.ts" "$TARGET_REPO/src/skills.ts"` 没有输出。
2. 你可以发现 `.claude/skills/*/SKILL.md` 技能。
3. 你可以调用 `resolveSkillPrompt()`、`executeSkill()` 和 `buildSkillDescriptions()`。


从这里开始：[05-skills-01-discovery-execution.md](./05-skills-01-discovery-execution.md)
