<p align="center">
  <img src="apps/web/public/offira-mark.svg" alt="Offira" width="72" height="72">
</p>

<h1 align="center">Offira</h1>

<p align="center">
  <strong>在本机打开 Office 文件，让 AI 直接参与编辑。</strong><br>
  基于 GenOffice 编辑器与 DeepSeek Harness 构建的本地 Web 工作台。
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#能做什么">能做什么</a> ·
  <a href="#工作方式">工作方式</a> ·
  <a href="#项目状态">项目状态</a>
</p>

> **开发预览**：目前提供在自己电脑上运行的本地 Web 版本，没有可下载的安装包、云端协作服务或公开演示站点。此仓库保留了上游 GenOffice 的源码与原有命名；Offira 是当前本地 Web 产品的名称。

## 能做什么

- **在一个工作台中编辑文件**：首页、文件标签和编辑器切换共用一套界面，支持 `.docx`、`.xlsx`、`.pptx`、`.pdf`、Markdown 和 HTML。
- **在文件旁使用 AI**：Docs、Sheets、Slides 的侧栏接入 Harness 会话、模型选择和交互组件；AI 使用面向文档的原生工具读取与修改内容，不通过 MCP 桥接编辑器。
- **选择模型供应商**：在「设置 → AI 模型」配置 API Key；模型仍在聊天框里选择。密钥由本机 Harness 凭据服务保存，不回显到浏览器。启动环境提供的密钥保持只读。
- **核对再写入**：文档修改需经过审批。Local Host 绑定文件、会话与操作标识；遇到无法确认结果的写入时，先查询状态，不自动重复提交。
- **本地文件优先**：文件编辑和本地服务运行在你的电脑上。使用在线模型时，请求会发往所选模型供应商；不要把“本地 Web”误解为“所有数据都不离开设备”。

| 编辑器 | 文件类型 | 当前 AI 接入 |
| --- | --- | --- |
| Docs | `.docx` | Harness 原生文档工具与侧栏 |
| Sheets | `.xlsx` | Harness 原生表格工具与侧栏 |
| Slides | `.pptx` | Harness 原生演示工具与侧栏 |
| PDF、Markdown、HTML | `.pdf`、`.md`、`.html` | 本地 Web 编辑器及对应工具链；具体能力仍在持续验收 |

## 快速开始

建议使用已验证的 Node.js **24 LTS**、npm **10+** 和 Rust/Cargo（构建 XLSX 引擎）。`package.json` 的最低要求是 Node.js 22.12，但当前完整集成测试尚未覆盖所有更新的 Node 大版本；首次构建会花一些时间。

```bash
git clone https://github.com/het2333/Offira.git
cd Offira
npm ci
npm run build:web
npm run start:web -- "/绝对路径/示例.xlsx"
```

也可以一次传入多个现有文件：

```bash
npm run start:web -- "/绝对路径/文档.docx" "/绝对路径/表格.xlsx" "/绝对路径/演示.pptx"
```

启动后，打开终端输出的 `bootstrapUrl`，由它进入本机工作台。当前本地启动模式会给出 `http://127.0.0.1:<端口>/`，端口每次可能不同；不要把服务暴露到公网。**不要直接用 `file://` 打开 `apps/web/index.html`**。当前启动命令要求至少提供一个已存在的文件路径，支持 `.docx`、`.xlsx`、`.pptx`、`.pdf`、`.md` 和 `.html`。

进入「设置 → AI 模型」配置 DeepSeek、OpenAI、Anthropic、OpenRouter、Gemini 等供应商的 API Key，再在编辑器聊天框中选择可用模型。旧版 `providers.env` 的 API Key 会在下次启动时导入 Harness 的本机凭据存储；原文件不会自动删除。请勿把真实密钥提交到 Git。

## 工作方式

```text
浏览器：Offira 首页与 GenOffice 编辑器
             │ HTTP / WebSocket（仅本机回环地址）
             ▼
Local Host：文件授权、会话绑定、审批、持久化与恢复
             │ 私有进程通信
             ▼
DeepSeek Harness：模型供应商、会话与原生 Office 工具
```

Offira 复用 GenOffice 的文件格式引擎和编辑器界面，而 Harness 负责 Agent 运行时与多模型供应商。工具调用使用各编辑器的语义操作 DSL，返回适合 Agent 理解的摘要与结果；底层 Engine 对象不直接暴露给模型。这里的“原生工具”指直接接入 Harness 的工具，不是把数百个底层 API 逐一包装，也不是通过 MCP 转接。

源码入口：

- `apps/web`：本地 Web Shell。
- `apps/local-host`：本机 HTTP/WebSocket 服务与文件权限边界。
- `packages/nexusdesk-runtime-host`：Harness 进程及 Office 工具接入。
- `packages/nexusdesk-shell-ui`：共享首页、设置与文件标签。
- `apps/docs`、`apps/sheets`、`apps/slides`：三个主要 Office 编辑器。

## 项目状态

当前重点是本地 Web 编辑与 AI 工作流的可靠性。以下内容**尚未作为 Offira 正式交付**：桌面安装包、云端同步、多人协作、对所有底层编辑 API 的逐项工具化。上游 GenOffice 的 CLI、MCP、下载页面和截图不等同于 Offira Web 版的现有功能。

测试入口：

```bash
npm run typecheck
npm test
npm run test:e2e:local-web
```

部分完整测试依赖本机字体、LibreOffice 或原生构建环境；若某项失败，请先看具体测试输出，不要把环境差异当作全部编辑链路已通过或已失败。当前的验收记录见 [`docs/harness-office-panel-verification.md`](docs/harness-office-panel-verification.md)。

## 来源与许可

Offira 是在 [GenOffice](https://github.com/genspark-ai/genoffice) 的 Apache-2.0 开源代码基础上开发的独立本地 Web 工作台，并使用 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 作为 Agent 运行时。感谢两个项目的维护者与贡献者。本仓库保留了原项目的 [`LICENSE`](LICENSE) 与 [`NOTICE`](NOTICE)；各依赖仍遵循其各自许可证。Offira 与 GenOffice、DeepSeek 官方产品没有从属关系。
