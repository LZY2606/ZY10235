# 翼形共识室（Wing Consensus Chamber）

昆虫翅脉交点的多操作者定位共识工作台：分层保存**原始坐标 / 操作者版本 / 左右镜像假设 / Procrustes 对齐结果**，页面叠加多版本定位、共识形状、点级方差与逐样本形状残差。

- 语言/运行时：TypeScript + Node.js（ESM，tsx 直跑）
- 存储：SQLite（`better-sqlite3`，文件默认 `data/wing.db`）
- 页面：Canvas 2D 叠加渲染，Vite dev / 静态构建双模式
- 测试：Vitest（几何 / GPA / 数据库服务 / HTTP，共 26 个用例）

## 安装与演示

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm test -- --run
corepack pnpm dev --host 127.0.0.1 --port 5575
```

浏览器访问 <http://127.0.0.1:5575>，页面标题与顶栏均为「翼形共识室」。

`pnpm dev` 未构建 `dist/` 时自动以 Vite 中间件模式提供前端；执行 `pnpm build` 后同一命令直接以静态文件模式启动（`dist/` 已在 `.gitignore` 中）。

## 数据口径（重要）

**点谱系（landmark lineage）**：6 个翅脉交点（`src/shared/fixtures.ts` 中的 `LANDMARKS`），编号 0–5 在左翅、右翅和所有操作者版本之间表示同一解剖点。对应关系由 `localization.confirmed` 标记，**未确认的点按缺失处理，不参与共识**；用户可在页面上逐个确认/取消确认。

**缺失点**：坐标为 `NULL` 表示形态学团队保留该点缺失。系统**绝不自动插值**——缺失点不参与 Procrustes 拟合与方差计算，但原始定位行始终保留，页面以红色 ✕ 占位提示。

**操作者版本**：每个样本可有多个 `(operator, version)` 定位层。样本有一个 `active_version`，共识只使用当前激活版本；历史版本仍在原始空间叠加显示，可随时切换。

**固定样本集**：一次共识运行把当时的「激活版本 + 确认状态」形状快照写入运行结果，并计算 FNV-1a `input_signature`（样本 id / 版本 / 坐标 / 镜像开关 / 最小点数）。含对称（`mirrorRight=true`）与不含对称（`false`）两个分支因此可并列保存、比较，互不覆盖。

### 对齐规则

- 对齐**只允许平移、各向同性缩放、旋转**。二维旋转由相关阵迹 `tr(R(θ)H)` 的解析极大值求得，实际应用矩阵的行列式恒为 **+1**（残差表与运行结果都带 `det` 校验）。
- **镜像必须显式启用**：仅当运行参数 `mirrorRight === true` 时，右翅样本在对齐前绕「过质心的纵轴」做一次显式镜像（x → 2·cx − x），并在结果里以 `mirrored=true` 标出。默认（缺省或 `false`）不镜像。对齐内部永远不会选择 `det = -1` 的变换，镜像误差不会被负行列式“偷偷吸收”。

### 并列最优旋转（非唯一性）

近完全对称/退化形状会让最优旋转不可唯一识别。系统在残差比较的基础上结合源点云协方差特征值判定：

- `reflection_rotation_tie`：形状近共线且关于中点近似对称（固定 fixture 中的 **S3 近完全对称标本**），一个 `det = -1` 的镜像变换与正规旋转达到同一最优（归一化差距 ≤ `TIE_REL_TOL = 1e-6`）。
- `isotropic`：点云近各向同性，任意旋转等价（连续不唯一）。

处理原则：

1. **稳定显示规则**：并列候选转角统一规范到 `[-π, π)`，按「绝对转角最小；平手取非负」排序并采用首个，相同输入逐次运行完全一致。
2. **只报告、不偷偷镜像**：即使镜像候选并列或更优，实际显示/计算的仍是 `det = +1` 的正规旋转；页面顶部黄色横幅列出每个非唯一样本的候选角与说明，`RunResult.ambiguousSampleIds` 与逐样本 `ambiguity`（kind / message / candidateAngles / chosenAngle / relativeGap）完整入库。

### 入组门槛

可识别点数（存在坐标且对应已确认）少于 `minPoints = 3` 的样本**不进入共识形状**，但仍出现在运行结果中：`included=false`、`excludeReason='below_min_points'`，原始形状与版本完整保留（fixture 中的 **S5** 只有 2 个点）。

## 固定 fixture（验收点集）

`src/shared/fixtures.ts`：

| 样本 | 侧别 | 特征 |
| --- | --- | --- |
| S1-A-left | 左翅 | 3 个操作者版本；v2 第 3 点对应未确认 |
| S2-B-right | 右翅 | 2 个版本；镜像开关的效果在它身上直接可见 |
| S3-C-symmetric-left | 左翅 | 近完全对称的退化标本（微弯轴脉上六点弧列，1e-8 隆起、1e-6 版本噪声），稳定触发并列旋转报告 |
| S4-D-missing-right | 右翅 | 中脉中点（index 4）保留为缺失，不插值 |
| S5-E-sparse-left | 左翅 | 仅 2 个可识别点，低于门槛，不进入共识但保留原版本 |

## 页面操作

- 左侧：切换每个样本的操作者版本；点击点标签确认/取消点对应（绿=已对应、黄=待确认、红=缺失，不插值）。
- 「运行（不含对称 / 含对称）」：分别用 `mirrorRight=false/true` 固化两个分支；历史运行按签名展示，点击即可叠加查看。
- 右侧两个 Canvas：原始空间全部版本叠加；共识空间显示各样本对齐形状、白色共识点、橙色点级方差气泡。
- 顶部横幅报告并列旋转；下方表格给出每样本点数、入组状态、RMS 残差、旋转角、det 校验与非唯一类型。

## 运行记录导出、清空与重导入复核

- 「导出记录(JSON)」→ `GET /api/export`：导出全量样本、定位、运行（含结果 JSON），包格式 `wing-consensus-chamber@1`。
- 「清空并导入复核」→ `POST /api/import`：删除全部表数据后按导入包**原样重建**（运行主键、签名、结果 JSON 保持不变）。
- 重放：`POST /api/runs/:id/replay` 用该运行保存的形状快照重跑 GPA，返回 `identical`（确定性口径下为 `true`）。
- 命令行复核：删除 `data/wing.db` 后重新 `pnpm dev` 会从固定 fixture 播种；再用导出包导入即可恢复含历史运行的完整状态。

## HTTP API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 点谱系、样本、全部定位、当前激活形状、minPoints |
| POST | `/api/confirm` | `{sampleId, pointIndex, confirmed}` 确认/取消对应 |
| POST | `/api/version` | `{sampleId, version}` 切换激活操作者版本 |
| POST | `/api/runs` | `{mirrorRight, minPoints?}` 创建共识运行（镜像默认关） |
| GET | `/api/runs` / `/api/runs/:id` | 历史运行与完整结果 |
| POST | `/api/runs/:id/replay` | 按保存快照确定性重放 |
| GET | `/api/export` · POST | `/api/import` · POST `/api/reset` | 导出 / 重导入 / 重置 fixture |

环境变量：`HOST`、`PORT`（默认 127.0.0.1:5575）、`WING_DB`（默认 `data/wing.db`，可用 `:memory:`）。

## 目录

```
src/shared/   类型、fixture、Procrustes/GPA 几何（前后端共用）
src/server/   SQLite schema/播种/导入导出、共识服务、HTTP API、服务器入口
src/client/   Canvas 页面（index.html 在仓库根，Vite root）
tests/        geometry / gpa / db-service / http 四组测试
```
