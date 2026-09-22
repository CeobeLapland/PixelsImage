import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type JSX,
} from 'react';

import { ACCEPTED_TYPES, isProbablyImage } from '@/core/image';
import { useApp } from '@/state/store';
import { Dropzone } from './Dropzone';
import { Viewport } from './Viewport';

/**
 * 舞台：拥有整个画布区域的输入（拖拽、粘贴、文件选择），
 * 并根据是否已载入图片切换「空状态」与「视口」。
 */
export function Stage(): JSX.Element {
  const source = useApp((s) => s.source);
  const status = useApp((s) => s.sourceStatus);
  const error = useApp((s) => s.sourceError);
  const loadSource = useApp((s) => s.loadSource);
  const pushToast = useApp((s) => s.pushToast);

  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const [hot, setHot] = useState(false);

  /* 粘贴导入：Ctrl+V 直接贴剪贴板里的图 */
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const items = event.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        if (item.kind !== 'file') continue;
        const file = item.getAsFile();
        if (!file) continue;
        event.preventDefault();
        void loadSource(file, '剪贴板图片');
        return;
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [loadSource]);

  const openPicker = () => inputRef.current?.click();

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void loadSource(file);
    event.target.value = '';
  };

  /* 拖拽：用计数抵消子元素冒泡产生的 enter/leave 抖动 */
  const onDragEnter = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepthRef.current += 1;
    if (event.dataTransfer.types.includes('Files')) setHot(true);
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };

  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setHot(false);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepthRef.current = 0;
    setHot(false);

    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) return;
    const image = files.find(isProbablyImage) ?? files[0];
    if (image && isProbablyImage(image)) {
      void loadSource(image);
    } else {
      pushToast('error', '拖入的内容里没有能识别的图片文件');
    }
  };

  return (
    <div
      className="stage"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_TYPES}
        onChange={onFileChange}
        hidden
      />

      {source ? <Viewport source={source} /> : <Dropzone hot={hot} error={error} onPick={openPicker} />}

      {source && hot && <div className="stage__hot">松手以替换当前图片</div>}

      {status === 'decoding' && (
        <div className="decoding">
          <div className="decoding__inner">
            <span>正在解码图片…</span>
            <span className="decoding__bar">
              <i />
            </span>
          </div>
        </div>
      )}
    </div>
  );
}