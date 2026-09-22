/**
 * 主线程 ↔ Worker 的消息协议。
 * 单独成文件是为了让两端都能 import，且不把 worker 代码拉进主包。
 */

import type { ConvertSettings, Palette } from '../types';

export type WorkerRequest =
  | {
      type: 'source';
      id: string;
      width: number;
      height: number;
      /** 源图 RGBA 缓冲，转移所有权 */
      buffer: ArrayBuffer;
    }
  | {
      type: 'convert';
      id: number;
      sourceId: string;
      settings: ConvertSettings;
      palette: Palette;
      fast: boolean;
    }
  | { type: 'release' };

export type WorkerResponse =
  | { type: 'source-ack'; id: string }
  | {
      type: 'result';
      id: number;
      w: number;
      h: number;
      indices: ArrayBuffer;
      alpha: ArrayBuffer;
      targetW: number;
      targetH: number;
      usedColors: number;
      trimmed: boolean;
      ms: number;
    }
  | { type: 'error'; id: number; message: string };