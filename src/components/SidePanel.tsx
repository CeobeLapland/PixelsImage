import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';

import { formatBytes } from '@/core/image';
import { useApp } from '@/state/store';

/* --------------------------------------------------------------- 折叠分组 */

interface SectionProps {
  title: string;
  badge?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}

function Section({ title, badge, defaultOpen = true, children }: SectionProps): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="section">
      <button
        type="button"
        className="section__head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <h2>{title}</h2>
        {badge}
      </button>
      <div className="section__body" hidden={!open}>
        {children}
      </div>
    </section>
  );
}

function Row({ k, v, muted }: { k: string; v: ReactNode; muted?: boolean }): JSX.Element {
  return (
    <div className="kv">
      <span className="kv__k">{k}</span>
      <span className="kv__v" data-muted={muted ? 'true' : undefined}>
        {v}
      </span>
    </div>
  );
}

/* --------------------------------------------------------------- 源图缩略 */

function SourceThumb(): JSX.Element {
  const source = useApp((s) => s.source);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !source) return;
    const bitmap = source.previewBitmap;
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);
  }, [source]);

  if (!source) return <div className="thumb" />;
  return (
    <div className="thumb">
      <canvas ref={canvasRef} />
    </div>
  );
}

/* --------------------------------------------------------------- 里程碑 */

type MileState = 'done' | 'doing' | 'todo';

const MILESTONES: { id: string; label: string; state: MileState }[] = [
  { id: 'M0', label: '工程骨架与导入', state: 'doing' },
  { id: 'M1', label: '转换引擎', state: 'todo' },
  { id: 'M2', label: '像素编辑器', state: 'todo' },
  { id: 'M3', label: '调色板引擎', state: 'todo' },
  { id: 'M4', label: '智能辅助', state: 'todo' },
  { id: 'M5', label: '批量处理', state: 'todo' },
  { id: 'M6', label: '导出扩展', state: 'todo' },
  { id: 'M7', label: '打磨与存档', state: 'todo' },
];

/* --------------------------------------------------------------- 面板 */

export function SidePanel(): JSX.Element {
  const source = useApp((s) => s.source);
  const showGrid = useApp((s) => s.showGrid);
  const setShowGrid = useApp((s) => s.setShowGrid);
  const zoom = useApp((s) => s.view.zoom);
  const panelCollapsed = useApp((s) => s.panelCollapsed);

  const sourceBytes = source
    ? source.imageData.width * source.imageData.height * 4 +
      source.previewBitmap.width * source.previewBitmap.height * 4
    : 0;

  return (
    <aside className="panel" data-collapsed={panelCollapsed ? 'true' : undefined}>
      <div className="panel__scroll">
        <Section title="源图" badge={source ? <span className="badge">已载入</span> : undefined}>
          <SourceThumb />
          {source ? (
            <>
              <Row k="文件名" v={source.name} />
              <Row k="格式" v={source.type.replace('image/', '').toUpperCase()} muted />
              <Row k="文件大小" v={formatBytes(source.bytes)} muted />
              <Row
                k="原图尺寸"
                v={`${source.originalWidth} × ${source.originalHeight}`}
              />
              <Row
                k="源数据"
                v={`${source.imageData.width} × ${source.imageData.height}`}
              />
              <Row
                k="预览位图"
                v={`${source.previewBitmap.width} × ${source.previewBitmap.height}`}
                muted
              />
              <Row k="内存占用" v={`≈ ${formatBytes(sourceBytes)}`} muted />
              {source.truncated && (
                <p className="note note--warn">
                  原图超过处理上限（最长边 8192 px / 6400 万像素），源数据已降采样。
                  转换时无法还原到原始分辨率。
                </p>
              )}
            </>
          ) : (
            <p className="note">
              还没有载入图片。把文件拖到画布上，或按 <b>Ctrl+V</b> 粘贴。
            </p>
          )}
        </Section>

        <Section title="显示">
          <button
            type="button"
            className="toggle"
            aria-pressed={showGrid}
            onClick={() => setShowGrid(!showGrid)}
          >
            <span className="toggle__track" />
            <span>源像素网格</span>
          </button>
          <Row k="画布缩放" v={`${zoom >= 1 ? zoom.toFixed(2) : zoom.toFixed(3)}×`} />
          <p className="note">
            网格需要放大到 <b>8×</b> 以上才会绘制，否则会与像素本身产生摩尔纹。
            快捷键：<b>0</b> 适配窗口，<b>1</b> 原尺寸。
          </p>
        </Section>

        <Section title="实现进度" defaultOpen={false}>
          <ul className="milestones">
            {MILESTONES.map((m) => (
              <li key={m.id} data-state={m.state}>
                <span className="milestones__dot" />
                <span className="milestones__label">{m.label}</span>
                <span className="milestones__tag">{m.id}</span>
              </li>
            ))}
          </ul>
          <p className="note">
            当前处于 <b>M0</b>：导入与查看已可用，转换引擎在 M1 接入。
            绘图工具在工具栏中占位但未启用。
          </p>
        </Section>
      </div>
    </aside>
  );
}