# GitHub Issue 处理建议

在公开 GitHub Issue 页面点击「生成处理建议」，面板会引用当前标题和链接，列出摘要、调查证据、可能根因、可验证的处理步骤和待澄清信息。补充一句背景后，面板在同一个 Session 显示下一版及变化原因。

## 本地启动

需要 Python 3.12、uv 和桌面 Chrome。在项目根目录执行：

```sh
uv sync --locked --python 3.12
cp -n .env.example .env
```

在本机 `.env` 填入 `LLM_API_KEY`，确认 `LLM_BASE_URL` 和 `LLM_MODEL` 对应账户可用的 DeepSeek Chat Completions 模型。也可通过服务进程的同名环境变量提供配置。模型调用在本机后端发出。浏览器只连接回环地址。可选的 `GITHUB_TOKEN` 用于公开仓库读取；若配置令牌，建议仅授予公开仓库读取权限。模型会收到当前 Issue、你输入的背景和调查涉及的公开源码片段。

```sh
uv run --locked python -m backend
```

在 macOS 或 Linux 可改用后台管理命令，日志写入项目的 `.runtime/backend.log`。服务与终端分离，重启电脑后需重新启动。

```sh
uv run --locked python -m scripts.service start
uv run --locked python -m scripts.service status
uv run --locked python -m scripts.service stop
```

在 Chrome 的扩展程序页开启开发者模式，选择「加载已解压的扩展程序」，选本项目的 `extension/`。如果已经加载过，点扩展卡片上的重新加载，再刷新 Issue 页面。打开 [DeepWiki #585](https://github.com/AsyncFuncAI/deepwiki-open/issues/585)，点击右下角按钮。

## 题目必需功能与增强功能

| 层级 | 实现 |
|---|---|
| 必需 | 手动触发、读取当前 Issue 标题和正文、展示来源与三类建议、在同次分析中结合新增信息更新。 |
| 本次增强 | 单 Agent 自主选择检索、固定提交的源码行引用、竞争假设与验证方法、修订解释、只读边界、工具记录与限流降级。 |
| 后续可选 | AST 符号索引、更大仓库的全文索引、跨进程持久化 Session。 |

## 架构与工具

```text
Chrome content script → MV3 service worker → FastAPI /sessions
                                                ↓
                                            Session
                                                ↓
                               mini-SWE-agent DefaultAgent ↔ DeepSeek
                                                ↓
                                   只读工具环境 / 报告提交校验
                                                ↓
                                     公开 GitHub 固定提交
```

模型通过原生 function calling 选择下一步。上游 `DefaultAgent` 执行决策、动作、观察循环。工具的实现、边界、证据台账、Session 和重新规划都在 Python 后端。Node 仅用于开发期的浏览器验收。

| 工具 | 可回答的问题 |
|---|---|
| `glob(pattern)` | 哪些路径可能相关？返回最多 32 个候选，包括可传给后续工具的文件 ID。 |
| `grep(text, path_glob)` | 指定范围内哪些行出现字面文本？最多扫描 16 个候选文件并返回 12 处命中，同时返回覆盖范围。 |
| `read_file(file_id, start_line, end_line)` | 代码上下文实际做了什么？只能读取本会话已发现的文件，一次最多 80 行、12000 字符。 |
| `submit_analysis(report)` | 已有证据能支持什么建议？Pydantic 校验结构，服务端核对所有证据 ID；校验失败允许修正一次。 |

一版最多 8 次仓库调用、12 次模型调用。对笼统症状可以零检索直接提交澄清问题。有明确堆栈时，工具可以从路径和符号逐步定位源码。枚举路径和搜索命中只提供线索，读到的源码片段才生成 R 编号。

### 状态、Prompt 和输出

`POST /sessions` 接受 `issueUrl, requestId` 并返回 202。`GET /sessions/{id}` 返回进行中、成功或失败的状态。`POST /sessions/{id}/context` 接受 `text, baseRevision, requestId`。重复请求幂等，冲突返回 409。更新失败保留旧版报告和草稿。Session 在内存中保存，闲置 60 分钟到期，每个会话最多 9 版。

每次修订输入原 Issue、旧版报告、稳定的假设编号、历次背景和证据。模型自主决定继续调查或直接更新。报告按优先级排列假设，分开记录支持和削弱该解释的证据。每个步骤同时给出操作和预期观察。本次变化必须指向本轮新增背景。实际调用次数由后端记录。

| 报告字段 | 含义 |
|---|---|
| `issue, summary` | 来源标题、链接及问题摘要 |
| `evidence` | I1 为用户原始报告，C 为补充，R 为固定提交的准确行段 |
| `hypotheses` | 稳定 ID、待验证解释、支持与反向证据、如何验证 |
| `steps, clarifications` | 建议动作及判断依据，尚待确认的问题及其影响 |
| `changes, limitations, investigation` | 本次修改原因、覆盖限制、实际检索和模型调用次数 |

Prompt 和模型接口在 [backend/agent.py](backend/agent.py)，精确字段与约束在 [backend/schemas.py](backend/schemas.py)，两版完整 JSON 见 [真实运行记录](docs/evidence/run.json)。

### 仓库和凭证边界

后端只监听 `127.0.0.1:43117`，校验 Host、扩展 Origin 和客户端标识；外部网站无法作为扩展调用接口。本机原生进程仍属于信任边界。Issue 正文、补充和文件内容均作为数据。工具白名单决定实际能力，工具层没有 shell、文件写入、GitHub 发布或任意 URL 请求。工具只允许公开 GitHub 文件，排除链接、子模块和非文本路径。GitHub 令牌仅发往固定 API 主机；源码匿名按 SHA 从公开 raw 域读取。

GitHub API 用尽时，后端可从经过身份核对的公开 Issue 网页恢复原始标题和正文，并在限流期间暂停仓库检索。403 权限拒绝、401 凭证无效、Issue 不存在分别报告。缓存的提交只说明当前仓库版本，报告者部署的版本仍需核对。请求日志和演示记录不包含授权请求头或模型内部推理。

## 测试与演示

```sh
uv run --locked pytest -q
npm ci
npx playwright-core install chromium
npm run test:browser
npm run demo:live
npm run demo:live -- --sparse
```

浏览器回归启动临时端口的 Python 服务和独立 Chromium，覆盖站内导航、失败重试、版本恢复、文本注入和 Issue 隔离。最后两条命令需要已启动的真实后端和可用模型，会实际调用 GitHub 与 DeepSeek，产物写入 `demo-output/`。验收结论、截图与局限见 [演示记录](docs/demo.md)。

## 目录

```text
backend/       app.py、sessions.py、agent.py、schemas.py、github.py、common.py、启动入口
extension/     Manifest V3、内容脚本、服务工作线程、URL 解析、面板样式
scripts/       后台启停、浏览器启动、真实演示
tests/         GitHub、Agent、HTTP/Session、真实扩展的确定性回归与 fixtures
docs/          演示说明和已保存的验收证据
pyproject.toml、uv.lock、.env.example
package.json、package-lock.json  浏览器测试工具与兼容的 npm 入口
```

## 开源来源

- 真正运行的循环来自 mini-SWE-agent 2.4.6。项目通过模型和环境协议接入 DeepSeek 与只读工具。[DefaultAgent 源码](https://github.com/SWE-agent/mini-swe-agent/blob/v2.4.6/src/minisweagent/agents/default.py)
- 公开 Issue 读取、按需搜索和结构化提交参考 GitHub Issue Triage Agent。[项目仓库](https://github.com/shambhavichaurasia/github-issue-triage-agent)
- 从报错标识符逐步缩小定位范围参考 AutoCodeRover。当前工具实现使用路径和字面文本。[项目仓库](https://github.com/AutoCodeRoverSG/auto-code-rover)
- 竞争解释及各自验证路径参考代码审查项目 OpenReviewer。[项目仓库](https://github.com/Ascent-AI-org/OpenReviewer)
