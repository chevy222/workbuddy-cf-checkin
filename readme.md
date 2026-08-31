# WorkBuddy 每日签到 —— Cloudflare Workers 版

部署到 Cloudflare Workers 后，**不需要开机、不需要本地运行任何程序**，每天定时自动完成：

- 每日积分签到（幂等，签过不会重复领）
- 成长中心全套：领 Buddy 旅行礼物 → 派 Buddy 出发旅行 → 开盲盒 → 领任务奖励
- 能量 / 连签天数查询汇总

所有结果以一段中文汇报呈现，例如：

> 成功领取 100 积分，且为连签奖励日（连续 5 天，累计 2300 积分）；领旅行礼物 +50 积分；派 Buddy 去杭州（8 小时后回）；开盲盒获得：88 积分（能量 12，连签 5 天，本次 +共 150 积分）

## 目录

- [文件说明](#文件说明)
- [工作原理](#工作原理)
- [部署步骤（全程网页操作，无需安装任何工具）](#部署步骤全程网页操作无需安装任何工具)
- [配置凭据（关键步骤）](#配置凭据关键步骤)
- [配置每日定时（Cron 触发器）](#配置每日定时cron-触发器)
- [手动触发与调试](#手动触发与调试)
- [可选功能](#可选功能)
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
GET  {endpoint}/v2/activity/growth/...                     成长中心（旅行/盲盒/任务/能量/连签）
```

默认 `endpoint` 为 `https://copilot.tencent.com`。

接口响应契约：

| 情况 | 形态 | 脚本处理 |
|---|---|---|
| 领取成功 | 含 `credit` 字段，如 `{"credit": 100}` | 记为成功，汇总汇报 |
| 今日已签 | 返回 `null`，或 HTTP 400 + `{"code":10001,"msg":"今天已签到，请明天再来"}` | 幂等，按"已签"处理，不计失败 |
| 业务错误 | `{"code": ..., "msg": ...}` | 记为 ERROR，原样带出 msg |
| 登录失效 | HTTP 401 / 403 | 记为 NO_SESSION，提示需重新登录桌面端并更新凭据 |

Workers 运行在云端、没有本地文件系统，无法直接使用 WorkBuddy 桌面端的登录会话，因此通过 **Secret 变量** 注入凭据（见下文）。

## 部署步骤（全程网页操作，无需安装任何工具）

1. 注册/登录 [Cloudflare 账号](https://dash.cloudflare.com)（免费套餐即可，Cron 每天触发一次完全在免费额度内）。
2. 进入控制台左侧 **Workers 和 Pages** → **创建** → 选择创建 Worker → 随便起个名字（如 `workbuddy-signin`）→ 部署。
3. 创建完成后点 **编辑代码**，把右侧默认的示例代码**全部删掉**，将 `worker.js` 的全部内容粘贴进去 → 点右上角 **部署**。
4. 继续完成下面两节：[配置凭据](#配置凭据关键步骤) 和 [配置定时](#配置每日定时cron-触发器)。

## 配置凭据（关键步骤）

### 1. 找到并复制本机凭据文件

登录过 WorkBuddy 桌面端后，凭据文件位于（Windows）：

```
%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info
```

即：

```
C:\Users\<你的用户名>\AppData\Local\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info
```

> macOS 路径：`~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info`

打开方式任选其一：

- `Win + R` 输入 `notepad` 回车，把文件拖进记事本窗口；
- 或在记事本里 文件 → 打开，把上面的完整路径粘贴到文件名栏（注意「文件类型」选「所有文件」）。

打开后是一段 JSON。`Ctrl + A` 全选 → `Ctrl + C` 复制。

### 2. 配置到 Worker 的 Secret

1. 进入你的 Worker → **设置** → **变量和机密**；
2. 点 **添加**，类型选择 **机密（Secret）**（不要选「文本」类型，Secret 是加密存储、部署后不可回读的，更安全）；
3. 变量名：`WORKBUDDY_SESSION`；值：粘贴上一步复制的内容；保存。
4. **注意**：修改变量后必须**重新部署一次**才生效——回到「编辑代码」页再点一次「部署」即可。

### 简化替代方案（不想贴整段 JSON 时）

也可以只配两个 Secret：

| 变量名 | 值 |
|---|---|
| `WORKBUDDY_TOKEN` | 凭据文件里 `auth.accessToken` 的值 |
| `WORKBUDDY_UID` | 凭据文件里 `account.uid` 的值 |

企业账号可再加 `WORKBUDDY_ENTERPRISE_ID`；两种方案二选一，同时配置时以 `WORKBUDDY_SESSION` 优先。

### 3. 验证

浏览器访问（Worker 的域名在概览页可以看到）：

```
https://<你的worker域名>/?action=status
```

能返回包含 `today_checked_in`、`streak_days` 等字段的 JSON 即配置成功。

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

Cron 触发时自动执行 `auto` 动作（签到 + 成长中心）。想更保险可以多加几条表达式（如早晚各一次），脚本幂等，重复执行不会重复领取。

## 手动触发与调试

HTTP 方式访问 `https://<你的worker域名>/?action=<动作>`：

| action | 作用 |
|---|---|
| `auto` | 每日自动化：签到 + 成长中心 |
| `growth` | 仅成长中心（不签到） |
| `status` | 仅查签到状态（调试用） |
| `claim` | 仅领取签到（调试用，幂等） |
| `all` | 查状态 + 领取一起返回 |
| `log` | 查询最近 30 次运行记录（需配置 KV，见下） |

**注意**：必须显式带上 `?action=` 参数才会执行动作；直接访问根路径 `/` 只会返回一个说明页，不执行任何操作（这样扫描器或误访问不会触发签到流程，也不会产生日志）。

示例：

```
https://<你的worker域名>/?action=auto
https://<你的worker域名>/?action=status
```

定时任务的历史结果可在控制台查看：你的 Worker → **日志** → 实时日志，或「设置 → 触发事件」里点 Cron 条目查看最近执行记录。

## 可选功能

### 访问密钥（防止别人乱触发你的 Worker）

Worker 的默认域名是公开的，任何人知道 URL 都能触发签到。虽然签到接口幂等、风险不大，但建议加一道门：

1. 设置 → 变量和机密 → 添加机密 `WORKER_SECRET`，值自定义一串随机字符；
2. 之后访问需带上 `?key=<你的密钥>`，或请求头 `X-Worker-Key: <你的密钥>`。

### KV 日志（云端保存运行记录）

配置后可用 `?action=log` 随时查看最近 30 次运行记录：

1. 控制台左侧 **存储和数据库** → **KV** → 创建命名空间（如 `workbuddy-log`）；
2. 回到你的 Worker → **设置** → **绑定** → 添加 KV 命名空间绑定，**变量名必须填 `KV`**，选中刚创建的命名空间；
3. 重新部署一次。

## 运行结果说明

返回 JSON 中的 `result` 字段含义：

| result | 含义 | 是否需要处理 |
|---|---|---|
| `CLAIMED` | 成功领取今日积分 | 无 |
| `ALREADY` | 今日已签过（幂等，正常） | 无 |
| `GROWTH` | growth 动作的正常结果 | 无 |
| `INACTIVE` | 签到活动未开启 | 无 |
| `TOKEN_EXPIRED` | 登录令牌已过期（签到大概率已失败） | 重新登录 WorkBuddy 桌面端 → 重新复制凭据文件 → 更新 `WORKBUDDY_SESSION` → 重新部署 |
| `NO_SESSION` | 未配置凭据 / 登录态已失效 | 同上 |
| `ERROR` / `UNKNOWN` | 接口返回异常，JSON 里附带原始响应 | 看 `report` 与 `claim_body` 字段定位 |

其余通用字段：

| 字段 | 含义 |
|---|---|
| `trigger` | 本次执行来源：`cron` = 定时触发，`http:auto`、`http:status` 等 = 手动访问对应的 action |
| `token_days_left` | 登录令牌剩余有效天数（每次执行自动从令牌中解析） |
| `token_expire_at` | 令牌到期日期（如 `2026-10-30`） |

**令牌到期预警**：令牌剩余 7 天以内时，`report` 开头会出现「【令牌 X 天后过期…】」的醒目警告；已过期则 result 变为 `TOKEN_EXPIRED`。看到警告后按 [常见问题排查](#常见问题排查) 中的「令牌过期」一节更新 Secret 即可，建议每 45 天左右主动更新一次。

## 常见问题排查

**问：提示 `WORKBUDDY_SESSION 不是合法 JSON`**
复制时丢字了。重新打开凭据文件，确保从第一个 `{` 到最后一个 `}` 完整复制（记事本里 `Ctrl+A` 全选即可）。

**问：提示 `缺少 accessToken 或 uid`**
凭据文件内容不完整，或桌面端已登出。重新登录 WorkBuddy 桌面端，等文件重新生成后再复制配置。

**问：返回 401 / 403（NO_SESSION）**
令牌过期。重新登录 WorkBuddy 桌面端 → 重复[配置凭据](#配置凭据关键步骤)一节 → 重新部署。**令牌有有效期，这是日后最主要的维护动作**，建议把本节操作收藏。

**问：Cron 到点了没执行？**
依次检查：触发事件里表达式是否保存成功；表达式是否 UTC 时间算错了；Worker → 日志 里是否有执行记录。Cron 一般在设定时间的分钟级误差内触发，不精确到秒。

**问：改了 Secret / 绑定没生效？**
所有设置变更（变量、绑定、触发器）都需要**重新部署一次** Worker 才会生效。

**问：`?action=log` 提示未绑定 KV？**
见 [KV 日志](#kv-日志云端保存运行记录)一节，绑定变量名必须是 `KV`。

## 安全须知

- `workbuddy-desktop.info` 中的 `accessToken` **等同于你的账号登录态**，泄露后他人可冒用你的身份调用接口。请只通过 Cloudflare 的 Secret 机制配置，**不要**：
  - 硬编码进 `worker.js` 提交到公开仓库；
  - 发给他人、截图或贴到任何群/论坛；
- Secret 类型变量在 Cloudflare 侧加密存储、部署后无法回读，比「文本」类型变量安全；
- 如怀疑令牌泄露，在 WorkBuddy 桌面端登出再登录即可使旧令牌失效，然后更新 Worker 里的 Secret。
