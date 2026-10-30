/**
 * 随机灵感的执行层：用一条**独立的** Worker 流水线跑一批变体。
 *
 * 为什么不复用编辑器那条 `PipelineRunner`：它会把待处理请求合并成最新一条
 * （为拖滑块设计），一批变体互相顶掉，最后只能拿到最后一张。
 * 也不复用批量转换器：那边是给用户排队的，灵感器只是随手看一眼，
 * 两边共用会让「批量正在跑」时灵感器直接报错。
 */

import type { ConvertSettings, Palette, PixelGrid, RGBAImage } from '@/core/types';
import type { VariantPlan } from '@/core/random/variant';
import { PipelineRunner, type ConvertOutcome } from '@/core/workers/client';

export interface VariantPreview {
  plan: VariantPlan;
  /** 产出这张网格时实际使用的调色板（k-means 模式下是现场聚出来的那块） */
  palette: Palette;
  grid: PixelGrid;
  usedColors: number;
  ms: number;
}

export class VariantConverter {
  private runner = new PipelineRunner();
  private waiting: {
    resolve: (outcome: ConvertOutcome) => void;
    reject: (error: Error) => void;
  } | null = null;

  constructor() {
    this.runner.subscribe(
      (outcome) => {
        const waiting = this.waiting;
        this.waiting = null;
        waiting?.resolve(outcome);
      },
      (message) => {
        const waiting = this.waiting;
        this.waiting = null;
        waiting?.reject(new Error(message));
      },
    );
  }

  /** 串行转换一张；与 BatchConverter 同一套约定（不能并行调用） */
  convert(image: RGBAImage, settings: ConvertSettings, palette: Palette): Promise<ConvertOutcome> {
    if (this.waiting) {
      return Promise.reject(new Error('灵感生成器正在处理上一张，请勿并行调用'));
    }

    this.runner.setSource({
      id: `variant-${Date.now().toString(36)}`,
      width: image.width,
      height: image.height,
      data: image.data,
    });

    return new Promise<ConvertOutcome>((resolve, reject) => {
      this.waiting = { resolve, reject };
      this.runner.request(settings, palette, false);
    });
  }

  dispose(): void {
    this.runner.dispose();
  }
}

let singleton: VariantConverter | null = null;

export function getVariantConverter(): VariantConverter {
  if (!singleton) singleton = new VariantConverter();
  return singleton;
}
