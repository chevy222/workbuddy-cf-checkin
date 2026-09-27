# WorkBuddy 每日签到 — Cloudflare Workers 版

**只有一个代码文件 `worker.js`，不需要安装 Node / npm / wrangler，在 Cloudflare 网页控制台粘贴即可。**

- 每天定时自动签到 + 成长中心全套（领旅行礼物、派 Buddy 出发、抽奖、开盲盒、领任务奖、连签兑换）；
- **Token 自动续期**：配了 Refresh Token 后自动滚动续期，基本不用再手动更新凭据；
- **多账号**：一个 Worker 托管多个账号，定时依次跑完、汇总一条记录；
- **KV 日志**：浏览器打开 `/logs` 看最近 30 次运行，每 60 秒自动刷新；
- **定时心跳**：首页显示上次 Cron 触发时间，"到点没跑"一眼可查；
- 浏览器访问是可视化页面，程序调用（curl 等）返回 JSON。

---

## 目录

1. [准备工作](#1-准备工作)
2. [第一步：创建 Worker 并粘贴代码](#2-第一步创建-worker-并粘贴代码)
3. [第二步：创建 KV 并绑定](#3-第二步创建-kv-并绑定)
4. [第三步：短信登录获取凭据（关键）](#4-第三步短信登录获取凭据关键)
5. [第四步：配置账号变量](#5-第四步配置账号变量)
6. [第五步：配置定时 Cron](#6-第五步配置定时-cron)
7. [第六步：手动试跑并查看日志](#7-第六步手动试跑并查看日志)
8. [接口一览](#8-接口一览)
9. [日常运维与常见问题](#9-日常运维与常见问题)
10. [安全须知](#10-安全须知)

---

## 1. 准备工作

- 一个 **Cloudflare 账号**（免费即可），首次进 Workers & Pages 时按提示设置一个 `workers.dev` 子域名。
- 能收短信的手机号（用来登录拿凭据，见第三步）。
- 电脑上有 **PowerShell**（Windows 自带；macOS 可装 PowerShell 或用 curl，第三步给了两个版本）。
- 部署后你的 Worker 地址形如 `https://<worker名>.<你的子域>.workers.dev`，下文用 `$base` 代指。

---

## 2. 第一步：创建 Worker 并粘贴代码

1. 登录 Cloudflare 控制台，左侧 **Workers 和 Pages** → **创建** → 选 **Worker**（Hello World 模板即可）。
2. 起个名，例如 `workbuddy-signin`，点 **部署**。
3. 部署后点 **编辑代码**，把编辑器里默认内容**全部删掉**。
4. 打开本目录的 `worker.js`，全选复制（`Ctrl+A` / `Cmd+A`），整段粘贴进网页编辑器。
5. 点右上角 **部署**。

部署成功后访问 `$base/` 能看到首页（已配置账号、立即签到、运行日志等），说明代码上线了。首页不执行任何签到。

---

## 3. 第二步：创建 KV 并绑定

KV 用来存运行日志、定时心跳和 Token 续期记录。**不配 KV 也能签到，但没有日志、没有自动续期。**

1. 控制台左侧 **存储和数据库** → **KV** → **创建命名空间**，名字随意（如 `workbuddy`）。
2. 回到 Worker → **设置** → **绑定** → **添加** → 选 **KV 命名空间**。
3. **变量名必须填 `KV`**（大写，代码就认这个），命名空间选刚建的，保存。
4. **重新部署一次**（绑定变更需要重新部署才生效）。

> 变量名填成小写 `kv` 会导致运行时报错，务必大写。

---

## 4. 第三步：短信登录获取凭据（关键）

新版 WorkBuddy 桌面端的凭据文件已加密，无法直接复制。用官方短信登录接口拿明文 Token，分两步。

### 4.1 发送验证码

把 `13800000000` 换成你的手机号。

**PowerShell（Windows）：**
```powershell
Invoke-RestMethod -Uri "https://www.workbuddy.cn/v2/plugin/login/send-sms" -Method Post -ContentType "application/json" -Body '{"phone":"13800000000"}'
```

**curl（macOS / Linux）：**
```bash
curl -s -X POST "https://www.workbuddy.cn/v2/plugin/login/send-sms" \
  -H "Content-Type: application/json" \
  -d '{"phone":"13800000000"}'
```

返回 `code: 0` 即发送成功，等收短信。

### 4.2 用验证码登录拿 Token

把手机号和 `123456` 换成实际收到的验证码。执行后输出三行值，**复制保存好**，下一步要用。

**PowerShell（Windows）：**
```powershell
$r = Invoke-RestMethod -Uri "https://www.workbuddy.cn/v2/plugin/login/token" -Method Post -ContentType "application/json" -Body '{"login_method":"phone","phone":"13800000000","sms_code":"123456"}'; $at=$r.data.accessToken; $rt=$r.data.refreshToken; $p=$at.Split('.')[1].Replace('-','+').Replace('_','/'); $p=$p.PadRight($p.Length+(4-$p.Length%4)%4,'='); $j=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p))|ConvertFrom-Json; Write-Host "WORKBUDDY_TOKEN=$at"; Write-Host "WORKBUDDY_UID=$($j.sub)"; Write-Host "WORKBUDDY_REFRESH_TOKEN=$rt"
```

**curl + python（macOS / Linux）：**
```bash
curl -s -X POST "https://www.workbuddy.cn/v2/plugin/login/token" \
  -H "Content-Type: application/json" \
  -d '{"login_method":"phone","phone":"13800000000","sms_code":"123456"}' \
  | python3 -c "
import sys,json,base64
d=json.load(sys.stdin)['data']
at=d['accessToken']; rt=d['refreshToken']
pay=json.loads(base64.urlsafe_b64decode(at.split('.')[1]+'=='))
print(f'WORKBUDDY_TOKEN={at}')
print(f'WORKBUDDY_UID={pay[\"sub\"]}')
print(f'WORKBUDDY_REFRESH_TOKEN={rt}')
"
```

输出三行：`WORKBUDDY_TOKEN=...`、`WORKBUDDY_UID=...`、`WORKBUDDY_REFRESH_TOKEN=...`。

> 验证码有效期约 5 分钟，过期了重新发一次即可。多账号时每个号都要走一遍这一步。

---

## 5. 第四步：配置账号变量

### 单账号

Worker → **设置** → **变量和机密** → **添加**，类型选 **Secret（机密）**，依次添加：

| 变量名 | 值 | 必填 |
|---|---|---|
| `WORKBUDDY_TOKEN` | 第三步输出的 `WORKBUDDY_TOKEN` | ✅ |
| `WORKBUDDY_UID` | 第三步输出的 `WORKBUDDY_UID` | ✅ |
| `WORKBUDDY_REFRESH_TOKEN` | 第三步输出的 `WORKBUDDY_REFRESH_TOKEN` | 可选，配了就自动续期 |

企业账号可再加 `WORKBUDDY_ENTERPRISE_ID`。

### 多账号

两种方式任选其一（也可混用）。每个账号的 Token 都先用第三步获取。

**方式一：一个 Secret 存全部账号（账号少时用）**

变量名 `WORKBUDDY_ACCOUNTS`，值为 JSON 数组：

```json
[
  { "name": "主号", "token": "...", "uid": "...", "refresh_token": "..." },
  { "name": "小号", "token": "...", "uid": "...", "refresh_token": "..." }
]
```

**方式二：每个账号一个独立 Secret（账号多、单 Secret 超 5KB 时用）**

| 变量名 | 值 |
|---|---|
| `WORKBUDDY_ACCOUNT_1` | `{"name":"主号","token":"...","uid":"...","refresh_token":"..."}` |
| `WORKBUDDY_ACCOUNT_2` | `{"name":"小号","token":"...","uid":"...","refresh_token":"..."}` |

变量名必须是 `WORKBUDDY_ACCOUNT_` 加数字（从 1 开始，序号决定执行顺序）。

> 配好多账号变量后，单账号的 `WORKBUDDY_TOKEN` 等会被忽略；改回单账号删掉多账号变量即可。
>
> `name` 是日志里显示的账号名，自取。`refresh_token` 配了就启用自动续期。

配置完**重新部署一次**。

---

## 6. 第五步：配置定时 Cron

Cron 按 **UTC 时间**执行，北京时间 = UTC+8。

1. Worker → **设置** → **触发事件** → **Cron 触发器** → **添加**。
2. 按下表选表达式，保存。

**推荐每天北京时间 08:00：**
```
0 0 * * *
```

**UTC 对照表（每天一次，格式 `分 时 * * *`）：**

| 想在北京时间 | UTC 时间 | 表达式 |
|---|---|---|
| 06:00 | 前一天 22:00 | `0 22 * * *` |
| **08:00（推荐）** | 00:00 | `0 0 * * *` |
| 09:00 | 01:00 | `0 1 * * *` |
| 10:00 | 02:00 | `0 2 * * *` |
| 12:00 | 04:00 | `0 4 * * *` |
| 18:00 | 10:00 | `0 10 * * *` |
| 21:00 | 13:00 | `0 13 * * *` |
| 22:00 | 14:00 | `0 14 * * *` |

> 触发器新增/修改最多 **15 分钟**才全网生效，刚加完等一会儿没动静是正常的。
>
> 想立刻验证通不通，可以临时改成 `*/10 * * * *`（每 10 分钟一次），确认首页心跳卡亮了再改回正式表达式。
>
> 脚本幂等：已签到会直接收手，多加几条表达式（早晚各一次）不会重复领。

---

## 7. 第六步：手动试跑并查看日志

### 7.1 立即跑一次

浏览器直接打开：
```
$base/auto
```

会执行签到 + 成长中心，返回结果页。也可以在首页点「立即签到」按钮。

### 7.2 看日志

浏览器打开（收藏这个地址）：
```
$base/logs
```

- 最近 30 次运行，每 60 秒自动刷新，按时间倒序；
- 颜色区分：绿色=成功/已签到，红色=需更新凭据/错误，灰色=跳过；
- 标注**执行来源**：「定时触发」或「手动 · /auto」；
- 点「详情」展开单条完整 JSON。

### 7.3 查状态（不执行签到）

```
$base/status
```

返回每个账号的签到状态、连签天数、能量、Token 到期时间。

### 7.4 首页看定时心跳

```
$base/
```

顶部「定时任务（Cron）」卡片显示上次 Cron 触发时间。**这是判断定时任务有没有跑的最直接依据**——有记录说明触发器正常，长期为空说明没调度到（检查表达式和 Worker 绑定）。

---

## 8. 接口一览

| 路径 | 作用 |
|---|---|
| `/` | 首页：定时心跳 / 账号列表 / 操作导航，不执行签到 |
| `/auto` | 签到 + 成长中心（Cron 跑的就是它） |
| `/growth` | 仅成长中心（不签到） |
| `/status` | 查签到状态（调试用，不写日志） |
| `/claim` | 仅领取签到（调试用，幂等，不写日志） |
| `/logs` | 运行日志列表页 |
| `/logs/N` | 第 N 条日志详情（N 从 0 开始） |

可选参数：
- `?account=账号名`：多账号时只跑指定账号，如 `/auto?account=主号`
- `?key=xxx`：配了 `WORKER_SECRET` 时的访问密钥

> 浏览器访问返回可视化页面；curl / 脚本调用（不带 `Accept: text/html`）返回 JSON。
>
> 只有 `/auto` 和 `/growth` 会写运行日志，`/status` `/claim` 不写。

---

## 9. 日常运维与常见问题

### Token 自动续期（配了 `WORKBUDDY_REFRESH_TOKEN` 才生效）

- 每次运行前检查：AT 剩余 < 7 天 **或** 距上次刷新 > 10 天，满足其一就自动调刷新接口换新 AT+RT；
- 新 RT 存 KV（`signin:rt:<uid>`），下次运行优先用 KV 里更新的凭据；
- 首页账号列表中，已配 RT 的显示绿色「自动续期」徽章，未配的显示灰色「未配续期」；
- 运行结果中出现「🔄令牌已自动续期」说明本次刷新了；出现「⚠️令牌续期失败」说明 RT 可能失效了。

**前提**：必须绑定 KV（第二步），否则续期结果无法持久化，功能静默跳过。

### 访问密钥（可选，防止别人乱触发）

Worker 域名是公开的。想加一道门：

1. 设置 → 变量和机密 → 添加 Secret `WORKER_SECRET`，值自定义一串随机字符；
2. 之后访问需带 `?key=xxx` 或请求头 `X-Worker-Key: xxx`。配了密钥后所有页面都需要密钥。

### 常见问题

**问：返回 401 / TOKEN_EXPIRED / NO_SESSION？**
令牌过期了。配了 RT 自动续期一般不会出现；若仍出现说明 RT 也失效了（离线约 30 天未活跃），重做第三步拿新 Token → 更新变量 → 重新部署。

**问：Cron 到点没执行？**
先看首页「定时任务（Cron）」卡片：有记录=触发器正常，问题在别处；长期为空=没调度到。检查：表达式是否 UTC 算错、触发器绑的 Worker 和访问的域名是否同一个、是不是刚加完（等 15 分钟）。

**问：改了 Secret / 绑定没生效？**
所有设置变更都需要**重新部署一次**才生效。

**问：`/logs` 提示未绑定 KV？**
见第二步，绑定变量名必须是大写 `KV`，然后重新部署。

**问：怎么确认自动续期生效了？**
跑一次 `/auto`，report 里出现「🔄令牌已自动续期」就是刷新了。正常不会每次都刷新（AT 剩余 >7 天且距上次刷新 <10 天时跳过）。也可以在 KV 里看 `signin:rt:<uid>` 的 `refreshed_at` 字段。

**问：页面底部 version 是什么？**
构建版本号，格式 `日期:当天第几次改动`。提交推送后刷新页面看这行变没变，就能确认新版本上线了（没变就 `Ctrl+F5` 强刷）。

---

## 10. 安全须知

- `WORKBUDDY_TOKEN` / `WORKBUDDY_REFRESH_TOKEN` **等同于账号登录态**，泄露后他人可冒用身份。请只通过 Cloudflare Secret 配置，**不要**硬编码进 `worker.js` 提交到公开仓库，也不要截图发群（注意遮挡 Token 和 `?key=`）。
- Secret 类型变量在 Cloudflare 侧加密存储、部署后无法回读，比「文本」类型安全。
- 怀疑令牌泄露：在 WorkBuddy 桌面端登出再登录使旧令牌失效，然后更新 Worker 中对应变量。
