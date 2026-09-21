# Harness Office Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用真正的 Harness 会话、输入与交互卡片替换本地 Web 的 Genspark 聊天面板，保留 Office 编辑器和原生工具。

**Architecture:** 在现有运行时组合官方 Host/Client 插件；Office 专用布局只展示绑定当前文档的会话。Local Host 继续拥有文件授权、编辑器桥、审批和保存。先修复 Sheets 读取，再贯通原生 UI，最后推广到 Docs/Slides。

**Tech Stack:** TypeScript、React、Vite、Cordis、Harness、Vitest、现有 Local Host HTTP/WebSocket。

**Spec:** `docs/superpowers/specs/2026-09-21-harness-office-panel-design.md`

## Global Constraints

- 替换本地 Web 中的 Genspark 聊天面板，保留 GenOffice 编辑器。先在 Sheets 验证，再复用到 Docs 和 Slides。
- 保留 Harness 多供应商能力；模型密钥仅在 Host。Office 编辑仍使用原生工具，不引入 MCP。
- 方案选择不等于任意写入授权。
- 刷新恢复持久化 Session，不凭空重放写入。
- 通用问题等待用户回答或取消，不套用当前审批卡 110 秒超时。
- 工具名、哈希及原始 JSON 留在诊断详情，不作为主文案。
- 不另起一个没有 Office 工具的通用 Harness 实例。
- 保留已有脏工作区改动；不重置、不批量提交其他工作的文件。每项测试通过后仅提交本项差异。

## Review Focus

1. 离屏、未加载的范围不能被当成空值：Task 1 覆盖异步加载和错误传播。
2. 提交后切换文件/选区，旧响应不能写入新文件：Task 2/5 覆盖冻结上下文及隔离。
3. UI 显示可选项但没有 answerer，不能无限等待：Task 4 覆盖明确失败与取消。
4. 双击、迟到审批、刷新恢复，不得重复写入：Task 4/5 覆盖幂等与过期。
5. 官方 Web 组合可能带入通用文件或命令工具：Task 3 覆盖实际工具清单及鉴权，而不只隐藏按钮。

## Execution boundary

这是有兼容性门禁的分阶段计划。当前安装依赖固定为 `0.1.6-alpha.2`，邻接 Harness 源码的 API 不得未经验证便视为已安装版本的 API。Task 3 的输出必须包含实际可运行的插件清单、版本、布局扩展点和构建测试；门禁失败时保留原入口并报告具体兼容问题，不以仿制聊天 UI 替代。实施中先读取所在仓库及父目录的 AGENTS.md；本计划不授权升级整个 Harness 或修改其上游源码。

## File responsibilities

| 文件（相对本工作树） | 职责 |
| --- | --- |
| `apps/sheets/src/renderer/agent/read-targets.ts`（新增） | A1 地址/有限矩形范围展开、去重和上限 |
| `apps/sheets/src/renderer/agent/sheets-command.ts` | 读取前等待范围就绪，将逐格地址送入 reader |
| `apps/sheets/src/renderer/ai/workbook-readers.ts` | 返回逐格值、原始值、公式；缺失工作表明确失败 |
| `packages/nexusdesk-runtime-host/src/sheets-tools.ts` | 匹配真实读取契约的模型工具描述 |
| `packages/nexusdesk-runtime-host/src/office-session-binding.ts`（新增） | 文档/Host/Session 绑定、提交快照校验 |
| `packages/nexusdesk-runtime-host/src/index.ts` | 持久化目录与官方插件组合接入，继续注册原生 Office 工具 |
| `packages/nexusdesk-runtime-host/profile/package.json`、`cordis.patch.yml` | 经过启动验证的受限官方插件清单 |
| `apps/local-host/src/harness-supervisor.ts`、`server.ts` | 生命周期、鉴权后的官方入口与传输路由 |
| `packages/nexusdesk-runtime-host/src/office-interactions.ts`（新增） | 问题 answerer、具体审批与结果关联 |
| `packages/nexusdesk-web-client/src/harness-panel.ts`（新增） | 经验证的嵌入入口挂载/卸载与文档上下文传递 |
| `packages/nexusdesk-web-client/src/approval-dialog.ts`、`agent-loop-runtime.ts` | 原生入口激活时关闭旧聊天/临时卡片渲染，避免双消费 |
| `apps/sheets/src/renderer/App.tsx`、`apps/docs/src/renderer/App.tsx`、`apps/slides/src/renderer/App.tsx` | 原有聊天区域接入共享入口，保留编辑器 |

## Task 1: 修复 Sheets 范围读取

**Interfaces:** 新增 `expandReadTargets(addresses: readonly string[], maxCells = 10000): string[]`；输入仅允许单格或有界 A1 矩形，校验 Excel 行列边界。`read_sheet` 返回逐格键，不能保留 `"A1:C3": { value: null }` 伪结果。加载失败返回工具错误，不返回假空格。

- [ ] 新增 `apps/sheets/tests/read-targets.test.ts`，先运行失败测试：

```ts
import { expect, test } from 'vitest'
import { expandReadTargets } from '../src/renderer/agent/read-targets'
test('expands and deduplicates selected cells', () => {
  expect(expandReadTargets(['C1:C3', 'C2'])).toEqual(['C1', 'C2', 'C3'])
})
test('rejects unbounded or oversized targets before allocation', () => {
  expect(() => expandReadTargets(['C:C'])).toThrow()
  expect(() => expandReadTargets(['A1:XFD1048576'])).toThrow()
  expect(() => expandReadTargets(['A0'])).toThrow()
})
```

- [ ] 执行 `npm run test -w @genoffice/sheets -- tests/read-targets.test.ts`，确认因新模块不存在失败。
- [ ] 实现严格地址解析，先计算矩形面积并限制总格数，再按行列展开和去重；接入 `sheets-command.ts`。在 lazy 路径复用现有范围加载能力并等待完成，然后读取；显式工作表不存在时拒绝，禁止回落到活动表。
- [ ] 在 `apps/sheets/tests/sheets-command.test.ts` 新增真实命令层用例：A1/B1 空而 C1:C3 为 1/2/3，响应包含 C1/C2/C3；延迟加载完成前不能返回；加载抛错不得返回 null；公式保留 formula 与 computed/raw 值。
- [ ] 运行新增测试及现有 hydration/revision 测试；验收逐格结果为 1/2/3，读操作没有触发 mutation/save。仅提交本项文件。

## Task 2: 建立持久化、隔离的 Office Session

**Interfaces:** `OfficeTurnContext = { hostId: string; documentId: string; editorType: 'sheets' | 'docs' | 'slides'; revision: string; selection: unknown }`；边界将品牌 ID 转为字符串。`selection` 必须经过对应编辑器 schema 校验，不能任意透传。`bindOfficeSession(hostId: string, documentId: string): Promise<string>` 返回稳定持久化 Session ID。使用官方持久化 Session，不用自制 JSON 聊天记录取代它。

- [ ] 新增 `packages/nexusdesk-runtime-host/tests/office-session-binding.test.ts`，固定以下断言：相同 Host/文档重启后同 Session；不同文档/Host 不同 Session；提交后的 selection 不随原对象变化；不合法选区拒绝。
- [ ] 运行 `npm run test -w @nexusdesk/runtime-host -- tests/office-session-binding.test.ts`，确认未实现时失败。
- [ ] 在 `office-session-binding.ts` 保存文档映射并冻结经 schema 验证后的提交上下文；Host 从已授权编辑器注册信息确认身份，不能信任 iframe 自报的文档权限。
- [ ] 修改 `index.ts`：生产 Session 使用应用数据目录下专用持久化空间，停止在退出钩子中删除它；烟测仍使用隔离临时目录。恢复只加载事件，不重发历史工具调用。
- [ ] 测试重启、文档切换、并发标签页和旧事件到达；运行 runtime-host 测试与 typecheck，提交本项差异。

## Task 3: 通过官方 Web 组合与受限入口门禁

**Interfaces:** 入口挂载契约为 `mountHarnessPanel(container: HTMLElement, binding: { documentId: string; editorType: 'sheets' | 'docs' | 'slides' }): Promise<() => void>`。这是 NexusDesk 新接口，不是假定 Harness 存在的 API。返回函数负责卸载、监听清理，不销毁持久化 Session。

- [ ] 先记录安装版与邻接源码版本，读取官方 `client/web`、`client/ui-chat`、`client/ui-layout`、`host/frontend-static`、`bundle/web-app` 的入口、清单、exports。将具体依赖和插件 row ID 记录在新增 `docs/harness-office-composition.md`，只采用安装版实际支持的公开入口。
- [ ] 新增 `packages/nexusdesk-runtime-host/tests/office-web-composition.test.ts`：真实 profile 启动后全部客户端插件激活；会话视图来自官方 ui-chat；存在原生 Office 工具与 ask_user_question；不存在 shell、任意文件读写或无关委派能力。未接入时测试必须失败，不能 mock 成功的 boot graph。
- [ ] 更新 profile 和依赖锁定文件，在同一 runtime 中装配官方 Web 插件与 Office 专用布局。客户端通过官方 `new AppWebEntry(container).run()` 启动；布局基于核实的 slot/service 扩展，不深层导入私有 React 文件。若安装版本缺少扩展点，停止本任务并记录具体缺失符号及支持版本。
- [ ] `server.ts` 与 `harness-supervisor.ts` 接入经过 Local Host 认证的同源路由；官方 webserver 若使用内部监听，只绑定 loopback，未鉴权直连也不得访问会话/控制接口。HTTP 与 WebSocket 都检查身份和来源；不把 process token、API Key 放入模型上下文或日志。
- [ ] 构建并跑真实启动 smoke；记录 boot graph 成功、未认证请求拒绝、恶意 Origin 拒绝、跨文档 Session 拒绝、前端资源无密钥。门禁全部通过后才启用新的面板开关，提交本项差异。

## Task 4: 原生选择卡片与具体操作审批

**Interfaces:** 使用官方 `user-questions/request` 请求/答案类型，不再自造“回复数字”协议。Office 审批继续以既有 proposal/planHash/operationId 为权威；问题答案只决定方案，不直接授予写权限。

- [ ] 新增 `packages/nexusdesk-runtime-host/tests/office-interactions.test.ts`，构造真实 scoped answerer：点击选项返回同一 request 的 selected；自定义答案返回 custom；取消终止等待；不存在 answerer 明确失败；问题等待超过 110 秒仍可回答。
- [ ] 运行 `npm run test -w @nexusdesk/runtime-host -- tests/office-interactions.test.ts` 确认失败，再在 `office-interactions.ts` 注册 answerer 并接入官方工具/UI 交互模型。
- [ ] 写入审批描述从实际 DSL 生成，显示工作表名称、格子、原值/新值或公式；AI 先说明用途与影响。对比实际计划后再展示。主文案不显示工具名/hash/JSON，技术详情折叠。不得把 AI 解释作为唯一审批依据。
- [ ] 在相同测试文件覆盖批准一次、双击、拒绝、过期、断线后迟到答案；明确断言写入次数分别为 1/1/0/0/0，未知结果不自动重试。
- [ ] 原生入口启用时禁用旧 `approval-dialog.ts` 卡片和旧 loop 的事件消费。将等待、已选择、执行中、成功、失败、未知结果接到真实事件；取消/卸载清理监听。运行 runtime-host 与 web-client 测试并提交差异。

## Task 5: Sheets → Docs → Slides 接入与验收

**Interfaces:** 三个 App 使用 Task 3 的共享挂载接口，提交上下文使用 Task 2 的绑定。模型列表读取 Host 的真实配置；浏览器只有展示项和选择 ID，没有凭据。

- [ ] 新增 `packages/nexusdesk-web-client/tests/harness-panel.test.ts`：卸载清理、重复挂载不重复订阅、切换文档拒绝旧事件、无认证显示明确故障；运行 `npm run test -w @nexusdesk/web-client -- tests/harness-panel.test.ts` 先确认失败。
- [ ] 实现 `harness-panel.ts` 并先接 Sheets，保留右侧原有表格、工具栏与选区。确认普通“求和”只调用读取工具回答 6，没有写公式、审批或保存。
- [ ] Docs 和 Slides 用同一挂载接口替换聊天区域；Web 分支不回退 Genspark 登录。每个编辑器分别验证读取、批准一次写入、拒绝零写入、保存后重开；不改本次范围外的 PDF/其他编辑器。
- [ ] 用测试文件执行浏览器验收：C1:C3 输入 1/2/3 → 选区求和得 6；请求把合计写入 C4 → 中文说明与 `=SUM(C1:C3)` 一致 → 选择取消没有写入 → 新请求批准仅写一次；问答卡自定义回答正确回到 Agent。
- [ ] 继续验证两份文档并开、切换工作表、回答前改变选区、刷新、Host 断开与恢复。没有无限思考；未核实状态不得标为未发送，不自动重发写入。浏览器验证使用隔离测试文件，不刷新用户未保存工作。
- [ ] 执行相关 workspace 的 test/typecheck 和 `npm run build:web`；原有失败单独列出基线与本次新增失败，不以部分通过宣称全通过。记录 `docs/harness-office-panel-verification.md`，包括实际 URL、版本、测试结果、未解决项，再提交本项差异。

## Self-review

- 设计六项验收分别对应 Task 1/5、4/5、4、2/4/5、3/5、2/5。
- 入口兼容性仍是明确技术门禁，不将未经运行核实的插件组合写成已可用。
- 首个可独立交付结果是范围读取修复；最终交付必须是官方持久化会话与交互卡片，不是原面板改名。
- 暂不包含全 DSL 能力审计、协作、Electron 包装、其他编辑器，以及对历史不明操作的盲目重试。
