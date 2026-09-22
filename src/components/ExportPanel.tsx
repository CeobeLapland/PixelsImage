import { useMemo, useState, type JSX } from 'react';

import { Row } from './Section';
import { NumberField, Toggle } from './controls';
import { composite } from '@/core/composite';
import { buildExportName, downloadBlob, exportGridPng } from '@/core/exporters/png';
import { useApp } from '@/state/store';

/** 导出倍率的常用档位 */
const SCALE_PRESETS = [1, 2, 4, 8, 16, 32];

export function ExportPanel(): JSX.Element {
  const baseGrid = useApp((s) => s.baseGrid);
  const editLayer = useApp((s) => s.editLayer);
  const editVersion = useApp((s) => s.editVersion);
  const palette = useApp((s) => s.palette);
  const source = useApp((s) => s.source);
  const info = useApp((s) => s.info);
  const pushToast = useApp((s) => s.pushToast);

  const [scale, setScale] = useState(1);
  const [opaque, setOpaque] = useState(false);
  const [busy, setBusy] = useState(false);

  const background = opaque ? '#ffffff' : 'transparent';

  // 导出的是**合成后**的网格：手工修改必须进 PNG，否则改了半天导出的还是原样。
  // 编辑层是就地修改的（引用不变），所以版本号必须进依赖表。
  const grid = useMemo(
    () => (baseGrid ? composite(baseGrid, editLayer) : null),
    [baseGrid, editLayer, editVersion],
  );

  const doExport = async () => {
    if (!grid || !source) return;
    setBusy(true);
    try {
      const blob = await exportGridPng(grid, palette, { scale, background });
      downloadBlob(blob, buildExportName(source.name, grid, scale));
      const px = `${grid.w * scale} × ${grid.h * scale}`;
      pushToast('info', `已导出 PNG（${px} px${scale > 1 ? `，${scale}× 放大` : ''}）`);
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : '导出失败');
    } finally {
      setBusy(false);
    }
  };

  if (!grid) {
    return (
      <div className="section__body">
        <p className="note">转换出结果后即可导出 PNG。</p>
      </div>
    );
  }

  return (
    <div className="section__body">
      <NumberField label="放大倍数" value={scale} min={1} max={64} onChange={setScale} />
      <div className="chips">
        {SCALE_PRESETS.map((k) => (
          <button
            key={k}
            type="button"
            className="chip"
            aria-pressed={scale === k}
            onClick={() => setScale(k)}
          >
            {k}×
          </button>
        ))}
      </div>

      <Toggle
        label="透明区填白底"
        value={opaque}
        title="GIF 或某些编辑器不认 alpha 时可打开"
        onChange={setOpaque}
      />

      <Row k="网格" v={`${grid.w} × ${grid.h}`} />
      <Row k="导出像素" v={`${grid.w * scale} × ${grid.h * scale}`} />
      {info?.trimmed && <Row k="已裁剪透明边" v="是" />}

      <button
        type="button"
        className="btn btn--primary btn--block"
        disabled={busy}
        onClick={() => void doExport()}
      >
        {busy ? '正在编码…' : '导出 PNG'}
      </button>

      <p className="note">
        1× 导出即为最终像素画（每格 1 像素）；放大导出用整数倍最近邻，
        每个像素精确变成 {scale}×{scale} 的方块，不会有插值模糊。
      </p>
    </div>
  );
}