/**
 * 随机灵感面板（最后一个可选扩展）。
 *
 * 一次生成几张「风格明显不同」的预览，挑一张套用。
 * 生成过程不碰编辑器当前参数：只有点「用这张」才会写入设置，
 * 所以随时可以再看一眼别的、或者干脆不用。
 */

import { useEffect, useRef, useState, type JSX } from 'react';

import { gridToImageData } from '@/core/composite';
import type { VariantPreview } from '@/state/variants';
import { useApp } from '@/state/store';
import { Field } from './controls';
import { Row } from './Section';

/** 预览缩略图：网格本身就是 1 像素 1 格，直接 putImageData 再交给 CSS 放大 */
function VariantThumb({ preview }: { preview: VariantPreview }): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    canvas.width = preview.grid.w;
    canvas.height = preview.grid.h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.putImageData(gridToImageData(preview.grid, preview.palette), 0, 0);
  }, [preview]);

  return <canvas ref={ref} className="variant__canvas" />;
}

export function InspirationPanel(): JSX.Element {
  const source = useApp((s) => s.source);
  const generate = useApp((s) => s.generateRandomVariants);
  const patchSettings = useApp((s) => s.patchSettings);
  const setPalette = useApp((s) => s.setPalette);
  const pushToast = useApp((s) => s.pushToast);

  const [count, setCount] = useState(6);
  const [busy, setBusy] = useState(false);
  const [previews, setPreviews] = useState<VariantPreview[]>([]);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await generate(count);
      if (result.length > 0) setPreviews(result);
    } finally {
      setBusy(false);
    }
  };

  const apply = (preview: VariantPreview) => {
    patchSettings(preview.plan.settings);
    // 先把预览用的那块板放上去，画布不用等下一次转换才变
    setPalette(preview.palette);
    pushToast('info', `已套用：${preview.plan.label}（参数可在「转换」里继续调）`);
  };

  return (
    <div className="section__body">
      <p className="note">
        给当前源图随机组合参数与调色板，一次出几张风格不同的预览，
        挑一张「用这张」才写进转换参数。
      </p>

      <Row
        k="源图"
        v={source ? `${source.originalWidth} × ${source.originalHeight}` : '未载入'}
        muted={!source}
      />

      <Field label="变体数量" hint={String(count)}>
        <div className="chips">
          {[4, 6, 8].map((n) => (
            <button
              key={n}
              type="button"
              className="chip"
              aria-pressed={count === n}
              onClick={() => setCount(n)}
            >
              {n}
            </button>
          ))}
        </div>
      </Field>

      <button
        type="button"
        className="btn btn--primary btn--block"
        disabled={!source || busy}
        onClick={() => void run()}
      >
        {busy ? '正在生成…' : previews.length > 0 ? '换一批' : '生成一批'}
      </button>

      {previews.length > 0 && (
        <div className="variants">
          {previews.map((preview, i) => (
            <div className="variant" key={`${preview.plan.seed}-${i}`}>
              <div className="variant__art">
                <VariantThumb preview={preview} />
              </div>
              <div className="variant__meta">{preview.plan.label}</div>
              <button type="button" className="chip" onClick={() => apply(preview)}>
                用这张
              </button>
            </div>
          ))}
        </div>
      )}

      <p className="note note--tight">
        随机只做参数层面的扰动（尺寸 / 采样 / 抖动 / 温和的明暗饱和），
        不会随机开启去背景。生成用的是独立 Worker，编辑器当前结果不受影响。
      </p>
    </div>
  );
}
