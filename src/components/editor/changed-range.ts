// ---------------------------------------------------------------------------
// changedRange —— 计算两文本的最小变更区间（公共前缀/后缀裁剪）
// 用于编辑完成后在 final-text 中高亮被替换的片段（与 versions.diffSummary
// 同一裁剪思路，但返回偏移量而非文案）。
// ---------------------------------------------------------------------------

export interface ChangedRange {
  /** 变更起点（新文本偏移，含） */
  start: number
  /** 变更终点（新文本偏移，不含） */
  end: number
}

export function changedRange(oldText: string, newText: string): ChangedRange | null {
  if (oldText === newText) return null

  let prefixLen = 0
  const minLen = Math.min(oldText.length, newText.length)
  while (prefixLen < minLen && oldText[prefixLen] === newText[prefixLen]) {
    prefixLen++
  }

  let suffixLen = 0
  while (
    suffixLen < minLen - prefixLen &&
    oldText[oldText.length - 1 - suffixLen] === newText[newText.length - 1 - suffixLen]
  ) {
    suffixLen++
  }

  return { start: prefixLen, end: newText.length - suffixLen }
}
