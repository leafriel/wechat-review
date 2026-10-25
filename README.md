# 微信审核 Skill 与 MCP

在原调用对话中，通过 Codex 原生桌面卡片和本人微信收集需求选择、方案审核与最终执行确认。**当前仅支持 Windows、Node.js 22+。**

本仓库同时是可独立安装的 `wechat-review` Skill 包和兼容的 MCP server。Skill 直接运行本机脚本，不需要配置或启动 MCP 服务；两种入口共享同一份微信运行代码和用户状态。

## 安装 Skill

源码仓库：[leafriel/wechat-question-skill](https://github.com/leafriel/wechat-question-skill)。

取得本仓库的干净源码，将完整 Skill 包放入用户目录 `~/.agents/skills/wechat-review`，包含 `SKILL.md`、`agents`、`scripts`、`src`、依赖清单及本文档。不要复制 `.git`、`node_modules`、凭据、个人验证记录或 `.planning`。在安装目录运行：

```powershell
npm ci --ignore-scripts
node scripts/cli.mjs status
node scripts/cli.mjs login
```

扫描登录输出路径中的二维码，在手机确认，再给刚连接的机器人发送“绑定”。默认状态目录为 `%LOCALAPPDATA%/CodexWeChatQuestion`，可用 `WECHAT_QUESTION_STATE_DIR` 覆盖；安装或升级 Skill 不移动、复制或重置绑定数据。登录过期时运行 `node scripts/cli.mjs login --force`。登录会先停止空闲接收器；有待答题时需先完成或取消，不能打断其他会话。

Codex 可通过 `$wechat-review` 显式调用，也可在需要澄清需求、选择方案或最终执行确认时自动匹配。自动匹配取决于客户端和模型，不保证每次触发，不是强制安全门禁。完整流程见 [SKILL.md](SKILL.md)；跨项目使用不需要在各项目写入 `AGENTS.md`。如果技能未出现，刷新技能列表或重启客户端。

## 接口说明

`node scripts/cli.mjs ask` 从 stdin **第一行**读取问题 JSON，立即开始等待，不要求关闭 stdin。示例：

```json
{"conversation_title":"真实来源对话标题","conversation_id":"真实会话ID，可省略","question":"数据保存在哪里？","options":["本地文件","数据库"],"context":"项目或任务背景","allow_text":false,"timeout_seconds":300}
```

- `conversation_title`、`conversation_id` 至少提供一个：均为非空单行文本，最多 200 字符。标题优先；没有标题时显示真实 ID，两者都缺失则发送前报错且不占题号。调用方负责提供真实来源，不能用项目名或示例值冒充。
- `question` 为 1–1500 字符；`options` 为 2–6 个不重复选项，每项 1–200 字符；可选 `context` 最多 200 字符，单独表示任务背景。
- `timeout_seconds` 为 15–600 的整数，默认 300 秒。直接 CLI 默认 `allow_text: false`；兼容 MCP 默认仍为 `true`，显式 `true` 时可接受最多 2000 字符的文字答案。
- 保持 stdin 可写时，后续发送独占一行的 `cancel` 可取消本题；SIGINT/SIGTERM 同样取消。首行之后正常关闭 stdin 不表示取消。不要全局停止 broker 来取消单题。
- 最终 stdout 为一行 JSON；`error` 退出码为 1。只有 `status: answered` 是有效回答，包含 `question_id`、`question`、`answer`、`sent`、`answered_at`；选中选项时另有从 1 开始的 `selected_index`、`selected_option`。`cancelled`、`timeout`、`not_connected`、`error` 都不是同意。

微信消息分别列出来源对话、数字题号、任务背景、问题和选项。用户只需回复 `15 2`，表示第 15 题选第 2 项，无需附带对话名或 ID。取消用 `15 取消` 或 `15 cancel`。仅显式允许文字时才显示文字回复说明；裸数字不会作为答案。

微信发送依赖有效登录和本人消息中的会话上下文。收到上下文失效错误或题目未送达时，在机器人聊天发送“绑定”：接收器会在原有效期内用原题号重试；原有效期结束后需重新提问。只有明确的上下文拒绝会重试，网络超时等发送结果不明的情况不会自动重发。

## 并发与运行边界

- 多个 Skill CLI 和 MCP 会话共享一个接收器，按全局数字题号独立路由，可乱序回答；某题取消、超时、失败或断开不会取消其他题。
- 题号从 `1` 递增，发送前持久保存，发送失败可能跳号。最后一道待答题结束后连续空闲满 24 小时，下一题从 `1` 开始；有待答题时不重置。计数和空闲时间跨进程重启、重新登录保留；旧计数器首次升级时从接收器启动开始记录空闲。
- 接收器首次提问时按需启动，空闲 60 秒退出，没有登录启动任务。电脑、网络和原调用方需保持运行；接收器异常退出则待答调用报错，需要重新提问，不替用户选择。
- 只接受已绑定本人的私聊文字，忽略其他用户、群聊及 `@codex` 聊天；不提供独立模型聊天、自动完成通知、图片或语音问答，也不支持 macOS/Linux。
- 账号、游标、会话上下文、题号和本机认证令牌使用 Windows DPAPI 加密；接收器通过认证命名管道通信。直接 Skill 入口不开 TCP 端口，不加载 MCP SDK；依赖清单暂留 SDK 供旧 MCP 入口兼容。

## 原生桌面卡片与最终确认

Skill 同时发出原生桌面异步问题和微信题，代理按首先收到的明确有效回答处理一次。桌面先答则取消对应 CLI；微信先答后标记已处理，忽略原生卡片迟到回答。**当前无法保证撤回 Codex 原生卡片，微信首答后卡片可能残留。** 不以浏览器面板代替原生卡片。单渠道不可用时说明并等待另一边；没有有效答案时保留待决定事项。用户主动撤回或提出新要求仍按最新指令处理。

关键操作准备完成后，确认问题说明本次具体操作、目标、影响和实际验证。`context` 固定为“最终执行确认 · 项目名”，来源对话字段仍单独填写；选项为 `["同意执行","暂不执行","修改方案"]`，`allow_text: false`，有效期 600 秒。仅首个有效回答明确选择“同意执行”才执行已说明操作一次；“暂不执行”停止，“修改方案”调整后重新确认。取消、错误、过期或目标实质变化均不能复用答案。确认不替代平台权限审批。

## 兼容 MCP

既有 MCP 入口保留，配置示例（替换为自己的绝对路径）：

```toml
[mcp_servers.wechat_question]
command = 'C:/Program Files/nodejs/node.exe'
args = ['C:/path/to/wechat-question-skill/src/server.mjs']
startup_timeout_sec = 15
tool_timeout_sec = 660
enabled = true
```

`wechat_status` 返回本地绑定状态，不发消息、不返回凭据，也不代表实时登录一定有效；`ask_wechat` 仍发送并等待单题。**升级后旧调用方也必须补充来源对话字段**，否则返回明确错误。

旧 `start_question`/`wait_question` 和 `src/call.mjs status|ask|dual` 暂留兼容：它们的浏览器面板仅监听 `127.0.0.1` 随机端口，使用随机题目 URL、来源校验和无外部资源页面；不能视为原生卡片同步，新 Skill 不调用它们。面板结果在当前 MCP 连接内保留五分钟后清理，断开时取消；URL 是临时访问凭证，不要分享。修改已加载服务后可能需要重连 MCP，避免中断其他会话的待答题。

## 验证与来源

`npm test` 覆盖真实 MCP stdio、直接 CLI 与 MCP 并发及冷启动、乱序路由、独立取消/断开/超时、来源对话校验与展示、身份和本机认证、DPAPI、空闲退出、题号持久化和 24 小时重置、最终确认各分支、上下文恢复与防重复发送，以及保留面板的兼容行为。自动测试模拟微信，不发送真实消息；CLI 测试拒绝加载 MCP SDK，验证新入口不依赖 MCP。

真实微信往返、双题乱序和无副作用最终确认此前已验证；新增 Skill 已通过真人双渠道验收：一题桌面首答后取消对应微信等待，另一题仍可由微信按数字题号回传。原生卡片自动撤回未实现，微信首答后卡片可能残留。24 小时边界使用模拟时钟，未实际等待一天。术语见 [GLOSSARY.md](GLOSSARY.md)。

微信字段参考腾讯 [@tencent-weixin/openclaw-weixin 2.4.10](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)，未加载 OpenClaw 运行时；兼容 MCP 使用官方 [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)。微信服务或客户端变化可能影响可用性。
