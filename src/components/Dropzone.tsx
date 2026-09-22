import type { JSX } from 'react';

import { DROP_MARK, PixelIcon } from './PixelIcon';

interface DropzoneProps {
  /** 正在拖拽悬停 */
  hot: boolean;
  /** 上一次解码失败的原因 */
  error: string | null;
  onPick: () => void;
}

export function Dropzone({ hot, error, onPick }: DropzoneProps): JSX.Element {
  return (
    <div className="dropzone" data-hot={hot}>
      <div className="dropzone__inner">
        <PixelIcon rows={DROP_MARK} size={54} className="dropzone__markIcon" />
        <h1 className="dropzone__title">把图片拖进来</h1>
        <p className="dropzone__desc">
          支持 PNG / JPEG / WebP / GIF / BMP
          <br />
          也可以按 <kbd>Ctrl</kbd> + <kbd>V</kbd> 粘贴剪贴板里的图
        </p>
        <button type="button" className="btn" onClick={onPick}>
          选择文件…
        </button>
        <p className="dropzone__hint">图片只在本机处理，不会上传</p>
        {error && <div className="dropzone__err">{error}</div>}
      </div>
    </div>
  );
}