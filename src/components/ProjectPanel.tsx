import { useState, type JSX } from 'react';

import { useApp } from '@/state/store';

/**
 * 转换预设（M7）。
 *
 * 与「批量处理」里的批处理预设刻意分开：那份带命名模板、放大倍数这些**导出**设置，
 * 这份只管一套转换参数。日常用得多的是后者 —— 调出一套满意的参数，
 * 换张图直接套，不用每次重调采样、抖动、距离。
 */
export function ProjectPanel(): JSX.Element {
  const presets = useApp((s) => s.convertPresets);
  const settings = useApp((s) => s.settings);
  const saveConvertPreset = useApp((s) => s.saveConvertPreset);
  const applyConvertPreset = useApp((s) => s.applyConvertPreset);
  const removeConvertPreset = useApp((s) => s.removeConvertPreset);
  const projectSavedAt = useApp((s) => s.projectSavedAt);

  const [name, setName] = useState('');

  const commit = () => {
    saveConvertPreset(name);
    setName('');
  };

  return (
    <div className="section__body">
      <div className="batch__presetRow">
        <input
          className="textfield__input"
          type="text"
          placeholder="给当前这套参数起个名字"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit();
          }}
        />
        <button type="button" className="btn" disabled={name.trim() === ''} onClick={commit}>
          保存
        </button>
      </div>

      {presets.length === 0 ? (
        <p className="note note--tight">
          预设会把「目标格数 / 采样 / 距离 / 抖动 / 预处理」整套参数存下来，
          下次换张图一键套用。存在本地，关掉浏览器也还在。
        </p>
      ) : (
        <ul className="batch__presets">
          {presets.map((preset) => (
            <li key={preset.id}>
              <button
                type="button"
                className="batch__presetApply"
                title={`套用：目标 ${preset.settings.targetW} 格 · ${preset.settings.sampling} · ${preset.settings.dither}`}
                onClick={() => applyConvertPreset(preset.id)}
              >
                {preset.name}
              </button>
              <button
                type="button"
                className="batch__presetDel"
                title="删除该预设"
                onClick={() => removeConvertPreset(preset.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="note note--tight">
        当前参数：目标 <b>{settings.targetW}</b> 格 · {settings.sampling} · {settings.dither}
        {settings.quantize === 'kmeans' ? ` · 限色 ${settings.maxColors}` : ''}
      </p>
      {projectSavedAt !== null && (
        <p className="note note--tight">
          上次存档：<b>{new Date(projectSavedAt).toLocaleString()}</b>
          。顶栏的「存档」会把源图、参数、调色板与手改一起写进 <b>.pixproj</b>。
        </p>
      )}
    </div>
  );
}