/**
 * Worker 客户端：请求合并 + 结果订阅 + 无 Worker 环境降级。
 *
 * 请求合并是本模块存在的核心理由：
 * 拖动「目标格数」滑块会在几百毫秒内产生几十次转换请求。
 * Worker 是单线程的，全部排队会导致预览严重滞后（改完参数要等好几秒才看到结果）。
 * 所以这里只保留**最新**的一个待处理请求，中间的丢弃 —— 用户只关心最终值。
 */

import { convert } from '../pipeline';
import type { ConvertSettings, Palette, PixelGrid } from '../types';
import type { WorkerRequest, WorkerResponse } from './protocol';

export interface ConvertOutcome {
  sourceId: string;
  grid: PixelGrid;
  /** 产出这份网格时实际使用的调色板。
   *  必须随结果一起带回：否则用户快速切换调色板时，
   *  先到的旧网格会被用新调色板渲染，出现一瞬间的错误颜色。 */
  palette: Palette;
  targetW: number;
  targetH: number;
  usedColors: number;
  trimmed: boolean;
  /** 转换耗时（毫秒），用于状态栏显示 */
  ms: number;
  /** 是否走了主线程降级路径 */
  fallback: boolean;
}

interface PendingRequest {
  settings: ConvertSettings;
  palette: Palette;
  fast: boolean;
}

type OutcomeListener = (outcome: ConvertOutcome) => void;
type ErrorListener = (message: string) => void;

export class PipelineRunner {
  private worker: Worker | null = null;
  private workerBroken = false;

  private seq = 1;
  /** 正在处理的请求 id；0 表示空闲 */
  private inflightId = 0;
  /** 正在处理的请求所用调色板，随结果回传 */
  private inflightPalette: Palette | null = null;
  private pending: PendingRequest | null = null;

  private source: {
    id: string;
    width: number;
    height: number;
    data: Uint8ClampedArray;
  } | null = null;

  private onOutcome: OutcomeListener | null = null;
  private onError: ErrorListener | null = null;

  constructor() {
    this.tryCreateWorker();
  }

  private tryCreateWorker(): void {
    if (typeof Worker === 'undefined') {
      this.workerBroken = true;
      return;
    }
    try {
      this.worker = new Worker(new URL('./pipeline.worker.ts', import.meta.url), {
        type: 'module',
      });
      this.worker.onmessage = (event: MessageEvent<WorkerResponse>) =>
        this.handleMessage(event.data);
      this.worker.onerror = () => {
        // Worker 挂掉（例如脚本加载失败）→ 永久降级到主线程，避免反复失败
        this.workerBroken = true;
        this.worker?.terminate();
        this.worker = null;
        this.inflightId = 0;
        this.onError?.('转换进程异常，已切换到主线程处理（拖动参数可能略有卡顿）');
        this.pump();
      };
    } catch {
      this.workerBroken = true;
      this.worker = null;
    }
  }

  private handleMessage(msg: WorkerResponse): void {
    if (msg.type === 'source-ack') return;

    if (msg.type === 'error') {
      if (msg.id === this.inflightId) this.inflightId = 0;
      this.onError?.(msg.message);
      this.pump();
      return;
    }

    // 迟到的结果：源图已换或已被新请求取代，直接丢弃
    const stale = msg.id !== this.inflightId;
    const palette = this.inflightPalette;
    this.inflightId = 0;
    this.inflightPalette = null;

    if (!stale && this.source && palette) {
      this.onOutcome?.({
        sourceId: this.source.id,
        grid: {
          w: msg.w,
          h: msg.h,
          indices: new Uint8Array(msg.indices),
          alpha: new Uint8Array(msg.alpha),
        },
        palette,
        targetW: msg.targetW,
        targetH: msg.targetH,
        usedColors: msg.usedColors,
        trimmed: msg.trimmed,
        ms: msg.ms,
        fallback: false,
      });
    }

    this.pump();
  }

  /** 有开销上限的降级路径：直接在主线程算 */
  private runLocally(request: PendingRequest): void {
    const source = this.source;
    if (!source) return;

    const started = performance.now();
    try {
      const result = convert(
        { width: source.width, height: source.height, data: source.data },
        request.settings,
        request.palette,
        { fast: request.fast },
      );
      this.onOutcome?.({
        sourceId: source.id,
        grid: result.grid,
        palette: request.palette,
        targetW: result.targetW,
        targetH: result.targetH,
        usedColors: result.usedColors,
        trimmed: result.trimmed,
        ms: performance.now() - started,
        fallback: true,
      });
    } catch (err) {
      this.onError?.(err instanceof Error ? err.message : '转换失败');
    }
  }

  /** 有空闲就取出待处理请求执行 */
  private pump(): void {
    if (this.inflightId !== 0) return;
    const next = this.pending;
    if (!next || !this.source) return;
    this.pending = null;
    this.dispatch(next);
  }

  private dispatch(request: PendingRequest): void {
    if (!this.source) return;

    if (this.workerBroken || !this.worker) {
      this.runLocally(request);
      return;
    }

    const id = this.seq;
    this.seq += 1;
    this.inflightId = id;
    this.inflightPalette = request.palette;

    const message: WorkerRequest = {
      type: 'convert',
      id,
      sourceId: this.source.id,
      settings: request.settings,
      palette: request.palette,
      fast: request.fast,
    };
    this.worker.postMessage(message);
  }

  /* --------------------------------------------------------------- 公开 API */

  setSource(source: {
    id: string;
    width: number;
    height: number;
    data: Uint8ClampedArray;
  }): void {
    // 换图后所有旧请求作废
    this.pending = null;
    this.inflightId = 0;
    this.inflightPalette = null;
    this.source = {
      id: source.id,
      width: source.width,
      height: source.height,
      data: source.data,
    };

    if (this.workerBroken || !this.worker) return;

    // 复制一份并转移所有权；主线程保留自己的 ImageData 以便重新导入或做其他处理
    const copy = new Uint8ClampedArray(source.data);
    const message: WorkerRequest = {
      type: 'source',
      id: source.id,
      width: source.width,
      height: source.height,
      buffer: copy.buffer as ArrayBuffer,
    };
    this.worker.postMessage(message, [copy.buffer as ArrayBuffer]);
  }

  request(settings: ConvertSettings, palette: Palette, fast: boolean): void {
    if (!this.source) return;
    // 覆盖式排队：只保留最新一次参数，中间的丢弃
    this.pending = { settings, palette, fast };
    this.pump();
  }

  subscribe(onOutcome: OutcomeListener, onError: ErrorListener): () => void {
    this.onOutcome = onOutcome;
    this.onError = onError;
    return () => {
      this.onOutcome = null;
      this.onError = null;
    };
  }

  get isFallback(): boolean {
    return this.workerBroken;
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.source = null;
    this.pending = null;
    this.inflightId = 0;
    this.inflightPalette = null;
  }
}

let singleton: PipelineRunner | null = null;

export function getPipelineRunner(): PipelineRunner {
  if (!singleton) singleton = new PipelineRunner();
  return singleton;
}