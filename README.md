# GitHub Issue 处理建议

在公开 GitHub Issue 页面点击 **生成处理建议**，从原始标题和正文得到摘要、带验证标准的处理步骤、待澄清信息。补充一句背景后，面板会展示同一会话的新版本和判断变化。

## 运行

需要 Node.js 22.9 或更高版本、桌面 Chrome，以及支持 Chat Completions 函数调用的远程模型。扩展可以直接加载。后端可匿名读取 GitHub，也可用一个只读 GitHub 令牌提高调用额度。

```sh
npm ci
cp -n .env.example .env
```

在本机编辑 `.env`。模板已填入 DeepSeek 官方端点和模型，只需设置自己的 `LLM_API_KEY`。如使用其他兼容服务，请同时更换基础地址和模型名，基础地址应截止到版本前缀，服务会追加 `/chat/completions`。[DeepSeek 接入文档](https://api-docs.deepseek.com/)

```dotenv
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-flash
LLM_API_KEY=
```

1. 在项目根目录运行 `npm start`，终端显示服务监听 `127.0.0.1:43117`。
2. 打开 `chrome://extensions`，开启「开发者模式」，选择「加载已解压的扩展程序」，选中项目内的 **extension** 目录。
3. 打开或刷新 [AsyncFuncAI/deepwiki-open 的 Issue #585](https://github.com/AsyncFuncAI/deepwiki-open/issues/585)，点击右下角的「生成处理建议」。标题链接指回正在分析的 Issue。其他公开仓库使用相同流程。
4. 在「补充背景」输入新观察并点击「更新建议」。面板显示第 2 版及「本次更新」。展开「假设、证据与本轮工具记录」可核对实际引用。完整验收步骤见[演示文档](docs/demo.md)。

**可选的 GitHub 凭证。** 创建 fine-grained personal access token，仓库范围选 **Public repositories**，保留默认公开只读权限即可。把令牌填入项目根目录本机 `.env` 的 `GITHUB_TOKEN=` 一行，保存后点击「重新分析」或在新 Issue 点击「生成处理建议」。每个新会话读取一次配置；未在文件内设置该字段时使用进程环境变量。同一个会话继续使用创建时的凭证。本地 `.env` 已加入 Git 忽略列表。个人令牌通常共享账户每小时 5,000 次的 REST API 主额度。[创建令牌](https://github.com/settings/personal-access-tokens/new) · [GitHub 额度](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)

**数据流向。** 本地后端把 Issue 标题、正文、必要的仓库片段及用户补充发送给配置的远程模型。Session 仅驻留本机内存。扩展的临时存储用于页面恢复和请求重试。密钥只由后端读取；提交或分发项目时使用 `.env.example`。

## 题目要求与加分项

| 题目必需 | 首版加分 |
|---|---|
| 从当前 Issue 定位并读取标题、正文 | 按需定位相关文件并读取固定提交中的源码、文档、测试 |
| 标题、原链接、摘要、步骤和待澄清项 | 假设的验证方法、逐步可观察结果、可点击的行号证据 |
| 同一分析中补充一句背景并更新 | 版本差异、已回答问题的撤下、失败重试、刷新恢复 |

项目面向公开的 `github.com` 仓库。GitHub 侧只有读取操作。分析的触发点为用户点击，后端无需 Webhook、事件订阅或克隆仓库。

## 单 Agent 与工具

```text
GitHub Issue 页内面板
    └── Service Worker 核对当前标签页，转发到本地 HTTP 服务
          └── Session 保存快照和版本
                ├── read_issue 从 GitHub 取得原始标题和正文
                └── 远程模型评估现象、约束与信息缺口
                      ├── search_repo → read_excerpt → 回到模型
                      └── submit_analysis → 后端校验 → 面板
```

| 工具 | 谁决定调用 | 输入和输出 |
|---|---|---|
| `read_issue` | 后端在新会话中调用 | 根据当前页的仓库与编号读取原始 Markdown，登记证据 I1；空正文或读取上限进入分析限制。 |
| `search_repo` | 模型 | 输入路径关键词和目的，最多返回 8 个候选文件及 fileId。首次检索固定默认分支提交。返回的 scope 标明按路径搜索，未命中不代表全仓没有相关实现。 |
| `read_excerpt` | 模型 | 输入已登记的 fileId、文件内字面关键词和目的，读取命中位置的上下文。返回 R 编号、固定提交与行号。空关键词从文件开头读。 |
| `submit_analysis` | 模型 | 通过工具调用提交分析字段。服务校验结构、证据编号及本轮背景引用，填入真实 Issue 元数据、证据目录和版本。 |

**决策依据。** 运行环境等只有报告者掌握的事实进入澄清问题。实现或测试中的行为可能改变方案时才读仓库。模型可以直接提交，也可以在看到一次检索结果后换词、换文件或结束检索。仓库树最多展示此次返回的范围，每轮最多 4 次仓库调用。预算用完后，工具列表只保留结果提交。模型协议使用自动工具选择，兼容 DeepSeek 思考模式。[DeepSeek 工具选择说明](https://api-docs.deepseek.com/api/create-chat-completion/)

**Prompt 与校验。** `server/prompt.js` 保存完整系统指令。Issue、补充、上版结果和证据以带来源的 JSON 传入，工具输出以 tool 消息回传。指令要求模型区分报告与推断，为假设写出能推翻它的观察。Ajv 校验每次调用的参数和结果，拒绝额外字段、无效结构与虚构编号。引用存在性可以程序验证；文件片段是否支持某项推断仍需核对原文。

**工具权限。** 模型可传搜索词和文件编号。后端生成 GitHub API 路径，在当前仓库执行 GET；配置令牌时，每次读取内容前核对仓库为公开，认证头仅发送到 `api.github.com`，拒绝重定向，只读固定提交的普通文本文件。单文件限 384 KiB，单段限 80 行和 4000 字符。Issue 或文件内的 URL 和命令作为普通文本处理。面板通过文本节点渲染，来源链接由后端生成。后端校验回环 Host、扩展客户端标识以及浏览器提供的 Origin；本机进程处于同一信任边界。

## Session 与 HTTP 接口

会话绑定标签页和规范 Issue 地址。后端生成随机 ID，保存原始快照、累计证据、补充和上一版成功结果。补充背景登记为 C1、C2 等，重规划可以复用已有代码证据。一次最多补充 8 轮，约 60 分钟未访问会过期，重启后端会清空会话。

| 请求 | 输入 | 返回 |
|---|---|---|
| `POST /sessions` | `issueUrl, requestId` | HTTP 202，含 sessionId、status、revision |
| `GET /sessions/:id` | 会话 ID | 状态、当前成功结果、本轮调用记录、待处理补充和错误 |
| `POST /sessions/:id/context` | `text, baseRevision, requestId` | HTTP 202，在同一会话开始更新 |

请求编号采用 UUID。相同提交重试复用原操作；并发更新或过期版本返回 409。分析状态依次为 `running → ready / failed`。只有通过校验才递增 revision，失败保留上一版结果和本次输入。面板打开且分析运行期间短轮询，模型调用持续时间不依赖 Service Worker 的生命周期。

**结果字段**由 `server/schemas.js` 定义。

| 字段 | 内容 |
|---|---|
| `sessionId, revision, issue` | 会话 ID、成功版本号、真实标题和链接 |
| `summary` | 当前问题摘要 |
| `hypotheses[]` | `claim, evidenceIds, howToCheck` |
| `steps[]` | 按优先级排列的 `action, expectedObservation, evidenceIds` |
| `clarifications[]` | `question, whyItMatters`，信息充分时为空 |
| `changes[]` | `description, evidenceIds`，新版须引用本次补充 |
| `limitations[], evidence[]` | 读取与证据限制；带 ID、类型、摘要或片段及可选链接的证据目录 |

## 测试

```sh
npm test
npx playwright-core install chromium
npm run test:browser
```

第一条覆盖工具循环、只读路由、会话、模型适配器和 HTTP。浏览器测试启动临时后端并加载真实 MV3 扩展，使用固定页面与模型响应覆盖站内导航、失败重试、刷新恢复和会话隔离。该测试需要本地端口 43117 空闲。真实验收使用 `npm start` 和另一终端中的 `npm run demo:live`，后者会实际调用已配置的模型，并导出两版面板截图和 JSON。

## 项目目录

```text
github-issue-advisor/
├── README.md
├── .env.example
├── .gitignore
├── package.json
├── package-lock.json
├── extension/
│   ├── manifest.json
│   ├── content.js
│   ├── panel.css
│   ├── issue-url.js
│   └── service-worker.js
├── server/
│   ├── index.js
│   ├── sessions.js
│   ├── agent.js
│   ├── prompt.js
│   ├── model.js
│   ├── github.js
│   ├── tools.js
│   ├── schemas.js
│   └── errors.js
├── scripts/
│   ├── browser.js
│   └── demo-live.mjs
├── test/
│   ├── agent.test.js
│   ├── api.test.js
│   ├── github.test.js
│   ├── sessions.test.js
│   ├── browser-smoke.mjs
│   ├── helpers.js
│   └── fixtures/
│       ├── issues.json
│       └── model-turns.json
└── docs/
    ├── demo.md
    └── evidence/
        ├── revision-1.png
        ├── revision-2.png
        └── run.json
```

## 故障定位

| 症状 | 处理 |
|---|---|
| 页面没有按钮 | 检查是否加载了 `extension/` 并刷新页面。入口在 `github.com/所有者/仓库/issues/正整数` 的右下角。 |
| 无法连接本地后端 | 在项目根目录运行 `npm start`，检查 43117 端口和终端启动信息。 |
| 提示模型配置或 HTTP 401 / 402 | 核对后端的基础地址、模型名、密钥和账户余额；修改配置后重启。 |
| GitHub API 限流 | 后端在冷却期内从匿名可见的 Issue 网页提取原始标题和正文，核对仓库、编号及公开属性后继续生成。仓库检索在额度恢复后可用。结果中的「分析限制」会标明此次依据。 |
| 更新失败或会话已过期 | 更新失败可修改或重提交保留的背景。过期或后端重启后，在当前页重新生成。 |
