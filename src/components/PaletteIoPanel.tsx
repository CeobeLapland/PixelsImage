import { useRef, type ChangeEvent, type JSX } from 'react';

import { imageDataToPngBlob, downloadBlob } from '@/core/exporters/png';
import { PALETTE_MAX_COLORS, type Palette } from '@/core/types';
import { parsePaletteText, serializeGplPalette, serializeHexPalette } from '@/palettes/parse';
import { useApp } from '@/state/store';
import { Row } from './Section';

/** 色条 PNG 里每格画多大、每行放几个 */
const BAR_CELL = 24;
const BAR_COLUMNS = 8;

function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'palette';
}

/** 调色板 → 色条 PNG（每格一个方块，带细黑边框，方便肉眼比对） */
function renderColorBar(palette: Palette): ImageData {
  const n = palette.colors.length;
  const cols = Math.min(BAR_COLUMNS, Math.max(1, n));
  // 至少留一行：ImageData 不允许高度为 0，空板会把导出直接炸掉
  const rows = Math.max(1, Math.ceil(n / cols));
  const w = cols * BAR_CELL;
  const h = rows * BAR_CELL;
  const data = new Uint8ClampedArray(w * h * 4);

  for (let i = 0; i < n; i += 1) {
    const c = palette.colors[i];
    if (!c) continue;
    const cx = (i % cols) * BAR_CELL;
    const cy = Math.floor(i / cols) * BAR_CELL;
    for (let y = 0; y < BAR_CELL; y += 1) {
      for (let x = 0; x < BAR_CELL; x += 1) {
        // 每格的最外圈画成深色，格子之间才有分界
        const edge = x === 0 || y === 0 || x === BAR_CELL - 1 || y === BAR_CELL - 1;
        const o = ((cy + y) * w + cx + x) * 4;
        data[o] = edge ? 16 : c[0];
        data[o + 1] = edge ? 18 : c[1];
        data[o + 2] = edge ? 21 : c[2];
        data[o + 3] = 255;
      }
    }
  }
  return new ImageData(data, w, h);
}

/**
 * 调色板文件的导入与导出。
 *
 * 导入的板一律登记为自定义板，不覆盖同名内置板 —— 用户拿到一份「别人的板」时
 * 不该把内置数据改掉，那样下次想用原版就回不去了。
 */
export function PaletteIoPanel(): JSX.Element {
  const palette = useApp((s) => s.palette);
  const addCustomPalette = useApp((s) => s.addCustomPalette);
  const pushToast = useApp((s) => s.pushToast);
  const copyPaletteText = useApp((s) => s.copyPaletteText);

  const inputRef = useRef<HTMLInputElement>(null);

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    const text = await file.text();
    const colors = parsePaletteText(text, file.name);
    if (!colors) {
      pushToast('error', `「${file.name}」不是能识别的调色板文件（支持 .hex / .gpl / .pal）`);
      return;
    }
    if (colors.length > PALETTE_MAX_COLORS) {
      pushToast('warn', `文件里有 ${colors.length} 个颜色，只保留前 ${PALETTE_MAX_COLORS} 个`);
    }
    addCustomPalette({
      id: 'imported',
      name: file.name.replace(/\.[^.]+$/, '').slice(0, 40) || '导入的调色板',
      colors,
      source: 'imported',
    });
  };

  const exportAs = async (kind: 'hex' | 'gpl' | 'png') => {
    const base = safeName(palette.name);
    try {
      if (kind === 'png') {
        const blob = await imageDataToPngBlob(renderColorBar(palette));
        downloadBlob(blob, `${base}.png`);
      } else {
        const text =
          kind === 'hex'
            ? serializeHexPalette(palette.colors, palette.name)
            : serializeGplPalette(palette.colors, palette.name);
        downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), `${base}.${kind}`);
      }
      pushToast('info', `已导出 ${base}.${kind}（${palette.colors.length} 色）`);
    } catch (err) {
      pushToast('error', err instanceof Error ? err.message : '导出失败');
    }
  };

  return (
    <div className="section__body">
      <input
        ref={inputRef}
        type="file"
        accept=".hex,.gpl,.pal,.txt"
        hidden
        onChange={(e) => void onFile(e)}
      />
      <button
        type="button"
        className="btn btn--primary btn--block"
        onClick={() => inputRef.current?.click()}
      >
        导入调色板文件…
      </button>

      <Row k="当前板" v={palette.name} />
      <Row k="颜色数" v={palette.colors.length} />

      <div className="chips chips--actions">
        <button type="button" className="chip" onClick={() => void exportAs('hex')}>
          导出 .hex
        </button>
        <button type="button" className="chip" onClick={() => void exportAs('gpl')}>
          导出 .gpl
        </button>
      </div>
      <button type="button" className="btn btn--block" onClick={() => void exportAs('png')}>
        导出色条 PNG
      </button>
      <button
        type="button"
        className="btn btn--block"
        title="每行一个 #RRGGBB，可直接粘进代码或聊天窗"
        onClick={() => void copyPaletteText()}
      >
        复制色值到剪贴板
      </button>

      <p className="note">
        支持 <b>.hex</b>（每行一个色值，最常见的交换格式）、<b>.gpl</b>（GIMP Palette）、
        <b>.pal</b>（JASC-PAL）。导入的板会成为一块自定义板，不会覆盖同名内置板。
      </p>
    </div>
  );
}