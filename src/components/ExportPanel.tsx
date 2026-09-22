import { useMemo, type JSX } from 'react';

import { usedIndicesInRange } from '@/core/exporters/blueprint';
import { colorKey, findBlock, MC_BLOCKS, suggestBlockMap } from '@/core/exporters/blocks';
import { canCopyImage, canCopyText } from '@/core/exporters/clipboard';
import { composite } from '@/core/composite';
import { toHex } from '@/core/color/space';
import {
  EXPORTERS,
  getExporter,
  mergeOptionValues,
  type ExportOption,
} from '@/core/exporters/registry';
import { useApp } from '@/state/store';
import { NumberField, Select, Toggle } from './controls';
import { Row } from './Section';

/** 选项 schema → 控件。加一种导出器只要写 schema，不用动这里 */
function OptionControl({
  option,
  value,
  onChange,
}: {
  option: ExportOption;
  value: number | boolean | string;
  onChange: (v: number | boolean | string) => void;
}): JSX.Element {
  if (option.kind === 'number') {
    return (
      <NumberField
        label={option.label}
        value={typeof value === 'number' ? value : option.default}
        min={option.min}
        max={option.max}
        onChange={onChange}
      />
    );
  }
  if (option.kind === 'toggle') {
    return (
      <Toggle
        label={option.label}
        title={option.hint}
        value={value === true}
        onChange={onChange}
      />
    );
  }
  return (
    <Select
      label={option.label}
      value={typeof value === 'string' ? value : option.default}
      options={option.options}
      onChange={onChange}
    />
  );
}

/** 方块映射表：只用图上真正出现的颜色，不把整块调色板铺出来 */
function BlockMapEditor(): JSX.Element {
  const baseGrid = useApp((s) => s.baseGrid);
  const editLayer = useApp((s) => s.editLayer);
  const editVersion = useApp((s) => s.editVersion);
  const palette = useApp((s) => s.palette);
  const blockMap = useApp((s) => s.blockMap);
  const setBlockFor = useApp((s) => s.setBlockFor);
  const resetBlockMap = useApp((s) => s.resetBlockMap);

  const grid = useMemo(
    () => (baseGrid ? composite(baseGrid, editLayer) : null),
    [baseGrid, editLayer, editVersion],
  );

  const rows = useMemo(() => {
    if (!grid) return [];
    const suggested = suggestBlockMap(palette.colors);
    return usedIndicesInRange(grid, 0, 0, grid.w, grid.h).map((index) => {
      const color = palette.colors[index];
      const key = color ? colorKey(color) : '';
      return {
        index,
        key,
        hex: color ? toHex(color[0], color[1], color[2]) : '',
        // 用「实际会写进 CSV 的那个方块」作为当前值，而不是只看用户表
        current: findBlock(blockMap[key])?.id ?? suggested[key] ?? '',
        suggested: suggested[key] ?? '',
      };
    });
  }, [grid, palette, blockMap]);

  if (rows.length === 0) {
    return <p className="note note--tight">转换出结果后，这里会列出图上用到的颜色与建议方块。</p>;
  }

  return (
    <>
      <div className="blockmap">
        {rows.map((row) => (
          <div className="blockmap__row" key={row.key}>
            <i className="blockmap__chip" style={{ backgroundColor: row.hex }} />
            <span className="blockmap__hex" title={`调色板 #${row.index}`}>
              {row.hex}
            </span>
            <select
              className="select blockmap__select"
              value={row.current}
              onChange={(event) => setBlockFor(row.key, event.target.value)}
            >
              {MC_BLOCKS.map((block) => (
                <option key={block.id} value={block.id}>
                  {block.name}（{block.id}）
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
      <button type="button" className="linkbtn" onClick={resetBlockMap}>
        全部退回自动建议
      </button>
      <p className="note note--tight">
        默认值是<b>按颜色距离自动挑的最近方块</b>：Minecraft 没有精确等于某个 hex 的方块，
        颜色匹配本来就得人工决策。改过的映射会记住，CSV 与图纸图例用的是同一份 ——
        改这里两处一起变，不会对不上。
      </p>
    </>
  );
}

export function ExportPanel(): JSX.Element {
  const exporterId = useApp((s) => s.exporterId);
  const exportOptions = useApp((s) => s.exportOptions);
  const packZip = useApp((s) => s.exportPackZip);
  const exporting = useApp((s) => s.exporting);
  const lastNote = useApp((s) => s.lastExportNote);
  const baseGrid = useApp((s) => s.baseGrid);
  const batchReady = useApp(
    (s) => s.batchItems.filter((i) => i.status === 'done' && i.result).length,
  );

  const setExporter = useApp((s) => s.setExporter);
  const patchExportOptions = useApp((s) => s.patchExportOptions);
  const setExportPackZip = useApp((s) => s.setExportPackZip);
  const runExport = useApp((s) => s.runExport);
  const copyPngAsImage = useApp((s) => s.copyPngAsImage);
  const copyPaletteText = useApp((s) => s.copyPaletteText);

  const exporter = getExporter(exporterId) ?? EXPORTERS[0];
  const values = mergeOptionValues(exporter, exportOptions[exporter.id]);

  const isBlueprint = exporter.id.startsWith('blueprint');
  const ready = exporter.needs === 'grid' ? baseGrid !== null : batchReady > 0;

  return (
    <div className="section__body">
      <Select
        label="导出格式"
        value={exporter.id}
        options={EXPORTERS.map((e) => ({ value: e.id, label: e.label, title: e.description }))}
        onChange={setExporter}
      />
      <p className="note note--tight">{exporter.description}</p>

      {exporter.needs === 'batch' && (
        <Row
          k="批量队列"
          v={batchReady > 0 ? `${batchReady} 张已完成` : '还没有已完成的图'}
        />
      )}

      {exporter.options.map((option) => (
        <OptionControl
          key={option.key}
          option={option}
          value={values[option.key]}
          onChange={(v) => patchExportOptions({ [option.key]: v })}
        />
      ))}

      {isBlueprint && (
        <div className="batch__group">
          <h3 className="batch__groupTitle">方块映射表</h3>
          <BlockMapEditor />
        </div>
      )}

      {/* 多文件产出（分页蓝图、图集 PNG + JSON）逐个下载会被浏览器拦，默认打包 */}
      <Toggle
        label="多个文件时打包成 zip"
        value={packZip}
        title="分页蓝图一导就是好几张图，逐个下载会被浏览器当成可疑行为拦下"
        onChange={setExportPackZip}
      />

      <button
        type="button"
        className="btn btn--primary btn--block"
        disabled={exporting || !ready}
        onClick={() => void runExport()}
      >
        {exporting
          ? '正在导出…'
          : ready
            ? `导出${exporter.label}`
            : exporter.needs === 'batch'
              ? '先在批量处理里跑一轮'
              : '先转换出结果'}
      </button>
      {lastNote && <p className="note note--tight">{lastNote}</p>}

      <div className="batch__group">
        <h3 className="batch__groupTitle">复制到剪贴板</h3>
        <div className="chips--actions">
          <button
            type="button"
            className="chip"
            disabled={!baseGrid || !canCopyImage()}
            title="按上面 PNG 格式的倍数与底色设置复制，可直接粘进聊天窗或文档"
            onClick={() => void copyPngAsImage()}
          >
            复制像素图
          </button>
          <button
            type="button"
            className="chip"
            disabled={!canCopyText()}
            title="每行一个 #RRGGBB"
            onClick={() => void copyPaletteText()}
          >
            复制色值
          </button>
        </div>
        {!canCopyImage() && (
          <p className="note note--warn note--tight">
            当前环境不支持把图片写入剪贴板。剪贴板 API 需要 https 或 localhost，
            用 <b>file://</b> 直接打开页面时不可用。
          </p>
        )}
      </div>

      <p className="note">
        导出的都是<b>合成后的网格</b>：手工修改一定在 PNG / CSV / 图纸里。
        建造蓝图那条线（标尺 PNG、CSV、色号对照表）是给 Minecraft 用的 ——
        按 CSV 里的 <b>x,y,z,block</b> 摆，就能在游戏里一格格复现。
      </p>
    </div>
  );
}