/**
 * 让出主线程到下一个宏任务，使 Vue/Monaco 有机会提交 DOM 更新。
 * 移植自 ColorTxt 的 ebook/yieldToUi.ts。
 */
export function yieldToUi () {
  return new Promise(resolve => setTimeout(resolve, 0))
}
