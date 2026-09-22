# Harness Office 面板验收记录

日期：2026-09-23。分支：`feat/nexusdesk-local-web`。

## 当前范围

本地 Web 平台在 Sheets、Docs、Slides 的原有编辑器侧栏内挂载官方 Harness 0.1.6-alpha.2 界面。首页、文件标签、编辑器画布仍由 GenOffice 管理；聊天侧栏不再创建 Harness iframe，也不启动第二个通用 Harness 服务。官方会话、输入框、模型选择、提问和审批组件通过同一个 Local Host 与当前文档绑定。Host 保管供应商凭据；Office 工具使用三个编辑器现有的语义操作 DSL，不经 MCP。

本次**不是**所有底层编辑 API 工具化的验收，也不包含新编辑器、协作、桌面打包或任意工作区访问。

## 浏览器与持久化验收

隔离的测试服务位于 `http://127.0.0.1:65219/`，使用独立临时文档和运行时目录。启动该服务必须使用项目要求的 Node 22+；本轮使用 Node 24.20.0 和 `--no-experimental-webstorage`。系统默认 Node 20 曾导致 Runtime 子进程退出、侧栏无法绑定，因此不能用默认 Node 20 复现成功路径。

| 项目 | 状态 | 核对结果 |
| --- | --- | --- |
| 三编辑器原生侧栏 | 通过 | 刷新后 Sheets、Docs、Slides 各自显示官方聊天输入框与模型选择；原编辑画布、首页和文件标签仍在。聊天自身无 iframe；编辑器作为 Shell 子页面的 iframe 保留。 |
| Sheets 只读与选区 | 通过 | `Sheet1!A1:A3` 为 1、2、3，Agent 只读回答总和 6；选区标签显示 `A1:A3`，没有 apply/save。 |
| Sheets 审批、写入和保存 | 通过 | 拒绝 B1=6 后零写入；独立批准 B2=9 和一个标题为「集成验收图表」的新柱状图，读回一致。随后批准保存；独立检查 XLSX 包内 B2、图表 XML 和数据引用。未重放此前结果未知的旧请求。 |
| Docs 读取、提问、编辑和保存 | 通过 | 读取真实段落，将隔离文档日期从 2026 年 7 月改为 8 月，批准后读回。首次保存结果未知时没有重发旧操作；核对账本及磁盘后对当前快照发起新的保存。独立 DOCX XML 检查为 8 月。 |
| Slides 读取、审批、编辑和保存 | 通过 | 按真实 DSL 签名修改测试演示稿标题及一次新的副标题，批准后画布立即更新、读回并保存；独立 PPTX XML 检查新副标题。服务重启后又提交不同的新提案并点拒绝，真实工具返回中文 `APPROVAL_DENIED`，只读读回仍是旧值，未保存。 |
| 会话与文件隔离 | 通过 | 在三个文件标签间切换，分别显示各自历史、选区和工具目标；跨文档绑定与审批拒绝也有 Runtime/Host 自动化测试。 |
| 断线恢复 | 通过（已记录的浏览器验收） | Host 重连后聊天和草稿保留，恢复后只读请求可执行；恢复逻辑不自动重发 prompt 或写入。 |
| 首次挂载故障恢复 | 自动化通过，浏览器故障注入未测 | 新增失败提示、手动“重试连接”和注册等待文案；两组组件回归测试先失败后通过。未在当前浏览器人为破坏官方模块加载。 |

浏览器截图检查：Slides 官方输入框、模型菜单和历史位于左侧栏；幻灯片画布仍完整可见，聊天浮层没有覆盖画布。刷新当前测试页后仍可见三个文件标签及各自的官方会话。隔离服务随后在保留原测试目录的前提下使用 Node 24 安全重启，HTTP 200，Docs 侧栏与 8 月文档内容恢复。服务重启后的新 Slides 拒绝提案显示具体中文审批摘要；展开工具调用可见实际输出为 `{"ok":false,"summary":"未获批准，演示文稿未修改。","warnings":[{"code":"APPROVAL_DENIED",...}]}`。历史消息里保留了修复前的英文错误文本；它们不会追溯翻译。

## 最新自动化结果

- Runtime Host：125/125；Web Client：62/62；官方面板 UI：19/19；Local Host：236/236（`--testTimeout=30000`）。这四个工作区的类型检查通过，Runtime 与面板构建通过。
- Sheets 类型检查与 Web renderer 构建通过；新增侧栏回归测试后完整 Vitest：2841/2843，仍有 2 项失败：`pivot-roundtrip.e2e` 所需的 `/Applications/LibreOffice.app/Contents/MacOS/soffice` 不存在；`xlsx-sidecar-cancel` 的关闭顺序断言单独失败。后者不是环境缺少 LibreOffice，不应合并描述。
- Docs 类型检查与 Web 构建通过；完整测试：2543/2544。`protect-dialog` 的密码保护断言在全套并发运行中失败，单文件以 30 秒超时重跑为 8/8，不能据此宣称全套通过。
- Slides 类型检查与 Web 构建通过；完整测试：870 通过、4 项系统字体替代断言失败、5 项跳过。实际机器的 Yu Gothic、Malgun Gothic、Calibri 可用，与测试预期的 Hiragino、Apple SD Gothic Neo、Carlito 不同。浏览器编辑链路和定向 bridge/工具测试不依赖这些字体断言。
- `git diff --check` 在本轮检查时通过。构建提示大 chunk 警告，未当作构建失败。

## 未完成与边界

1. Sheets、Docs、Slides 的**全套测试尚未全部变绿**，上述失败需分别处理或给出可复现的环境基线。不要把定向通过写成全套通过。
2. 首次官方模块加载失败后的“重试连接”只在组件测试中验收，尚缺浏览器故障注入；现有浏览器成功启动路径已验证。
3. 工具能力边界是当前官方三编辑器 DSL，而非每个底层 Engine API 的逐一工具化。

## GitHub 发布前复核（2026-09-23）

- 全仓库 `npm run typecheck` 通过；`npm run build:web` 通过。构建时发现共享 Web Client 根入口把 Harness 面板模块带入 PDF；将面板改为独立包入口后，PDF 构建及完整 Web 构建均通过。
- Node 24.20.0 下根目录 `npm test` 已通过 Protocol 16/16、Local Host 240/240、Runtime Host 125/125、Web Client 62/62、i18n 19/19；随后停在上游 Electron Utils 的 `remote-image.test.ts`：9 项中 4 项失败。本机 DNS 把 `sspark.genspark.ai` 解析为 `198.18.0.11`、`2001:2::f`，SSRF 防护按设计阻断保留地址，测试的假 `fetch` 因此未被调用。不能把这次根目录测试写成全绿。
- 另行通过：官方面板 UI 19/19，Docs 定向 11/11，Sheets 定向 4/4，Slides 定向 7/7，PDF 完整 832/832。它们不替代其他编辑器的完整测试。
- 系统 Node 26 下 Local Host 集成测试曾超时；同一测试在 Node 24 下单独和全套均通过。因此 README 建议使用 Node 24 LTS。
