/**
 * 把「源图 / 转换参数」与 Worker 连起来的胶水层。
 *
 * 单独成 hook 而不是塞进 store，是因为它需要依赖 React 的生命周期来订阅/退订，
 * 而 store 本身要保持与 React 无关（画布事件要在 React 之外读写 store）。
 */

import { useEffect } from 'react';

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
        const state = useApp.getState();
        state.applyResult(outcome.grid, outcome.palette, {
          targetW: outcome.targetW,
          targetH: outcome.targetH,
          usedColors: outcome.usedColors,
          trimmed: outcome.trimmed,
          ms: outcome.ms,
          fallback: outcome.fallback,
        });
        // 降级状态可能因为 Worker 崩掉而变化，每次有结果就同步一次；
        // 状态栏据此提示「已降级」，免得用户以为只是「变卡了」
        if (state.workerFallback !== runner.isFallback) {
          useApp.setState({ workerFallback: runner.isFallback });
        }
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

    const state = useApp.getState();
    // 自定义调色板（提色 / 导入 / 编辑过的板）必须优先于内置表查
    const palette = resolvePalette(settings.paletteId, state.customPalettes);

    // 拖动控件时走快速模式（强制加权 RGB，跳过 CIELAB）；
    // 松手后 interacting 变回 false，这个 effect 会再跑一次完整精度
    getPipelineRunner().request(settings, palette, interacting);

    // 限色模式下调色板由 Worker 现算现回（见 pipeline.convert），
    // 这里先置成"待生成"没有意义，还会让调色板面板闪一下旧的板
    if (settings.quantize !== 'kmeans') state.setPalette(palette);
    if (!interacting) state.setConverting(true);
  }, [settings, source, sourceReady, interacting]);
}