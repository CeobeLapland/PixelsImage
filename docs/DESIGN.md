# 设计文档

PixelsImage 的技术设计与关键决策记录。

- 目标读者：维护这份代码的人（主要是你自己）
- 配套文档：[README.md](../README.md) / [ROADMAP.md](ROADMAP.md)

---

## 1. 目标与非目标

### 目标
- 把任意高清位图转换为**受控的低分辨率像素图**：尺寸、颜色数、调色板、抖动方式全部可调、可复现。
- 转换结果**可手工逐像素修改**，且修改成果不因调整转换参数而丢失。
- 输出能直接用作美术素材：PNG（1x/放大）、精灵图集、调色板文件、GIF、以及 Minecraft 建造蓝图。
- 单人本地使用：零部署、零网络、双击可用。

### 非目标
- ❌ 不是通用图像编辑器（不做图层混合模式、滤镜库、笔刷引擎、矢量工具）
- ❌ 不做图转 3D 模型 / 体素化 / .schematic 二进制写入（蓝图做到「可照搭的图纸」为止）
- ❌ 不做云端存储、协作、账号体系
- ❌ 不追求「一键出神图」，自动算法定位是**出草稿**，成品靠手调

---

## 2. 技术选型

| 关注点 | 选择 | 理由 / 被否决的方案 |
| --- | --- | --- |
| 形态 | 本地 Web 应用（Vite dev server / 静态打包） | 图像处理天然适合浏览器；否决 Electron（体积）、PySide6（UI 开发慢）、单文件 HTML（难维护） |
| 语言 | TypeScript（`strict: true`） | 像素级索引与缓冲区操作极易越界，类型能挡住一大类错误 |
| 构建 | Vite | 零配置、HMR 快、`build` 产出纯静态文件可离线用 |
| UI | React 19 | 面板数量多（转换/调色板/导出/批量/状态栏），组件化收益明确 |
| 状态 | Zustand | 轻量；关键是**能脱离 React 在工具函数里 `getState()`**，这对画布事件处理很重要 |
| 绘图 | Canvas 2D | `getImageData/putImageData` 直接拿到逐像素缓冲；放大用 `imageSmoothingEnabled = false` 即得硬边像素 |
| 重计算 | Web Worker + OffscreenCanvas | 转换流水线是 O(w·h) 的循环，放主线程会卡；用 transferable 传 `ArrayBuffer` 零拷贝 |
| 撤销 | 自研命令栈（带快照） | 像素网格操作是「整块数据替换」模型，通用 undo 库反而绕 |
| 依赖 | 运行时依赖仅 `react` `react-dom` `zustand`；`fflate`、`gifenc` 在对应导出功能实现时按需引入 | 保持依赖面小，避免供应链与体积膨胀 |

**为什么不用 WebGL 做转换**：降采样 + 量化本质是每像素独立或小邻域运算，CPU 循环配合 `Uint8Array` 已经足够快（1024×1024 → 32×32 的量化是毫秒级）；且抖动的误差扩散是**串行依赖**的，GPU 并不擅长。WebGL 只在需要实时预览超大图时才考虑，目前不必要。

---

## 3. 核心数据模型

全部定义在 `src/core/types.ts`。

### 3.1 调色板

```ts
type RGBA = readonly [r: number, g: number, b: number, a: number]; // 0-255

interface Palette {
  id: string;
  name: string;
  colors: RGBA[];        // 上限 256（索引存 Uint8Array）
  builtin?: boolean;
  source?: 'builtin' | 'extracted' | 'imported';
}
```

约束：**索引存进 `Uint8Array`，所以调色板上限 256 色**。这个上限对像素艺术绰绰有余（PICO-8 只有 16），也省掉一个字节的大小分支。

### 3.2 像素网格（核心工作对象）

```ts
interface PixelGrid {
  w: number;
  h: number;
  indices: Uint8Array;   // 长度 w*h，值为调色板索引
  alpha: Uint8Array;     // 长度 w*h，0-255，独立于调色板
}
```

**为什么 alpha 独立、不用一个「透明色」哨兵值**：
- 素材常需要半透明边缘（发光、阴影、渐变），单哨兵值表达不了；
- 导出 PNG 时 alpha 直接写回，不需要在调色板里塞一个魔法槽位；
- 全局换色（把 A 色换成 B 色）不会误伤透明区。

### 3.3 转换参数

```ts
interface ConvertSettings {
  targetW: number;             // 目标格数（宽）
  targetH: number | 'auto';    // 'auto' = 按原图宽高比推导
  sampling: 'nearest' | 'area' | 'dominant' | 'median';

  quantize: 'palette' | 'kmeans';
  paletteId: string;           // quantize === 'palette' 时生效
  maxColors: number;           // quantize === 'kmeans' 时生效，2-256
  distance: 'rgb' | 'weighted' | 'lab';

  dither: 'none' | 'bayer2' | 'bayer4' | 'bayer8'
        | 'floyd' | 'atkinson' | 'sierra';
  ditherStrength: number;      // 0-1

  preprocess: {
    brightness: number;        // -100 ~ 100
    contrast: number;          // -100 ~ 100
    saturation: number;        // -100 ~ 100
    sharpen: number;           // 0 ~ 100
    alphaThreshold: number;    // 0-255，低于此值视为全透明；255 表示不处理
  };

  trimTransparent: boolean;    // 转换后裁掉四周全透明边
  pixelPerfect: boolean;       // 禁止产生「半格」，见 §4.2
}
```

`ConvertSettings` 是**纯数据、可 JSON 序列化**的 —— 这直接支撑了预置保存、项目存档、批量复用三个功能。

### 3.4 双层编辑模型（关键设计）

```ts
interface EditLayer {
  /** 与 baseGrid 同尺寸；null 表示该格走底层，有值表示被手工覆盖 */
  cells: (PixelCell | null)[];
}
interface PixelCell { index: number; alpha: number; }

interface Document {
  source: SourceImage;
  settings: ConvertSettings;
  baseGrid: PixelGrid;         // 由 settings 重算得出（可重入）
  editLayer: EditLayer;        // 用户手工改动（不可重算）
  palette: Palette;
}
```

**渲染时合成**：`composite(i, j) = editLayer.cells[k] ?? baseGrid[k]`。

**这个设计换来什么**：

| 场景 | 没有双层模型 | 有双层模型 |
| --- | --- | --- |
| 转完 32×32 后手改了半天，又想试试 48×48 | 手改全丢，重画 | 改回 32×32 手改立刻回来；切 48×48 时编辑层按比例缩放重采样 |
| 想换调色板看效果 | 手改的像素被一起改掉，或者不变但和背景不搭 | 你手改的像素**保持你选的颜色**（它们是你明确的意图），底色随调色板变 |
| 想改抖动强度 | 手改被冲掉 | 只影响底层，手改不动 |

**代价与取舍**：切换尺寸时编辑层必须做一次「最近邻重采样」，非整数倍时手改像素位置会有偏移 —— 这是可接受的，并且在 UI 上明确提示「尺寸变更将重采样手工编辑，是否继续？」。另一处代价是合成多一次查表，但 32×32 只有 1024 格，可忽略。

**另一条被否决的路**：把手工操作记成操作日志（operation log）重放。否决原因：全局换色、自动描边这类操作依赖当前全图状态，重放语义不清晰；且日志体积随时间增长。快照式编辑层简单可靠。

---

## 4. 转换流水线

`src/core/pipeline.ts`，在 Web Worker 中执行。

```
源 ImageData
  ↓ ① 预处理        preprocess.ts
  ↓ ② 降采样        sampling.ts      → (targetW × targetH) 的 RGBA 缓冲
  ↓ ③ 颜色量化      quantize.ts      → indices + alpha
  ↓ ④ （抖动）       dither.ts        与 ③ 交织执行
  ↓ ⑤ 后处理        trim / 透明清理
PixelGrid
```

### 4.1 降采样 `sampling`

| 模式 | 做法 | 适用 |
| --- | --- | --- |
| `nearest` | 取块中心像素 | 保留原始硬边缘；原图本身就是像素画时用 |
| `area` | 取块内所有像素的加权平均 | **默认**。照片/插画降采样最稳，颜色过渡自然 |
| `dominant` | 块内颜色做直方图（量化到 5bit/通道后投票），取占比最高 | 想要「色块感」、避免产生原图不存在的混合色 |
| `median` | 块内各通道取中位数 | 抗噪点、抗单点高光污染 |

实现要点：
- `area` 的块边界要处理**非整数倍缩放**带来的部分覆盖，用累积权重而不是简单丢像素，否则会出现规则条纹。
- 全程在 `Uint8ClampedArray` 上循环，行内累加避免重复查表。

### 4.2 pixelPerfect

当目标格数与原图尺寸不是整数倍关系时，`area` 平均会让某些格子覆盖 2 个源像素、某些覆盖 3 个，导致**同一视觉元素在不同位置大小不一**（像素画的经典瑕疵）。

`pixelPerfect: true` 时：先把原图用最近邻缩放到「目标格数 × 整数倍」的中间尺寸，再做整数倍面积平均，保证每格权重完全一致。代价是牺牲一点锐度，换来网格规整。

### 4.3 颜色量化 `quantize`

**模式 A：映射到固定调色板**

对每个像素，在调色板中找最近色。距离度量三选一：

| 度量 | 公式要点 | 特点 |
| --- | --- | --- |
| `rgb` | 欧氏距离 | 最快，但对暗部/肤色判断偏差大 |
| `weighted` | `2·Δr² + 4·Δg² + 3·Δb²` | 便宜的感知近似，实时预览默认 |
| `lab` | 转到 CIELAB 空间算 ΔE76 | 最准，代价是每像素一次色彩空间转换 |

优化：`lab` 模式下**预先把调色板转到 LAB 一次**（只转 ≤256 个），源像素转换在线做。另外做一个 32×32×32 的 5bit/通道查找缓存表（`Uint8Array(32768)`）——同一张图在预览滑动时大量颜色重复，命中率很高。

**模式 B：k-means 限制色彩数**

1. 用「最大最小距离法（k-means++ 的简化版）」从图像中采样初始聚类中心，避免随机初始化导致每次结果不同；
2. 迭代 8–12 次（像素艺术不需要收敛到极致）；
3. 簇中心即为新调色板，写回 `Palette`，同时把图像映射上去。

**抖动与量化交织**：误差扩散类抖动必须在量化过程中进行 —— 量化当前像素 → 计算误差 → 扩散到尚未处理的邻居。因此 `quantize` 与 `dither` 在实现上是同一个循环的两面，接口设计为：

```ts
function quantizeInto(
  src: Uint8ClampedArray, w: number, h: number,
  palette: RGBA[], opts: QuantizeOptions,
  out: { indices: Uint8Array; alpha: Uint8Array },
): void;
```
`opts.dither !== 'none'` 时内部走误差扩散路径，否则走纯最近色映射路径。

| 抖动 | 特征 |
| --- | --- |
| `bayer2/4/8` | 有序抖动，图案规则、可无缝平铺，强度用阈值矩阵幅值控制 |
| `floyd` | 经典误差扩散，细节最好，但有「虫形」伪影 |
| `atkinson` | 只扩散 3/4 的误差，对比度高、干净，**像素画首选** |
| `sierra` | 介于 floyd 与 atkinson 之间 |

`ditherStrength` 统一缩放到扩散量（`err * strength`），有序抖动则缩放阈值矩阵幅值。

---

## 5. 编辑器设计

### 5.1 工具集

`src/core/toolbar/`，每个工具实现统一接口：

```ts
interface Tool {
  id: ToolId;
  cursor: string;
  onDown(ctx: ToolCtx, p: GridPoint): void;
  onMove(ctx: ToolCtx, p: GridPoint): void;
  onUp(ctx: ToolCtx, p: GridPoint): void;
  /** 拖拽预览（直线/矩形在未抬起时需要临时绘制） */
  preview?(ctx: ToolCtx, p: GridPoint): void;
}
```

| 工具 | 说明 |
| --- | --- |
| 铅笔 `B` | 画前景色；笔刷尺寸 1–4；开启对称时同时写入镜像位置 |
| 橡皮 `E` | alpha 置 0 |
| 油漆桶 `G` | 4 邻域洪水填充，可按「相同调色板索引」或「颜色差值阈值」判定连通 |
| 吸管 `I` | 取当前像素的调色板索引为前景色；Alt 临时切换 |
| 直线 `L` / 矩形 `R` / 椭圆 `O` | 拖拽起点终点；矩形/椭圆可选描边或填充 |
| 选区移动 `M` | 矩形选区，拖拽搬运（搬运 = 源区清除 + 目标区写入） |

### 5.2 撤销栈

`src/state/history.ts`，命令栈 + 快照：

- 一次「操作」= 一次 `onDown → onUp`（拖拽过程中的中间态不单独入栈），避免拖一笔产生几百条记录。
- 快照只存**被修改的格子**（`k → PixelCell` 的稀疏 Map），不存整张网格。32×32 全图也就 1KB，稀疏化是为了将来支持大尺寸。
- 容量 100 步，环形覆盖；超过后丢最旧的。
- 与撤销栈解耦：**转换参数变更不入撤销栈**，它改的是 `baseGrid`，属于另一个维度的历史（由「最近一次转换设置」表达）。

### 5.3 画布交互 `CanvasView.tsx`

- **两层 canvas**：底层绘制像素（只在网格数据变化时重绘），上层绘制网格线、选区、笔刷光标、预览图形（跟随鼠标频繁重绘）。分离后鼠标移动不会触发整图重绘。
- 缩放：整数倍 1x–64x，`imageSmoothingEnabled = false` + 预渲染的 `ImageBitmap`，避免每帧 `putImageData`。
- 平移：空格拖拽 / 中键拖拽；`+` `-` 缩放；`0` 适配窗口。
- 坐标反查：`gridX = floor((mouseX - panX) / zoom)`。
- 大网格（>128×128）时网格线降采样绘制（每 4 格一条），防止摩尔纹。

### 5.4 快捷键

| 键 | 功能 |
| --- | --- |
| `B` `E` `G` `I` `L` `R` `O` `M` | 切换工具 |
| `[` `]` | 笔刷尺寸 |
| `X` | 前景色 / 背景色互换 |
| `Alt + 点击` | 临时吸管 |
| `Ctrl + Z` / `Ctrl + Shift + Z` | 撤销 / 重做 |
| `+` `-` `0` | 放大 / 缩小 / 适配 |
| `空格 + 拖拽` | 平移画布 |
| `Tab` | 折叠右侧面板（换取大画布） |
| `Shift + 点击调色板` | 把全图中该色替换为前景色 |

---

## 6. 调色板引擎

`src/palettes/`

- **`builtin.ts`**：内置调色板数据。核心是 Minecraft 16 染料色：

  ```
  white #F9FFFE   light_gray #9D9D97   gray #474F52    black #1D1D21
  brown #835432   red #B02E26          orange #F9801D  yellow #FED83D
  lime #80C71F    green #5E7C16        cyan #169C9C    light_blue #3AB3DA
  blue #3C44AA    purple #8932B8       magenta #C74EBD pink #F38BAA
  ```

  另附：Minecraft 羊毛/混凝土扩展色板、PICO-8（16）、GameBoy（4 阶灰绿）、NES 子集、C64（16）。

- **`parse.ts`**：解析 `.hex`（每行一个 `RRGGBB`，可带注释）、`.gpl`（GIMP Palette，跳过 `#` 与 `Name:`/`Columns:` 头）、简易 `.pal`（JASC-PAL）。

- **`extract.ts`**：从图片提取主色。默认走「中位切分（median cut）」—— 比 k-means 快且无需迭代，取色结果更适合做调色板；同时提供 `kmeans` 模式作为备选。可选「排除透明像素」「限制明度范围」两个过滤器，避免提出来一堆背景色。

- **全局换色（palette replace）**：这是最实用的功能，实现上要覆盖两处 ——
  1. `baseGrid.indices` 中所有等于 `fromIndex` 的格子改写为 `toIndex`；
  2. `editLayer.cells` 中的 `index` 同样改写（这一步保证手改不会被漏掉）；
  3. 若开启「同步合并调色板槽位」，则把 `fromIndex` 从调色板中删除并压缩索引（需重建 `indices` 的映射表）。

---

## 7. 导出体系

`src/core/exporters/`，统一接口：

```ts
interface Exporter {
  id: string;
  label: string;
  options: OptionSchema[];     // 供 UI 自动渲染参数控件
  run(doc: Document, opts: Record<string, unknown>): Promise<Blob | Blob[]>;
}
```

| 导出器 | 说明 |
| --- | --- |
| `png.ts` | 1x 或 Nx 放大。放大必须用**整数倍最近邻**手写循环，不能依赖 `drawImage` 的平滑（不同浏览器插值行为不一致） |
| `spritesheet.ts` | 多图/多帧按行打包，自动计算列数接近正方形；可选裁剪透明边（`trim`）；可选固定间距 |
| `palette.ts` | `.hex` / `.gpl` / 色条 PNG（每色一格，附 hex 文本可选） |
| `gridJson.ts` | `{w, h, palette: string[], indices: number[], alpha?: number[]}`，给程序消费 |
| `gif.ts` | 逐帧跑同一套 `ConvertSettings`，再用 `gifenc` 编码；注意 GIF 只有 256 色且单色透明，需提示用户 |
| `blueprint.ts` | Minecraft 建造蓝图：网格 + 每行/列坐标标尺 + 色号图例 + 方块名对照表，输出大 PNG 或 `x,y,z,block` CSV |

**蓝图色 → 方块映射**：不硬编码「十六进制 → 方块」，而是**按调色板槽位顺序映射到方块名列表**（用户可编辑映射表，存进项目文件）。理由：Minecraft 没有精确等于某个 hex 的方块，颜色匹配本来就需要人工决策；且不同版本方块集不同。默认提供一份「16 染料色 → 对应羊毛/混凝土方块名」的初始映射供改。

---

## 8. 性能策略

| 场景 | 手段 |
| --- | --- |
| 转换流水线 | 放 Web Worker；`ArrayBuffer` 通过 `transferable` 传递（零拷贝） |
| 参数拖动时的高频重算 | 拖拽中降级：`distance` 强制为 `weighted`、跳过 `lab`；`pointerup` 后再跑完整精度 |
| 预览渲染 | 网格数据 → `ImageBitmap` 预渲染一次，缩放只做 `drawImage` |
| 大图源数据 | 超过 4096px 的源图先做一次 downscale 缓存（保留一份「适合当前 targetW 的源副本」，最多到 targetW 的 32 倍） |
| 查找表 | LAB 最近色用 5bit/通道 的 32K 缓存表 |
| 长列表（批量队列） | 虚拟滚动（只在队列 > 50 项时启用，否则不引入这个复杂度） |

---

## 9. 目录结构

```
src/
├── main.tsx                    入口
├── App.tsx                     布局：左工具栏 / 中画布 / 右属性面板 / 底状态栏
│
├── core/                       纯逻辑层（不 import 任何 React）
│   ├── types.ts                PixelGrid / Palette / ConvertSettings / Document   ✅
│   ├── image.ts                源图解码、尺寸保护（大图降采样）                    ✅
│   ├── color/
│   │   ├── space.ts            hex ↔ RGB ↔ LAB / OKLab 转换
│   │   ├── distance.ts         rgb / weighted / lab 距离 + 查找缓存
│   │   ├── quantize.ts         最近色映射 + 误差扩散主循环
│   │   ├── kmeans.ts           k-means++ 初始化与迭代
│   │   └── dither.ts           有序抖动阈值矩阵
│   ├── sampling.ts             nearest / area / dominant / median
│   ├── preprocess.ts           亮度/对比度/饱和度/锐化/alpha 阈值
│   ├── pipeline.ts             串起完整转换，导出 convert(source, settings) → PixelGrid
│   ├── composite.ts            baseGrid ⊕ editLayer → 最终 PixelGrid
│   ├── workers/
│   │   └── pipeline.worker.ts  Worker 入口
│   ├── tools/                  铅笔/橡皮/油漆桶/吸管/直线/矩形/椭圆/选区
│   ├── assists/
│   │   ├── outline.ts          自动描边
│   │   ├── shade.ts            自动明暗分层
│   │   └── trim.ts             透明边裁剪
│   └── exporters/              各导出器，含 registry.ts 注册表
│
├── palettes/
│   ├── builtin.ts              内置调色板数据
│   ├── parse.ts                .hex / .gpl / .pal 解析
│   └── extract.ts              中位切分 / k-means 提色
│
├── state/
│   ├── store.ts                Zustand store（source / doc / settings / tool / ui 切片）  ✅
│   ├── history.ts              撤销栈
│   ├── presets.ts              转换预设的持久化（localStorage）
│   └── project.ts              .pixproj 读写（settings + palette + editLayer + source 引用）
│
├── components/
│   ├── AppHeader.tsx           顶栏：品牌、当前文件信息、清除/折叠                   ✅
│   ├── ToolRail.tsx            左侧竖直工具条（M2 起启用）                          ✅
│   ├── Stage.tsx               舞台：拥有拖拽 / 粘贴 / 文件选择三类输入              ✅
│   ├── Dropzone.tsx            空状态与拖拽热区                                     ✅
│   ├── Viewport.tsx            画布：缩放、平移、棋盘格底、源像素网格、缩放控件       ✅
│   ├── SidePanel.tsx           右侧面板：折叠分组、源图信息、显示选项、进度           ✅
│   ├── StatusBar.tsx           底部读数：尺寸 / 光标坐标 / 缩放 / 忙碌               ✅
│   ├── Toasts.tsx              提示条                                               ✅
│   ├── PixelIcon.tsx           像素图标：字符矩阵 → SVG，零图标依赖                  ✅
│   ├── ConvertPanel.tsx        尺寸/采样/量化/抖动/预处理控件        （M1）
│   ├── PalettePanel.tsx        调色板选择、提色、导入导出、全局换色    （M3）
│   ├── AssistsPanel.tsx        描边、明暗、去背、平铺预览             （M4）
│   ├── ComparePanel.tsx        原图对照：并排 / 侧滑分割 / 叠加      （M1）
│   ├── LayerPanel.tsx          底层(原图)显隐、编辑层清空/重采样      （M2）
│   ├── ExportPanel.tsx         各导出器的参数与执行                  （M6）
│   ├── BatchPanel.tsx          批量队列与打包导出                   （M5）
│   └── shortcuts/ShortcutsHelp.tsx  快捷键帮助面板                  （M7）
│
└── styles/
    └── global.css              暗色主题 CSS 变量与全部组件样式                        ✅
```

标注 ✅ 的是 M0 已落地的文件，其余为规划中的位置。

**分层规则**：`core/` 与 `palettes/` 不依赖 React 与 DOM（`exporters/` 例外，它需要 `Blob` / `Canvas`，但仍不 import React）。这样这部分逻辑可以单独写测试，将来也能直接改造成 CLI。

---

## 10. 关键技术决策记录

| # | 决策 | 结论 | 主要理由 |
| --- | --- | --- | --- |
| 1 | alpha 存储 | 独立 `Uint8Array`，非调色板哨兵值 | 支持半透明；换色不误伤透明区 |
| 2 | 调色板上限 | 256 | 索引存 `Uint8Array`；像素艺术够用 |
| 3 | 手改与转换 | 双层模型（baseGrid + editLayer） | 调参不毁手改，这是全工具最核心的体验承诺 |
| 4 | 手改历史 | 快照式稀疏 Map，非操作日志重放 | 全局换色/自动描边等操作重放语义不清晰 |
| 5 | 转换执行位置 | Web Worker | 主线程不卡；零拷贝传缓冲 |
| 6 | 抖动默认 | `atkinson` | 像素画观感最好、伪影最少，优于 Floyd–Steinberg |
| 7 | 距离默认 | `weighted`（实时）/ `lab`（导出） | 拖动滑块要快，最终出图要准 |
| 8 | UI 框架 | React + Zustand | 面板多；store 能脱离 React 访问，便于画布事件 |
| 9 | 蓝图色→方块 | 按槽位映射到可编辑方块名表，非硬编码 hex 匹配 | MC 无精确同色方块，需人工决策；版本间方块集有差异 |
| 10 | 是否需要后端 | 不要 | 本地隐私、零部署 |

---

## 11. 待定 / 待验证

- [ ] 编辑层在尺寸变更时的重采样策略：最近邻够用吗？要不要给「重采样 / 丢弃 / 保留原尺寸覆盖」三选一？
- [ ] `dominant` 采样在高分辨率源图上的性能（直方图构建是否需要采样下探）。
- [ ] GIF 导出的 256 色限制与单色透明如何向用户解释清楚（可能要单独一个提示面板）。
- [ ] 蓝图 CSV 的坐标系约定（是否需要支持 Y 轴朝上的建筑高度分层）。
- [ ] 是否需要「导入已有的低分辨率像素图 → 反向解析出调色板 + 网格」（对二次编辑旧素材有用）。