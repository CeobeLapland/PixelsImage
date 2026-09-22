import { useState, type JSX } from 'react';

import { bandSlots } from '@/core/assists/shade';
import { toHex } from '@/core/color/space';
import { useApp } from '@/state/store';
import { Field, Segmented, Slider, Toggle } from './controls';
import { Row } from './Section';

const NEIGHBOR_OPTIONS = [
  { value: '4', label: '四邻域', title: '只认上下左右，轮廓更细' },
  { value: '8', label: '八邻域', title: '含对角，转角处不会断开' },
] as const;

const SIDE_OPTIONS = [
  { value: 'outside', label: '外缘', title: '只在形状外面加一圈（最常用）' },
  { value: 'inside', label: '内缘', title: '把形状最外一圈染成轮廓色（形状尺寸不变）' },
  { value: 'both', label: '两侧', title: '里外各一圈，轮廓更粗更实' },
] as const;

/**
 * 智能辅助（M4）：出草稿之后的收尾工作。
 *
 * 三个功能都作用于**编辑层**，因此都能 Ctrl+Z 撤销、也都不受转换参数影响。
 * 它们不追求「一键出神图」，而是把最费手的重复劳动（描一圈边、
 * 把明暗压成三层、检查贴图接缝）变成一次点击，剩下的细节仍旧手调。
 */
export function AssistsPanel(): JSX.Element {
  const runOutline = useApp((s) => s.runOutline);
  const runShade = useApp((s) => s.runShade);
  const runSeamCheck = useApp((s) => s.runSeamCheck);
  const foreground = useApp((s) => s.foreground);
  const palette = useApp((s) => s.palette);
  const hasGrid = useApp((s) => s.baseGrid !== null);
  const tilePreview = useApp((s) => s.tilePreview);
  const setTilePreview = useApp((s) => s.setTilePreview);
  const seam = useApp((s) => s.seam);

  const [diagonal, setDiagonal] = useState<'4' | '8'>('8');
  const [side, setSide] = useState<'outside' | 'inside' | 'both'>('outside');
  const [darkMax, setDarkMax] = useState(33);
  const [lightMin, setLightMin] = useState(66);

  const fg = palette.colors[foreground];
  const slots = bandSlots(palette, { darkMax: darkMax / 100, lightMin: lightMin / 100 });

  return (
    <div className="section__body">
      {/* ---------------- 自动描边 ---------------- */}
      <Field label="轮廓颜色" hint={`前景 #${foreground}`}>
        <div className="colorslot__item">
          <i className="colorslot__chip" style={{ backgroundColor: fg ? toHex(fg[0], fg[1], fg[2]) : 'transparent' }} />
          <span className="colorslot__label">在「调色板」里左键点色块即可换色</span>
        </div>
      </Field>
      <Segmented
        label="邻域"
        value={diagonal}
        options={NEIGHBOR_OPTIONS}
        columns={2}
        onChange={(v) => setDiagonal(v)}
      />
      <Segmented label="位置" value={side} options={SIDE_OPTIONS} columns={3} onChange={setSide} />
      <button
        type="button"
        className="btn btn--primary btn--block"
        disabled={!hasGrid}
        title="给所有非透明区域勾一圈轮廓；结果写进手改层，可撤销"
        onClick={() =>
          runOutline({
            color: foreground,
            diagonal: diagonal === '8',
            mode: side,
          })
        }
      >
        应用描边
      </button>

      {/* ---------------- 自动明暗分层 ---------------- */}
      <Slider
        label="暗部上限"
        value={darkMax}
        min={0}
        max={100}
        format={(v) => `${v}%`}
        onChange={setDarkMax}
      />
      <Slider
        label="亮部下限"
        value={lightMin}
        min={0}
        max={100}
        format={(v) => `${v}%`}
        onChange={setLightMin}
      />
      <Row k="调色板明暗分布" v={`暗 ${slots.darkSlots} · 中 ${slots.midSlots} · 亮 ${slots.lightSlots}`} />
      <button
        type="button"
        className="btn btn--primary btn--block"
        disabled={!hasGrid || slots.darkSlots + slots.midSlots + slots.lightSlots === 0}
        title="按亮度把每个像素归到阴影/中间调/高光，把颜色缩放到该档的目标亮度，再就近映射到调色板 —— 压明暗层次，尽量不改色相"
        onClick={() => runShade({ darkMax: darkMax / 100, lightMin: lightMin / 100 })}
      >
        应用明暗分层
      </button>
      <p className="note">
        做法是「把颜色缩放到该档的目标亮度，再在<b>整块调色板</b>里找最接近的色」 ——
        只在同档里挑候选是不行的：那样最近的永远是它自己，功能等于没做；
        要么就只能换成同亮度的别的色相，把画面搅乱。
        纯黑与纯白会被跳过（缩放公式在那里没有意义）。
        上面的「明暗分布」只是告诉你调色板里各档有多少色可用。
      </p>

      {/* ---------------- 平铺与接缝 ---------------- */}
      <div className="section__body" style={{ padding: 0 }}>
        <Toggle
          label="3×3 平铺预览"
          value={tilePreview}
          title="把像素图按九宫格重复绘制，直接看无缝平铺的效果（仅在「仅结果」视图生效）"
          onChange={setTilePreview}
        />
        <button
          type="button"
          className="btn btn--block"
          disabled={!hasGrid}
          title="左右、上下边界各比一遍，对不上的格子会在画布上标出来"
          onClick={runSeamCheck}
        >
          检查平铺接缝
        </button>
        {seam && (
          <Row
            k="接缝结果"
            v={seam.mismatches === 0 ? `全部匹配（${seam.total} 对）` : `${seam.mismatches} 处不匹配`}
          />
        )}
      </div>

      <p className="note">
        所有辅助操作都写进手改层，<b>每一个都能 Ctrl+Z 撤销</b>，也不会被转换参数重算冲掉。
        原图叠加对照（onion skin）在「编辑」分组里。
      </p>
    </div>
  );
}