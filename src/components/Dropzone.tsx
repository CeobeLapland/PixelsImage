import { useRef, type ChangeEvent, type JSX } from 'react';

import { PROJECT_EXTENSION } from '@/core/project';
import { useApp } from '@/state/store';
import { DROP_MARK, PixelIcon } from './PixelIcon';

interface DropzoneProps {
  /** 正在拖拽悬停 */
  hot: boolean;
  /** 上一次解码失败的原因 */
  error: string | null;
  onPick: () => void;
}

/**
 * 空状态。
 *
 * 除了「拖图进来」，这里还承担**首次使用的引导**：新用户面对一屏参数
 * 最容易卡在「我该先干什么」。所以按真实流程写三步，并且把「打开上次的存档」
 * 也放在这里 —— 它是第二次打开工具时最可能的入口，藏在顶栏小按钮里不合适。
 */
export function Dropzone({ hot, error, onPick }: DropzoneProps): JSX.Element {
  const loadProjectFile = useApp((s) => s.loadProjectFile);
  const projectBusy = useApp((s) => s.projectBusy);
  const setShortcutsOpen = useApp((s) => s.setShortcutsOpen);
  const projectRef = useRef<HTMLInputElement>(null);

  const onProject = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void loadProjectFile(file);
  };

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

        <div className="dropzone__actions">
          <button type="button" className="btn btn--primary" onClick={onPick}>
            选择文件…
          </button>
          <input
            ref={projectRef}
            type="file"
            accept={`${PROJECT_EXTENSION},application/json`}
            hidden
            onChange={onProject}
          />
          <button
            type="button"
            className="btn"
            disabled={projectBusy}
            title={`打开一个 ${PROJECT_EXTENSION} 存档，含上次的参数、调色板与手工修改`}
            onClick={() => projectRef.current?.click()}
          >
            {projectBusy ? '打开中…' : '打开存档'}
          </button>
        </div>

        <ol className="dropzone__steps">
          <li>
            <b>1</b> 拖入高清图 → 右侧「转换」里定目标格数（先试 <b>32</b>）
          </li>
          <li>
            <b>2</b> 选调色板与抖动算法，画布上直接看效果；满意了再动笔
          </li>
          <li>
            <b>3</b> 手改若干格 → 右侧「导出」出 PNG，或「存档」把整份工作留下来
          </li>
        </ol>

        <p className="dropzone__hint">
          图片只在本机处理，不会上传 · 按 <kbd>?</kbd> 看全部快捷键
          <button type="button" className="linkbtn" onClick={() => setShortcutsOpen(true)}>
            快捷键
          </button>
        </p>
        {error && <div className="dropzone__err">{error}</div>}
      </div>
    </div>
  );
}