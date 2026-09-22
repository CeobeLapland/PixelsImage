/**
 * 把「源图 / 转换参数」与 Worker 连起来的胶水层。
 *
 * 单独成 hook 而不是塞进 store，是因为它需要依赖 React 的生命周期来订阅/退订，
 * 而 store 本身要保持与 React 无关（画布事件要在 React 之外读写 store）。
 */

import { useEffect } from 'react';

import { gridToImageData } from '@/core/composite';
import { getPipelineRunner } from '@/core/workers/client';
import { resolvePalette } from '@/palettes/builtin';
import { useApp } from './store';

export function usePipelineRunner(): void {
  const source = useApp((s) => s.source);
  const sourceReady = useApp((s) => s.sourceStatus === 'ready');
  const settings = useApp((s) => s.settings);
  const interacting = useApp((s) => s.interacting);

  /* 订阅 Worker 产出。只订阅一次：用到的调色板由结果自带，
     所以不需要把 paletteId 放进依赖里重建订阅。 */
  useEffect(() => {
    const runner = getPipelineRunner();
    const unsubscribe = runner.subscribe(
      (outcome) => {
        const imageData = gridToImageData(outcome.grid, outcome.palette);
        void createImageBitmap(imageData).then((bitmap) => {
          useApp.getState().applyResult(outcome.grid, bitmap, {
            targetW: outcome.targetW,
            targetH: outcome.targetH,
            usedColors: outcome.usedColors,
            trimmed: outcome.trimmed,
            ms: outcome.ms,
            fallback: outcome.fallback,
          });
        });
      },
      (message) => {
        useApp.getState().setConvertError(message);
        useApp.getState().pushToast('error', message);
      },
    );
    return unsubscribe;
  }, []);

  /* 换图：源图只交给 Worker 一次 */
  useEffect(() => {
    if (!source || !sourceReady) return;
    getPipelineRunner().setSource({
      id: source.id,
      width: source.imageData.width,
      height: source.imageData.height,
      data: source.imageData.data,
    });
  }, [source, sourceReady]);

  /* 参数变化 → 请求重算 */
  useEffect(() => {
    if (!source || !sourceReady) return;

    // 拖动控件时走快速模式（强制加权 RGB，跳过 CIELAB）；
    // 松手后 interacting 变回 false，这个 effect 会再跑一次完整精度
    getPipelineRunner().request(settings, resolvePalette(settings.paletteId), interacting);
    useApp.getState().setPalette(resolvePalette(settings.paletteId));
    if (!interacting) useApp.getState().setConverting(true);
  }, [settings, source, sourceReady, interacting]);
}