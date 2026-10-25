# CLI 参考

脚本路径相对于技能根目录；调用方可以位于任意项目，不需要特定 agent 环境变量或客户端 API。

## 命令

```powershell
npm ci --ignore-scripts
node scripts/cli.mjs status
node scripts/cli.mjs login
node scripts/cli.mjs login --force
node scripts/cli.mjs ask
```

`status` 返回 `connected`、`logged_in`、`owner_bound`、`context_ready` 四个布尔值，不发微信、不返回凭据，也不验证登录当前是否仍有效。

`login` 复用有效绑定；首次登录或 `--force` 时输出 `qr_ready` 事件和本地二维码图片路径。展示该图片供用户扫码，并引导向机器人发送“绑定”。若输出 `verify_code_required`，将手机显示的配对数字写入 stdin。成功输出 `connected` 事件并发送一次连接说明。登录最多等待 10 分钟，二维码最多刷新三次。登录前只停止空闲接收器，有待答题时拒绝登录。

## 问题输入

`ask` 从 stdin **第一行**读取 JSON，收到换行立即开始，不等待 EOF。首行最多 64 KiB。示例中的来源需换成当前真实值：

```json
{"conversation_title":"来源对话标题","conversation_id":"真实会话ID","question":"数据保存在哪里？","options":["本地文件","数据库"],"context":"存储方案","allow_text":false,"timeout_seconds":300}
```

| 字段 | 规则 |
| --- | --- |
| `conversation_title` / `conversation_id` | 至少一个；非空单行文本，去除首尾空白后最多 200 字符；标题优先。缺少来源时发送前报错且不占题号。 |
| `question` | 去除首尾空白后 1–1500 字符。 |
| `options` | 2–6 个不重复选项，各为去除首尾空白后 1–200 字符。 |
| `context` | 可选，最多 200 字符，仅表示项目或任务背景，不能替代来源对话。 |
| `allow_text` | 默认 `false`；显式 `true` 时允许最多 2000 字符的文字答案。 |
| `timeout_seconds` | 15–600 的整数，默认 300。 |

微信列出来源、题号、背景、问题、选项和回复说明。标准回复为 `15 2`，无需对话名或 ID；也接受 `15 选项原文`。取消用 `15 取消` 或 `15 cancel`。裸数字不作为答案，非法选项不会默认选中。

## 结果与取消

`ask` 最终 stdout 为一行 JSON；终端回显的输入不是结果。例如：

```json
{"status":"answered","question_id":"15","question":"数据保存在哪里？","sent":true,"answer":"数据库","selected_index":2,"selected_option":"数据库","answered_at":"2026-10-25T06:00:00.000Z"}
```

- `status: answered` 是有效回答；选项回答含从 1 开始的 `selected_index` 和 `selected_option`，文字回答只有 `answer`。
- `question_id` 为数字字符串；`answered_at` 为 UTC 时间。已建立的题通常含 `question_id`、`question`、`sent`；发送前失败或本地取消可能不含这些字段，不能用缺失字段推断同意。
- 其他状态为 `cancelled`、`timeout`、`not_connected`、`error`，可带 `message`；均不是同意。`error` 退出码为 1，其他结果通常为 0。登录失败退出码为 1，原因输出到 stderr。
- 保留 stdin 时，可写入独占一行的 `cancel` 取消本题。SIGINT/SIGTERM 或进程断开同样取消本题；首行后正常 stdin EOF 不表示取消。
- 同一题只处理一次。取消、超时或已处理后的迟到回复被忽略；本地界面与微信的首答协调由 agent 负责，CLI 不控制宿主界面。最终确认工作流程以 [SKILL.md](../SKILL.md#最终执行确认) 为准。

## 运行与排障

- **状态与安全**：默认目录 `%LOCALAPPDATA%/CodexWeChatQuestion`，可用 `WECHAT_QUESTION_STATE_DIR` 覆盖。目录名沿用既有安装，属于兼容标识，不依赖同名客户端。账号、游标、会话上下文、题号及本机令牌使用 Windows DPAPI 加密；原加密参数与认证命名管道保持不变。安装和升级不移动或重置状态，不记录凭据。直接入口不开 TCP 端口。
- **并发与生命周期**：多个 agent/进程共享单个接收器和全局题号，可乱序答题。题号从 1 递增，发送前持久保存；失败可能跳号。最后一道待答题结束后连续空闲满 24 小时，下一题从 1 开始，有待答题时不重置。计数跨重启和重新登录保留；旧计数器初次升级从接收器启动记录空闲。接收器按需启动，空闲 60 秒退出，无登录启动任务。
- **绑定不完整**：`status` 任一绑定条件缺失时运行 `login`，按事件指引扫码、发送“绑定”。绑定凭据位于技能目录外，勿复制到仓库或安装包。
- **登录过期**：等待现有题结束或逐题取消，再运行 `login --force`；不能通过全局停止接收器取消某一题。
- **题目未送达或上下文失效**：给机器人发送“绑定”。只有服务明确拒绝了该次上下文时，才在原有效期内使用原题号恢复发送；网络超时等结果不明的失败不自动重发。到期后需重新提问。
- **断开或超时**：电脑、网络和原调用方需保持运行；接收器异常退出会使待答调用报错，不自动选择或执行。只有首个有效回答可被采用，单渠道失败仍须遵守原有效期。
- **消息范围**：只接受已绑定本人的私聊文字，忽略其他人、群聊和无关聊天。不提供独立聊天、完成通知、图片或语音问答。仅支持 Windows；仅安装 Skill 的云端 agent 无法访问另一台电脑的本机凭据。
- **宿主差异**：需要 agent 能执行脚本并持续读取结果。原生本地问题、自动发现和卡片撤回由宿主提供；缺少异步提问时使用微信，不承诺每次自动匹配，也不保证所有客户端均经过实测。

## 开发验证

`npm test` 使用模拟微信，覆盖独立 CLI 进程、并发与冷启动、乱序路由、独立取消/断开/超时、来源校验、身份过滤、认证、DPAPI、空闲退出、编号持久化与 24 小时重置、最终确认及发送恢复。24 小时边界使用模拟时钟。真实微信往返需单独验证，不能由自动测试推断。

微信字段参考腾讯 [@tencent-weixin/openclaw-weixin 2.4.10](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)，未加载其运行时。微信服务变化可能影响可用性。
