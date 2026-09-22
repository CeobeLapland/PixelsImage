/**
 * 剪贴板导出（M6）。
 *
 * 单开一个文件的理由：剪贴板 API 有两处容易踩的坑，集中在这里处理，
 * 免得散落在面板里各写一遍。
 * - 必须是**安全上下文**（https 或 localhost），`file://` 打开时 navigator.clipboard 是 undefined；
 * - 写图片用的是异步 ClipboardItem，浏览器只在用户手势的同一轮任务里才允许写，
 *   所以调用方必须直接挂在点击事件上，不能包在 await 之后再写。
 */

/** 浏览器是否支持把图片写进剪贴板 */
export function canCopyImage(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.clipboard !== 'undefined' &&
    typeof ClipboardItem !== 'undefined' &&
    navigator.clipboard.write !== undefined
  );
}

/** 浏览器是否支持写文本 */
export function canCopyText(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.clipboard !== 'undefined' &&
    typeof navigator.clipboard.writeText === 'function'
  );
}

export async function copyPngToClipboard(blob: Blob): Promise<void> {
  if (!canCopyImage()) {
    throw new Error('当前环境不支持把图片写入剪贴板（需要 https 或 localhost）');
  }
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

export async function copyTextToClipboard(text: string): Promise<void> {
  if (!canCopyText()) {
    throw new Error('当前环境不支持写入剪贴板（需要 https 或 localhost）');
  }
  await navigator.clipboard.writeText(text);
}
