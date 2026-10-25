# 微信问答 MCP

把 Codex 等 MCP 客户端的需求澄清、方案选择和执行确认发到本人微信，收到回答后，在原调用会话继续。**当前仅支持 Windows，需 Node.js 22+。**

## 功能与边界

- **多会话并发**：同一 Windows 用户的多个会话共享一个接收器；每题独立路由，可乱序回答，某题取消、超时、发送失败或调用方断开不会取消其他题。
- **简单题号**：全局数字从 `1` 递增，发送前持久保存，失败可能跳号。最后一道待答题结束后连续空闲满 24 小时，下一题从 `1` 开始；有待答题时不重置，空闲时间跨进程退出、重启和重新登录保留。旧计数器首次升级时从接收器启动开始记录空闲。
- **选项、文字和取消**：微信回复 `1 2` 表示第 1 题选第 2 项；允许文字时可回复 `1 文字答案`；回复 `1 取消` 或 `1 cancel` 取消。只接受已绑定本人的单聊文字，裸数字、其他人的消息及群聊不会作为答案。
- **本机安全存储**：账号、游标、上下文令牌、题号与 IPC 认证令牌用 Windows DPAPI 加密，默认保存在 `%LOCALAPPDATA%/CodexWeChatQuestion`；可用 `WECHAT_QUESTION_STATE_DIR` 覆盖目录。共享接收器使用需认证的命名管道，不开放 TCP 端口。
- **按需运行**：首次提问自动启动接收器，空闲 60 秒退出；没有开机启动任务。电脑、网络和发起任务的客户端须保持运行；接收器异常退出时未完成的调用报错，不替用户选择，需要重新提问。

MCP 只负责微信问答。它不接管现有桌面会话、不拦截内置提问或平台权限弹窗，不提供 `@codex` 聊天、自动任务完成通知，也不支持 macOS/Linux。是否继续执行由原调用代理根据结果决定。

## 安装与连接

```powershell
git clone https://github.com/leafriel/wechat-question-mcp.git
cd wechat-question-mcp
npm ci --ignore-scripts
npm run login
npm run status
```

扫描 `login` 输出路径中的二维码，在手机确认，再给刚绑定的机器人发送“绑定”。微信发送依赖有效登录和本人消息中的 `context_token`；登录过期用 `npm run login -- --force` 重新扫码。会话上下文失效、题目未送达时，在机器人聊天发送“绑定”：工具会在原等待时限内接收本人新上下文，用原题号重试，超过原超时后需重新提问。仅明确的上下文拒绝会重试，网络超时等发送结果不明的情况不会自动重发。登录程序会先停止空闲接收器；有待答题时须先完成或取消，避免影响其他会话。

在 MCP 客户端中配置，例如 Codex 的 `~/.codex/config.toml`（把 Node 和项目路径替换成自己的绝对路径；`node -p "process.execPath"` 可查看 Node 路径）：

```toml
[mcp_servers.wechat_question]
command = 'C:/Program Files/nodejs/node.exe'
args = ['C:/path/to/wechat-question-mcp/src/server.mjs']
startup_timeout_sec = 15
tool_timeout_sec = 660
enabled = true
```

新增配置或升级已加载的服务后，可能需要重连 MCP。工具目录尚未刷新时，可在项目目录调用同一个 SDK 客户端：`node src/call.mjs status`，或将下述 JSON 经 stdin 传给 `node src/call.mjs ask`；结果仍返回当前调用方，无需另开或恢复 Codex 会话。

## 工具与回复

| 工具 | 作用 |
| --- | --- |
| `wechat_status` | 读取本地绑定状态，不发消息、不返回凭据；不代表实时登录一定有效 |
| `ask_wechat` | 发送一题并等待本人回复，返回结构化结果 |

```json
{
  "question": "数据保存在哪里？",
  "options": ["本地文件", "数据库"],
  "context": "数据存储方案",
  "allow_text": true,
  "timeout_seconds": 300
}
```

参数：`question` 为 1–1500 字符；`options` 为 2–6 个不重复选项，每项 1–200 字符；可选 `context` 最多 200 字符；`allow_text` 默认 `true`；`timeout_seconds` 为 15–600 的整数，默认 300 秒。文字答案最多 2000 字符。

只有 `status: answered` 表示回答成功，包含 `question_id`、`question`、`answer`、`sent`、`answered_at`；选中选项时另有从 1 开始的 `selected_index` 和 `selected_option`。`cancelled`、`timeout`、`not_connected`、`error` 都不是同意，不能据此执行待确认操作。

## 桌面 + 微信审核与最终确认

双渠道由使用方代理编排，可把以下规则放进使用方项目的 `AGENTS.md`；MCP 本身不会自动弹出桌面问题：

1. 需求澄清、方案选择和最终确认，同时用桌面非阻塞提问工具（如 `request_user_input_async`）和 `ask_wechat` 发送相同的问题、选项与背景，不等一边答完才发另一边。
2. 以首先收到的明确有效回答为准，只处理一次；桌面先回答则取消本题微信等待，微信先回答则撤回桌面问题，无法撤回时注明已处理。迟到回复不重复执行，用户主动撤回或变更指令仍按最新要求处理。单渠道出错可继续使用另一渠道；没有有效答案时保留待决定事项。
3. 日常修改和验证正常进行；发布、部署、推送、删除数据等关键操作准备完成后，先展示具体操作、目标、影响和验证结果，再双渠道请求最终确认。微信参数如下，两边摘要和选项一致：

```json
{
  "context": "最终执行确认 · 项目名",
  "question": "操作：发布已验证版本。目标：明确的环境和版本。影响：本次会改变哪些服务。验证：实际完成的检查结果。",
  "options": ["同意执行", "暂不执行", "修改方案"],
  "allow_text": false,
  "timeout_seconds": 600
}
```

最终确认有效期为 600 秒。只有首先明确选择“同意执行”才执行所描述的操作一次：桌面须明确选中该项，或微信返回 `answered`、`selected_index: 1` 且 `selected_option: 同意执行`。选“暂不执行”则保留成果并停止操作；选“修改方案”则调整后重新双渠道确认。取消、过期或两个渠道均不可用时不执行；操作或目标实质变化后重新确认，不复用旧答案。用户确认不替代平台权限审批。

## 验证与来源

`npm test` 运行 31 项测试：真实 MCP stdio、多进程并发与冷启动、乱序路由、独立取消/断开/超时、身份与本机认证、DPAPI、空闲退出、题号持久化和 24 小时重置、最终确认各分支，以及上下文过期恢复、重试竞态和防重复发送。微信响应为模拟，不发送真实消息。真实微信往返、双题乱序和无副作用最终确认也已验证；24 小时边界使用模拟时钟，未实际等待一天；桌面 + 微信首答竞速尚未完整联测。

微信 HTTP 字段参考腾讯发布的 [@tencent-weixin/openclaw-weixin 2.4.10](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)，未加载 OpenClaw 运行时；MCP 使用官方 [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)。微信协议或服务变化可能影响可用性。
