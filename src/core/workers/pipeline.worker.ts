/// <reference lib="webworker" />

/**
 * 转换 Worker。
 *
 * 协议设计要点：**源图只传一次**。
 * 转换参数每拖动一次滑块就要重算一帧，如果每次请求都把源图缓冲传过来，
 * 一张 4K 图就是每帧 33MB 的内存拷贝。所以源图在 source 消息里传一次，
 * Worker 常驻持有，后续 convert 请求只带参数。
 *
 * 消息类型见 ./protocol.ts。
 */

import { convert } from '../pipeline';
import type { ConvertSettings, Palette } from '../types';
import type { WorkerRequest, WorkerResponse } from './protocol';

/**
 * 在模块作用域下 TS 会把 `self` 推断成 Window（lib.dom 同时声明了两者），
 * 于是 postMessage 的签名对不上。显式收窄一次，之后就不用到处断言。
 */
const ctx = self as unknown as DedicatedWorkerGlobalScope;

let held: { id: string; data: Uint8ClampedArray; width: number; height: number } | null = null;

function post(message: WorkerResponse, transfer?: Transferable[]): void {
  if (transfer && transfer.length > 0) {
    ctx.postMessage(message, transfer);
  } else {
    ctx.postMessage(message);
  }
}

ctx.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;

  switch (msg.type) {
    case 'source': {
      held = {
        id: msg.id,
        data: new Uint8ClampedArray(msg.buffer),
        width: msg.width,
        height: msg.height,
      };
      post({ type: 'source-ack', id: msg.id });
      break;
    }

    case 'release': {
      held = null;
      break;
    }

    case 'convert': {
      if (!held || held.id !== msg.sourceId) {
        post({
          type: 'error',
          id: msg.id,
          message: 'Worker 中缺少对应的源图数据，请重新导入图片',
        });
        break;
      }

      try {
        const settings: ConvertSettings = msg.settings;
        const palette: Palette = msg.palette;

        const started = performance.now();
        const result = convert(
          { width: held.width, height: held.height, data: held.data },
          settings,
          palette,
          { fast: msg.fast },
        );
        const ms = performance.now() - started;

        post(
          {
            type: 'result',
            id: msg.id,
            w: result.grid.w,
            h: result.grid.h,
            indices: result.grid.indices.buffer as ArrayBuffer,
            alpha: result.grid.alpha.buffer as ArrayBuffer,
            targetW: result.targetW,
            targetH: result.targetH,
            usedColors: result.usedColors,
            trimmed: result.trimmed,
            ms,
          },
          // 把结果缓冲转移回主线程，零拷贝
          [
            result.grid.indices.buffer as ArrayBuffer,
            result.grid.alpha.buffer as ArrayBuffer,
          ],
        );
      } catch (err) {
        post({
          type: 'error',
          id: msg.id,
          message: err instanceof Error ? err.message : '转换失败',
        });
      }
      break;
    }

    default:
      break;
  }
};