# WorkBuddy 每日签到 —— Cloudflare Workers 版

部署到 Cloudflare Workers 后，**不需要开机、不需要本地运行任何程序**，每天定时自动完成：

- 每日积分签到（幂等，签过不会重复领）
- 成长中心全套：领 Buddy 旅行礼物 → 派 Buddy 出发旅行 → 抽奖 → 开盲盒（消耗能量）→ 领任务奖励 → 连签档位兑换
- **Token 自动续期**：配置 Refresh Token 后自动刷新，90 天滚动续期，基本不用再手动更新凭据
- 能量 / 连签天数查询汇总
- **多账号**：一个 Worker 同时托管多个 WorkBuddy 账号，定时任务依次跑完、汇总成一条记录
- **定时任务心跳**：首页显示上次 Cron 触发时间，"到点了没跑"一眼可查
- **浏览器页面**：用浏览器打开是日志表格 / 记录详情 / 执行结果页；程序调用（curl 等）仍返回 JSON

所有结果以一段中文汇报呈现，例如：

> 成功领取 100 积分，且为连签奖励日（连续 5 天，累计 2300 积分）；领旅行礼物 +50 积分；派 Buddy 去杭州（8 小时后回）；开盲盒获得：88 积分（能量 12，连签 5 天，本次 +共 150 积分）

多账号时按账号汇总：

> [主号] 成功领取 100 积分（连续 5 天，累计 2300 积分）；[小号] 今日已签过（今日 +100，连续 5 天）

## 目录

- [文件说明](#文件说明)
- [工作原理](#工作原理)
- [部署步骤（全程网页操作，无需安装任何工具）](#部署步骤全程网页操作无需安装任何工具)
- [配置凭据（关键步骤）](#配置凭据关键步骤)
- [多账号配置](#多账号配置)
- [配置每日定时（Cron 触发器）](#配置每日定时cron-触发器)
- [手动触发、页面与调试](#手动触发页面与调试)
- [可选功能](#可选功能)
  - [访问密钥](#访问密钥防止别人乱触发你的-worker)
  - [KV 日志](#kv-日志云端保存运行记录--日志页面)
  - [Token 自动续期（Refresh Token）](#token-自动续期refresh-token)
- [运行结果说明](#运行结果说明)
- [常见问题排查](#常见问题排查)
- [安全须知](#安全须知)

## 文件说明

| 文件 | 作用 |
|---|---|
| `worker.js` | Workers 脚本本体，全部逻辑都在这一个文件里，整段复制到 Cloudflare 在线编辑器即可 |
| `readme.md` | 本文档 |

## 工作原理

脚本调用 WorkBuddy 的服务端接口（与桌面客户端使用的相同）：

```
POST {endpoint}/v2/billing/meter/checkin-activity-status   查询签到状态
POST {endpoint}/v2/billing/meter/daily-checkin             领取今日积分
GET  {endpoint}/v2/activity/growth/...                     成长中心（旅行/抽奖/盲盒/任务/能量/连签）
POST {endpoint}/v2/activity/growth/redeem                  连签档位兑换（7d/14d/28d）
POST {endpoint}/v2/plugin/auth/token/refresh               Token 自动续期（用 RT 换新 AT+RT）
```

默认 `endpoint` 为 `https://copilot.tencent.com`。

**Token 自动续期**：配置了 Refresh Token（RT）的账号，脚本会在 AT 临期（剩余 7 天内）或距上次刷新超过 10 天时自动调用刷新接口，用 RT 换取新的 AT + RT，并将新 RT 存入 KV（`signin:rt:<uid>`），形成滚动续期。环境变量里的初始凭据与 KV 里的刷新记录以 AT 的过期时间（exp）比较，谁更新用谁的。续期需要绑定 KV 命名空间。

接口响应契约：

| 情况 | 形态 | 脚本处理 |
|---|---|---|
| 领取成功 | 含 `credit` 字段，如 `{"credit": 100}` | 记为成功，汇总汇报 |
| 今日已签 | 返回 `null`，或 HTTP 400 + `{"code":10001,"msg":"今天已签到，请明天再来"}` | 幂等，按"已签"处理，不计失败 |
| 业务错误 | `{"code": ..., "msg": ...}` | 记为 ERROR，原样带出 msg |
| 登录失效 | HTTP 401 / 403 | 记为 NO_SESSION / TOKEN_EXPIRED，提示更新该账号凭据 |

Workers 运行在云端、没有本地文件系统，无法直接使用 WorkBuddy 桌面端的登录会话，因此通过 **Secret 变量** 注入凭据（见下文）。多账号相互隔离，一个账号失效不影响其他账号签到。

## 部署步骤（全程网页操作，无需安装任何工具）

1. 注册/登录 [Cloudflare 账号](https://dash.cloudflare.com)（免费套餐即可，Cron 每天触发一次完全在免费额度内）。
2. 进入控制台左侧 **Workers 和 Pages** → **创建** → 选择创建 Worker → 随便起个名字（如 `workbuddy-signin`）→ 部署。
3. 创建完成后点 **编辑代码**，把右侧默认的示例代码**全部删掉**，将 `worker.js` 的全部内容粘贴进去 → 点右上角 **部署**。
4. 继续完成下面两节：[配置凭据](#配置凭据关键步骤) 和 [配置定时](#配置每日定时cron-触发器)。

## 配置凭据（关键步骤）

### 1. 通过短信登录获取明文凭据（推荐）

新版 WorkBuddy 桌面端的 `workbuddy-desktop.info` 中 `accessToken` / `refreshToken` 已被加密包装，无法直接复制使用。通过官方插件接口用短信登录直接拿明文 token，分两步：

**第一步：发送验证码**（把 `13800000000` 换成你的手机号）

```powershell
Invoke-RestMethod -Uri "https://www.workbuddy.cn/v2/plugin/login/send-sms" -Method Post -ContentType "application/json" -Body '{"phone":"13800000000"}'
```

返回 `code: 0` 即发送成功，等收短信。

**第二步：用验证码登录拿 token**（把手机号和 `123456` 换成实际收到的验证码）

```powershell
$r = Invoke-RestMethod -Uri "https://www.workbuddy.cn/v2/plugin/login/token" -Method Post -ContentType "application/json" -Body '{"login_method":"phone","phone":"13800000000","sms_code":"123456"}'; $at=$r.data.accessToken; $rt=$r.data.refreshToken; $p=$at.Split('.')[1].Replace('-','+').Replace('_','/'); $p=$p.PadRight($p.Length+(4-$p.Length%4)%4,'='); $j=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p))|ConvertFrom-Json; Write-Host "WORKBUDDY_TOKEN=$at"; Write-Host "WORKBUDDY_UID=$($j.sub)"; Write-Host "WORKBUDDY_REFRESH_TOKEN=$rt"
```

执行后输出三行值，直接复制到下一步配置。

> 在 PowerShell 7（`pwsh`）或 Windows PowerShell 5.1 中均可执行，无需安装任何依赖。

### 2. 配置到 Worker 变量（单账号）

1. 进入你的 Worker → **设置** → **变量和机密**；
2. 点 **添加**，类型选择 **机密（Secret）**（Secret 是加密存储、部署后不可回读的，更安全）；
3. 依次添加以下三个变量（值为上一步脚本的输出）：

| 变量名 | 值 | 必填 |
|---|---|---|
| `WORKBUDDY_TOKEN` | 脚本输出的 `WORKBUDDY_TOKEN` | ✅ |
| `WORKBUDDY_UID` | 脚本输出的 `WORKBUDDY_UID` | ✅ |
| `WORKBUDDY_REFRESH_TOKEN` | 脚本输出的 `WORKBUDDY_REFRESH_TOKEN` | 可选，配了就启用自动续期 |

4. 企业账号可再加 `WORKBUDDY_ENTERPRISE_ID`；
5. **注意**：修改变量后必须**重新部署一次**才生效——回到「编辑代码」页再点一次「部署」即可。

### 旧版方式（info 文件未加密时）

如果你的 WorkBuddy 桌面端版本较旧，`workbuddy-desktop.info` 中 `accessToken` / `refreshToken` 仍是纯字符串（而非 `{"$wbEncrypted":1,"envelope":"..."}` 对象），可以直接复制整段 JSON 配到 `WORKBUDDY_SESSION` 变量，脚本会自动解析。此方式无需短信登录，但新版桌面端已不适用。

凭据文件路径（Windows）：`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`

### 3. 验证

浏览器访问（Worker 的域名在概览页可以看到）：

```
https://<你的worker域名>/status
```

浏览器会打开结果页，能看到签到状态（`today_checked_in`、`streak_days` 等）即配置成功。

## 多账号配置

多账号有两种配置方式，**任选其一**（也可混用）。每个账号的 token 先用 `workbuddy-login.ps1` 短信登录获取。

### 方式一：一个 Secret 存全部账号（账号少的时候用）

变量名 `WORKBUDDY_ACCOUNTS`，值为一个 **JSON 数组**，每个账号一项：

```json
[
  {
    "name": "主号",
    "token": "短信登录拿到的 AT",
    "uid": "短信登录拿到的 UID",
    "refresh_token": "短信登录拿到的 RT（配了就启用自动续期）"
  },
  {
    "name": "小号",
    "token": "...",
    "uid": "...",
    "refresh_token": "..."
  }
]
```

### 方式二：每个账号一个独立 Secret（账号多、单 Secret 超 5KB 上限时用）

Cloudflare 单个 Secret 上限 5KB，账号多了 `WORKBUDDY_ACCOUNTS` 会存不下。此时把每个账号拆成独立变量：

| 变量名 | 值 |
|---|---|
| `WORKBUDDY_ACCOUNT_1` | `{"name":"主号","token":"...","uid":"...","refresh_token":"..."}` |
| `WORKBUDDY_ACCOUNT_2` | `{"name":"小号","token":"...","uid":"...","refresh_token":"..."}` |
| `WORKBUDDY_ACCOUNT_3` | 第三个账号…… |

变量名必须是 `WORKBUDDY_ACCOUNT_` 加数字（从 1 开始，序号决定执行顺序），每个变量的值是**一个 JSON 对象**（和方式一数组里的每一项完全一样）。有几个账号就建几个 Secret，互不影响。

> 两种方式可以同时存在，脚本会把两边的账号合并执行。通常只用一种即可。

要点：

- `name` 是日志和结果页里显示的账号名，自取；缺省时取账号昵称，再缺省为「账号N」。重名会自动加序号。
- **`refresh_token`（可选）**：配置后启用 Token 自动续期，脚本会自动刷新 AT，基本不用再手动更新凭据。详见 [Token 自动续期](#token-自动续期refresh-token)。
- 每个账号的 token 独立做到期预警；某个账号配置写错或登录失效，**不影响其他账号**，结果页/日志里该账号单独标红。
- 配置了多账号变量后，单账号的 `WORKBUDDY_SESSION` / `WORKBUDDY_TOKEN` 会被忽略；改回单账号直接删掉多账号变量即可。
- 只想手动调试某一个账号：URL 加 `?account=账号名`，例如 `/auto?account=主号`。
- 首页账号列表中，已配置 RT 的账号会显示绿色「自动续期」徽章，未配置的显示灰色「未配续期」。
- 旧版桌面端（info 文件未加密）仍支持 `session` 字段写法（粘贴完整 info JSON），与 `token + uid` 写法可混用。

> 升级提示：运行记录改为**每次运行写一个独立 key**（避免定时任务与手动触发并发时互相覆盖），写入后自动裁剪为最近 30 条。旧版单 key 的历史日志无需手动清理，在新记录产生前仍会被正常渲染。

## 配置每日定时（Cron 触发器）

1. 进入你的 Worker → **设置** → **触发事件** → **Cron 触发器** → 添加；
2. 填入 Cron 表达式，例如 `30 1 * * *`（每天一次）；
3. **重要**：Cloudflare 的 Cron 使用 **UTC 时区**，北京时间 = UTC + 8。对照表：

| 想要的北京时间 | 填写的表达式 |
|---|---|
| 每天 09:30 | `30 1 * * *` |
| 每天 08:00 | `0 0 * * *` |
| 每天 12:00 | `0 4 * * *` |
| 每天 21:00 | `0 13 * * *` |

Cron 触发时自动执行 `auto` 动作（**所有账号**依次签到 + 成长中心）。想更保险可以多加几条表达式（如早晚各一次），脚本幂等，重复执行不会重复领取。

## 手动触发、页面与调试

### 浏览器访问 = 可视化页面

直接用浏览器打开 `https://<你的worker域名>/` 是首页（显示已配置账号与令牌剩余天数）；打开各动作路径返回结果卡片页；`/logs` 是日志表格页（**每 60 秒自动刷新**，点「详情」查看单条完整 JSON）。

| 页面 | 地址 |
|---|---|
| 首页 / 操作导航（含**定时任务心跳卡**） | `/` |
| 日志列表（表格、自动刷新） | `/logs` |
| 第 N 条记录详情 | `/logs/0`（N 为列表序号，从 0 开始；也支持 `/logs?i=0`） |
| 执行某动作并看结果页 | `/auto`、`/growth`、`/status`、`/claim` |

### 程序调用 = JSON

- `curl`、脚本等默认不带 `Accept: text/html`，返回的即是 JSON。

### 动作一览（均为 GET 路径）

| 路径 | action | 作用 |
|---|---|---|
| `/auto` | `auto` | 每日自动化：签到 + 成长中心（Cron 跑的就是它；签到失败的账号会跳过成长中心，不白打请求） |
| `/growth` | `growth` | 仅成长中心（不签到） |
| `/status` | `status` | 仅查签到状态（调试用，不写入日志） |
| `/claim` | `claim` | 仅领取签到（调试用，幂等，不写入日志） |
| `/logs` | `log` | 运行记录页面 / JSON（需配置 KV，见下） |

可选查询参数（拼在路径后面）：

| 参数 | 作用 |
|---|---|
| `?account=账号名` | 多账号时只执行指定账号，如 `/auto?account=主号` |
| `key=xxx` | 配置了 `WORKER_SECRET` 时的访问密钥，页面内链接会自动透传 |
| `/logs/N` 或 `?i=N` | 查看第 N 条日志详情 |

**注意**：直接访问根路径 `/` 只会返回首页/说明，不执行任何操作（扫描器或误访问不会触发签到流程，也不会产生日志）；动作必须通过对应路径触发。动作结果页**不会**自动刷新，避免每 60 秒重复执行。

定时任务的控制台输出可在：你的 Worker → **日志** → 实时日志，或「设置 → 触发事件」里点 Cron 条目查看最近执行记录。

## 可选功能

### 访问密钥（防止别人乱触发你的 Worker）

Worker 的默认域名是公开的，任何人知道 URL 都能触发签到。虽然签到接口幂等、风险不大，但建议加一道门：

1. 设置 → 变量和机密 → 添加机密 `WORKER_SECRET`，值自定义一串随机字符；
2. 之后访问需带上 `?key=<你的密钥>`，或请求头 `X-Worker-Key: <你的密钥>`。首次用浏览器打开带 key 的页面后，页面里的链接都会自动带上 key。

### KV 日志（云端保存运行记录 + 日志页面）

配置后 `/logs` 才能看到最近 30 次运行记录：

1. 控制台左侧 **存储和数据库** → **KV** → 创建命名空间（如 `workbuddy-log`）；
2. 回到你的 Worker → **设置** → **绑定** → 添加 KV 命名空间绑定，**变量名必须填 `KV`**，选中刚创建的命名空间；
3. 重新部署一次。

运行记录以 `signin:log:<时间>-<随机后缀>` 为键，只保留最近 30 条；另有 `signin:cron:last` 一个键保存**定时任务心跳**（首页那张卡片读的就是它），不受 30 条裁剪影响。

### Token 自动续期（Refresh Token）

配置了 Refresh Token（RT）后，脚本会自动刷新 accessToken，**基本不用再手动更新凭据**。

**工作原理**：

- 每次运行前检查当前 AT 是否临期（剩余 < 7 天）或距上次刷新超过 10 天，满足其一则调用刷新接口 `POST /v2/plugin/auth/token/refresh`，用 RT 换取新的 AT + RT；
- 刷新后将新 RT 存入 KV（键 `signin:rt:<uid>`），下次运行优先使用 KV 中更新的凭据；
- 环境变量里的初始凭据与 KV 里的刷新记录以 AT 的过期时间（exp）比较，谁更新用谁的——因此你重新登录桌面端、更新环境变量后，脚本会自动切换到新凭据。

**配置方式**：

- 用 `session` 完整 JSON 写法（粘贴 `workbuddy-desktop.info` 整段）：**无需额外操作**，文件里自带 `auth.refreshToken`，脚本自动提取；
- 用 `token + uid` 简化写法：在账号项中加 `"refresh_token": "RT的值"`；
- 单账号环境变量：新增可选 Secret `WORKBUDDY_REFRESH_TOKEN`。

**前提条件**：必须绑定 KV 命名空间（变量名 `KV`），否则刷新后的 RT 无法持久化，续期功能会静默跳过。

**首页标记**：已配置 RT 的账号在首页账号列表显示绿色「自动续期」徽章，未配置的显示灰色「未配续期」。执行结果页的账号卡片同样会显示该标记。

**注意**：RT 本身也有有效期（离线会话约 30 天），定期刷新可保持其活跃。如果 RT 也失效了（刷新接口返回 401），需要重新登录桌面端并更新凭据。

## 运行结果说明

### 单账号 JSON（与旧版一致，顶层平铺）

```json
{ "result": "CLAIMED", "report": "成功领取 100 积分（连续 7 天，累计 700 积分）", "account": "default", "trigger": "cron", "token_days_left": 52 }
```

### 多账号 JSON（顶层为汇总，每账号明细在 accounts 数组）

```json
{
  "result": "PARTIAL_FAILED",
  "report": "[主号] 成功领取 100 积分…；[小号] 【令牌已过期】登录态已失效…",
  "accounts": [ { "account": "主号", "result": "CLAIMED", "report": "…" }, { "account": "小号", "result": "TOKEN_EXPIRED", "report": "…" } ],
  "trigger": "cron"
}
```

`result` 字段含义：

| result | 含义 | 是否需要处理 |
|---|---|---|
| `CLAIMED` | 成功领取今日积分（多账号时只要有账号领到即为它） | 无 |
| `ALREADY` | 今日已签过（幂等，正常） | 无 |
| `GROWTH` | growth 动作的正常结果 | 无 |
| `INACTIVE` | 签到活动未开启 | 无 |
| `PARTIAL_FAILED` | 多账号中部分账号失败，其余正常 | 看 `accounts` 里标红的账号 |
| `FAILED` | 多账号全部失败 | 全部需要更新凭据或排查 |
| `TOKEN_EXPIRED` | 该账号登录令牌已过期（签到大概率已失败） | 重新登录该账号桌面端 → 更新 `WORKBUDDY_ACCOUNTS` 中对应项 → 重新部署 |
| `NO_SESSION` | 登录态已失效（接口返回 401 / 403） | 同上 |
| `CONFIG_ERROR` | 凭据没配好：未配置任何账号、JSON 格式错、`session` 里缺 accessToken 或 uid | 检查 Secret 内容与格式，不用重新登录 |
| `BAD_ACCOUNT` | `?account=账号名` 指定的账号不存在 | 按首页列出的账号名重试 |
| `ERROR` / `UNKNOWN` | 接口返回异常，JSON 里附带原始响应 | 看 `report` 与 `claim_body` 字段定位 |

调用失败时返回的 HTTP 状态码：`CONFIG_ERROR` / `BAD_ACCOUNT` → 400，`NO_SESSION` / `TOKEN_EXPIRED` → 401，其余失败 → 500；成功一律 200。这样接监控时能一眼区分"是我配置错了"还是"上游出问题了"。

其余通用字段：

| 字段 | 含义 |
|---|---|
| `trigger` | 本次执行来源：`cron` = 定时触发，`http:auto`、`http:status` 等 = 手动访问对应的 action |
| `account` / `accounts` | 单账号名（固定 `default`）/ 多账号明细数组 |
| `token_days_left` | 该账号登录令牌剩余有效天数（每次执行自动从令牌中解析） |
| `token_expire_at` | 令牌到期日期（如 `2026-10-30`） |
| `rt_enabled` | 该账号是否配置了 Refresh Token 自动续期（`true` / `false`） |
| `growth` | 成长中心报告摘要（auto 动作时附带） |

**令牌到期预警**：某账号令牌剩余 7 天以内时，其 `report` 开头会出现「【令牌 X 天后过期…】」醒目警告；已过期则 result 变为 `TOKEN_EXPIRED`。配置了 RT 自动续期的账号会在到期前自动刷新，report 中出现「🔄令牌已自动续期」；刷新失败时出现「⚠️令牌续期失败」。

## 常见问题排查

**问：提示 `WORKBUDDY_ACCOUNTS 不是合法 JSON` / `必须是非空 JSON 数组`**
数组格式写错了。最外层必须是 `[ ... ]`；用 `session` 写法时里面是 JSON 对象，用记事本/JSON 校验工具检查括号、逗号和引号。

**问：日志页里某个账号显示「配置无效：缺少 accessToken 或 uid」**
该账号那一项的凭据不完整，其他账号不受影响。重新复制该账号的凭据文件、修正数组中对应项后重新部署。

**问：提示 `WORKBUDDY_SESSION 不是合法 JSON`**
复制时丢字了。重新打开凭据文件，确保从第一个 `{` 到最后一个 `}` 完整复制（记事本里 `Ctrl+A` 全选即可）。

**问：返回 401 / 403（NO_SESSION / TOKEN_EXPIRED）**
令牌过期。如果配置了 RT 自动续期，脚本会在到期前自动刷新，正常不会出现此问题。若仍出现，说明 RT 也失效了（离线会话约 30 天未活跃），需重新登录对应账号的 WorkBuddy 桌面端 → 重复[配置凭据](#配置凭据关键步骤)一节 → 重新部署。

**问：怎么确认自动续期有没有生效？**
首页账号列表中，已配置 RT 的账号显示绿色「自动续期」徽章。执行一次 `/auto` 后，如果 report 中出现「🔄令牌已自动续期」，说明本次触发了刷新。正常情况下刷新不会每次都发生（AT 剩余 >7 天且距上次刷新 <10 天时跳过），这是正常的。也可以在 KV 中查看 `signin:rt:<uid>` 键的 `refreshed_at` 字段确认上次刷新时间。

**问：浏览器打开是页面，我自己的脚本想拿 JSON 怎么办？**
请求头不带 `Accept: text/html`（curl 默认即是）。

**问：Cron 到点了没执行？**
先看**首页那张「定时任务（Cron）」卡片**——它显示上次 Cron 触发的时间，是判断"定时任务到底有没有跑"最直接的依据：卡片有记录就说明触发器是好的，问题在别处；长期为空则说明触发器没有被调度到。

如果卡片为空，依次检查：触发事件里表达式是否保存成功、触发器列表里到底有没有条目；表达式是否 UTC 时间算错了；**触发器绑的 Worker 和你访问的域名是不是同一个**（看该 Worker 的「域」标签页）；是不是刚加完触发器（新增/修改最多需要 15 分钟才传播到全网，新建 Worker 或改过名字后触发事件记录最长要 30 分钟才显示）。另外 Worker → 日志 里也能看到执行记录，但只有当时开着页面才看得到。Cron 一般在设定时间的分钟级误差内触发，不精确到秒。

**问：页面底部的 `version` 是什么？**
是本次部署的构建版本，格式 `日期:当天第几次改动`——例如 `20260912:1` 表示 2026 年 9 月 12 日的第 1 次改动。它就是 `worker.js` 顶部的 `BUILD_VERSION` 常量，**当天第几个改动就写几**（跨天则换成当天日期、序号从 1 重新开始）。配合自动部署时，提交推送后刷新页面看这一行有没有变，就能立刻确认新版本上线了。如果没变，先 `Ctrl+F5` 强刷一下排除浏览器缓存。

**问：改了 Secret / 绑定没生效？**
所有设置变更（变量、绑定、触发器）都需要**重新部署一次** Worker 才会生效。

**问：`/logs` 提示未绑定 KV？**
见 [KV 日志](#kv-日志云端保存运行记录--日志页面)一节，绑定变量名必须是 `KV`。

## 安全须知

- `workbuddy-desktop.info` 中的 `accessToken` **等同于该账号的登录态**，泄露后他人可冒用身份调用接口。`WORKBUDDY_ACCOUNTS` 里装着多个账号的令牌，敏感度更高，请只通过 Cloudflare 的 Secret 机制配置，**不要**：
  - 硬编码进 `worker.js` 提交到公开仓库；
  - 发给他人、截图或贴到任何群/论坛（页面截图注意遮挡 `&key=` 与详情 JSON）；
- Secret 类型变量在 Cloudflare 侧加密存储、部署后无法回读，比「文本」类型变量安全；
- 如怀疑某账号令牌泄露，在 WorkBuddy 桌面端登出再登录即可使旧令牌失效，然后更新 Worker Secret 中对应账号的内容。
