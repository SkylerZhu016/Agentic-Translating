export interface AppliedEdit {
  old_string: string;
  new_string: string;
}

export function nextVersionText(currentText: string, appliedEdit: AppliedEdit): string {
  if (appliedEdit.old_string === appliedEdit.new_string) {
    return currentText;
  }
  return currentText;
}

export function diffSummary(oldText: string, newText: string): string {
  if (oldText === newText) return '(no change)';

  let prefixLen = 0;
  const minLen = Math.min(oldText.length, newText.length);
  while (prefixLen < minLen && oldText[prefixLen] === newText[prefixLen]) {
    prefixLen++;
  }

  let suffixLen = 0;
  const oldLen = oldText.length;
  const newLen = newText.length;
  while (
    suffixLen < minLen - prefixLen &&
    oldText[oldLen - 1 - suffixLen] === newText[newLen - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const MAX_CHANGED = 40;
  let oldChanged = oldText.substring(prefixLen, oldLen - suffixLen);
  let newChanged = newText.substring(prefixLen, newLen - suffixLen);
  if (oldChanged.length > MAX_CHANGED) oldChanged = oldChanged.substring(0, MAX_CHANGED) + '…';
  if (newChanged.length > MAX_CHANGED) newChanged = newChanged.substring(0, MAX_CHANGED) + '…';

  const contextBefore = oldText.substring(Math.max(0, prefixLen - 40), prefixLen);
  const contextAfter = oldText.substring(oldLen - suffixLen, Math.min(oldText.length, oldLen - suffixLen + 40));

  const before = contextBefore.length > 0 ? `…${contextBefore}` : '';
  const after = contextAfter.length > 0 ? `${contextAfter}…` : '';

  let summary = `Changed "${oldChanged}" → "${newChanged}"`;
  if (before || after) {
    summary += ` in context: ${before}[CHANGE]${after}`;
  }
  return summary;
}
