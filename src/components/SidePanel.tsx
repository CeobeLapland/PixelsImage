import { useEffect, useRef, type JSX } from 'react';

import { formatBytes } from '@/core/image';
import { useApp } from '@/state/store';
import { ComparePanel } from './ComparePanel';
import { ConvertPanel } from './ConvertPanel';
import { ExportPanel } from './ExportPanel';
import { ExtractPanel } from './ExtractPanel';
import { LayerPanel } from './LayerPanel';
import { PaletteIoPanel } from './PaletteIoPanel';
import { PalettePanel } from './PalettePanel';
import { Row, Section } from './Section';

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
  { id: 'M0', label: '工程骨架与导入', state: 'done' },
  { id: 'M1', label: '转换引擎', state: 'done' },
  { id: 'M2', label: '像素编辑器', state: 'done' },
  { id: 'M3', label: '调色板引擎', state: 'done' },
  { id: 'M4', label: '智能辅助', state: 'doing' },
  { id: 'M5', label: '批量处理', state: 'todo' },
  { id: 'M6', label: '导出扩展', state: 'todo' },
  { id: 'M7', label: '打磨与存档', state: 'todo' },
];

/* --------------------------------------------------------------- 面板 */

export function SidePanel(): JSX.Element {
  const source = useApp((s) => s.source);
  const panelCollapsed = useApp((s) => s.panelCollapsed);
  const info = useApp((s) => s.info);
  const converting = useApp((s) => s.converting);
  const convertError = useApp((s) => s.convertError);
  const hasResult = useApp((s) => s.baseGrid !== null);
  const editedCount = useApp((s) => s.editedCount);
  const palette = useApp((s) => s.palette);

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
              <Row k="原图尺寸" v={`${source.originalWidth} × ${source.originalHeight}`} />
              <Row k="源数据" v={`${source.imageData.width} × ${source.imageData.height}`} />
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

        <Section
          title="转换"
          badge={converting ? <span className="badge">计算中</span> : undefined}
        >
          <ConvertPanel />
        </Section>

        <Section
          title="编辑"
          badge={editedCount > 0 ? <span className="badge">{editedCount} 格手改</span> : undefined}
        >
          <LayerPanel />
        </Section>

        <Section
          title="调色板"
          badge={<span className="badge">{palette.colors.length} 色</span>}
        >
          <PalettePanel />
        </Section>

        <Section title="提取主色" defaultOpen={false}>
          <ExtractPanel />
        </Section>

        <Section title="调色板文件" defaultOpen={false}>
          <PaletteIoPanel />
        </Section>

        <Section title="对照与显示">
          <ComparePanel />
        </Section>

        <Section title="导出" badge={hasResult ? <span className="badge">就绪</span> : undefined}>
          <ExportPanel />
        </Section>

        {hasResult && info && (
          <Section title="转换结果" defaultOpen={false}>
            <Row k="网格尺寸" v={`${info.targetW} × ${info.targetH}`} />
            <Row k="实际用色" v={`${info.usedColors} 种`} />
            <Row k="耗时" v={`${info.ms.toFixed(1)} ms`} muted />
            {info.trimmed && <Row k="含裁剪" v="尺寸已收缩" muted />}
            {convertError && <p className="note note--warn">{convertError}</p>}
          </Section>
        )}

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
            当前处于 <b>M3</b>：调色板可提色、可导入导出、可逐槽改色、可一键全局换色。
            像素编辑器（M2）与调色板引擎（M3）都已可用。
          </p>
        </Section>
      </div>
    </aside>
  );
}