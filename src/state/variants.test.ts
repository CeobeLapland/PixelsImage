/**
 * 随机灵感的 store 层测试：只锁「没有源图时的行为」。
 *
 * 真正跑变体要 Worker，node 测试环境里没有；参数生成与范围的锁在
 * `core/random/variant.test.ts` 里做了。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useApp } from './store';

beforeEach(() => {
  vi.useFakeTimers();
  useApp.setState({ source: null, sourceStatus: 'idle', sourceError: null });
});

describe('generateRandomVariants', () => {
  it('没有源图时返回空数组并提示', async () => {
    const list = await useApp.getState().generateRandomVariants(4);
    expect(list).toEqual([]);
    expect(useApp.getState().toasts.at(-1)?.text).toContain('先载入');
  });
});
