/**
 * 反向解析面板（M10）。
 *
 * 给「手上已经有一张像素画、想继续改」的场景用：
 * 拖进图片 → 点一下 → 按图里实际的像素还原网格与调色板。
 * 不是转换流水线（那个方向是「高清 → 低分辨率」），所以不吃任何预处理参数。
 */

import { useState, type JSX } from 'react';

import type { ReverseResult } from '@/core/reverse';
import { useApp } from '@/state/store';
import { Row } from './Section';

export function ReversePanel(): JSX.Element {
  const source = useApp((s) => s.source);
  const reverseParseSource = useApp((s) => s.reverseParseSource);
  const [result, setResult] = useState<ReverseResult | null>(null);

  return (
    <div className="section__body">
      <p className="note">
        把一张已经是像素画的图（包括被放大 2×/4×/8× 保存的）还原成可编辑网格：
        按图里<b>实际像素</b>读，调色板取图里出现的颜色。
      </p>

      <button
        type="button"
        className="btn btn--primary btn--block"
        disabled={!source}
        onClick={() => setResult(reverseParseSource())}
      >
        按像素反解析当前源图
      </button>

      {!source && <p className="note note--tight">还没有源图：先把图片拖到画布上。</p>}

      {result && (
        <>
          <Row
            k="识别放大"
            v={result.scale > 1 ? `${result.scale}×` : '1×（原图即像素）'}
          />
          <Row k="网格" v={`${result.grid.w} × ${result.grid.h}`} />
          <Row
            k="颜色"
            v={
              `${result.palette.colors.length} 色` +
              (result.quantized ? `（原图 ${result.sourceColors} 色，已量化）` : '')
            }
          />
        </>
      )}

      <p className="note note--tight">
        反解析会清空当前结果、手改与撤销栈，并把转换参数对齐到解析出的网格
        （面积平均、不抖动、同一块板），之后再调参数重算仍然与它一致。
        图里颜色超过 256 种时会自动量化；抗锯齿 / 噪声图识别不出放大倍数，会按原始像素逐格还原。
      </p>
    </div>
  );
}
