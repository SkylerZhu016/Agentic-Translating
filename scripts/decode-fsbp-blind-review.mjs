import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const privateDir = path.join(root, "FSBP_Test", "private", "blind-review");
const reportPath = path.resolve(
  root,
  process.argv[2] ??
    path.join(
      "FSBP_Test",
      "private",
      "blind-review",
      "gpt-5.6-sol-xhigh-scores.md",
    ),
);
const keyPath = path.join(privateDir, "blind-key.json");
const outputJsonPath = path.join(privateDir, "gpt-judge-decoded.json");
const outputMarkdownPath = path.join(privateDir, "gpt-judge-decoded.md");

const dimensions = [
  "忠实度",
  "自然度",
  "文体与声音",
  "结构或形式",
  "术语与逻辑",
  "整体质量",
];

const [report, keyText] = await Promise.all([
  fs.readFile(reportPath, "utf8"),
  fs.readFile(keyPath, "utf8"),
]);
const key = JSON.parse(keyText);

function parseSample(entry) {
  const sampleLabel = String(entry.sampleNo).padStart(2, "0");
  const heading = `## 样本 ${sampleLabel}`;
  const start = report.indexOf(heading);
  if (start < 0) {
    throw new Error(`评分报告缺少 ${heading}`);
  }
  const next = report.indexOf("## 样本 ", start + heading.length);
  const section = report.slice(start, next < 0 ? report.length : next);
  const scorePattern = (position) =>
    new RegExp(
      `\\| ${position} \\| (\\d+) \\| (\\d+) \\| (\\d+) \\| (\\d+) \\| (\\d+) \\| (\\d+) \\|`,
    );
  const aMatch = section.match(scorePattern("A"));
  const bMatch = section.match(scorePattern("B"));
  const conclusion = section.match(/- 结论：(A|B|并列)/);
  if (!aMatch || !bMatch || !conclusion) {
    throw new Error(`无法解析样本 ${sampleLabel} 的分数或结论`);
  }

  const scores = {
    A: aMatch.slice(1).map(Number),
    B: bMatch.slice(1).map(Number),
  };
  const directPosition = entry.A.source === "direct" ? "A" : "B";
  const agentPosition = entry.A.source === "agentic_b2" ? "A" : "B";
  const winner =
    conclusion[1] === "并列"
      ? "tie"
      : entry[conclusion[1]].source;

  return {
    sampleNo: entry.sampleNo,
    sampleId: entry.sampleId,
    direction: entry.direction,
    category: entry.category,
    directPosition,
    agentPosition,
    winner,
    directScores: scores[directPosition],
    agentScores: scores[agentPosition],
  };
}

const rows = key.entries.map(parseSample);

function summarize(sampleRows) {
  const means = (scoreKey) =>
    dimensions.map((dimension, index) => ({
      dimension,
      value:
        sampleRows.reduce((sum, row) => sum + row[scoreKey][index], 0) /
        sampleRows.length,
    }));
  return {
    count: sampleRows.length,
    agentWins: sampleRows.filter((row) => row.winner === "agentic_b2").length,
    directWins: sampleRows.filter((row) => row.winner === "direct").length,
    ties: sampleRows.filter((row) => row.winner === "tie").length,
    directMeans: means("directScores"),
    agentMeans: means("agentScores"),
  };
}

const summary = summarize(rows);
const groups = Object.fromEntries(
  [
    ["en_to_zh", (row) => row.direction === "en_to_zh"],
    ["zh_to_en", (row) => row.direction === "zh_to_en"],
    ["poetry", (row) => row.category === "poetry"],
    ["literary", (row) => row.category === "literary"],
    [
      "cultural_argument",
      (row) => row.category === "cultural_argument",
    ],
    ["nonliterary", (row) => row.category === "nonliterary"],
  ].map(([name, predicate]) => [name, summarize(rows.filter(predicate))]),
);

const decoded = {
  generatedAt: new Date().toISOString(),
  judgeReport: path.relative(root, reportPath),
  blindSetId: key.blindSetId,
  directTranslator: key.directTranslator,
  agentWorkflow: key.agentWorkflow,
  summary,
  groups,
  rows,
};

const mean = (items, dimension) =>
  items.find((item) => item.dimension === dimension).value.toFixed(2);
const groupLabels = {
  en_to_zh: "英译中",
  zh_to_en: "中译英",
  poetry: "诗歌",
  literary: "文学叙事",
  cultural_argument: "文化论辩",
  nonliterary: "非文学",
};

const markdown = `# GPT 盲评解码结果

> 本文件由盲态评分报告和私有 A/B 映射机械生成，不修改原评分。

## 总结果

- B-2：${summary.agentWins} 胜
- 直译：${summary.directWins} 胜
- 并列：${summary.ties}
- B-2 整体质量均分：${mean(summary.agentMeans, "整体质量")}
- 直译整体质量均分：${mean(summary.directMeans, "整体质量")}

| 维度 | B-2 | 直译 | 差值 |
|---|---:|---:|---:|
${dimensions
  .map((dimension) => {
    const agent = Number(mean(summary.agentMeans, dimension));
    const direct = Number(mean(summary.directMeans, dimension));
    return `| ${dimension} | ${agent.toFixed(2)} | ${direct.toFixed(2)} | ${(agent - direct).toFixed(2)} |`;
  })
  .join("\n")}

## 分组

| 分组 | 样本数 | B-2 胜 | 直译胜 | 并列 | B-2 整体均分 | 直译整体均分 |
|---|---:|---:|---:|---:|---:|---:|
${Object.entries(groups)
  .map(
    ([name, group]) =>
      `| ${groupLabels[name]} | ${group.count} | ${group.agentWins} | ${group.directWins} | ${group.ties} | ${mean(group.agentMeans, "整体质量")} | ${mean(group.directMeans, "整体质量")} |`,
  )
  .join("\n")}

## 逐项映射

| 样本 | Agent 位置 | 胜者 | B-2 整体分 | 直译整体分 |
|---|---|---|---:|---:|
${rows
  .map((row) => {
    const winner =
      row.winner === "agentic_b2"
        ? "B-2"
        : row.winner === "direct"
          ? "直译"
          : "并列";
    return `| ${String(row.sampleNo).padStart(2, "0")} · ${row.sampleId} | ${row.agentPosition} | ${winner} | ${row.agentScores[5]} | ${row.directScores[5]} |`;
  })
  .join("\n")}
`;

await Promise.all([
  fs.writeFile(outputJsonPath, `${JSON.stringify(decoded, null, 2)}\n`, "utf8"),
  fs.writeFile(outputMarkdownPath, markdown, "utf8"),
]);

console.log(
  JSON.stringify(
    {
      count: summary.count,
      agentWins: summary.agentWins,
      directWins: summary.directWins,
      ties: summary.ties,
      agentOverallMean: mean(summary.agentMeans, "整体质量"),
      directOverallMean: mean(summary.directMeans, "整体质量"),
      outputJsonPath,
      outputMarkdownPath,
    },
    null,
    2,
  ),
);
