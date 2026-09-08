/**
 * WorkBuddy 每日签到自动领取 —— Cloudflare Workers 版（由 signin.py 移植）。
 *
 * 调用 WorkBuddy 服务端接口自动领取每日积分与成长中心奖励：
 *   POST {endpoint}/v2/billing/meter/checkin-activity-status  查询签到状态
 *   POST {endpoint}/v2/billing/meter/daily-checkin            领取今日积分
 *
 * 响应契约（与 Python 版一致）：
 *   - 领取成功 : 含 credit 字段，如 {"credit": 100}
 *   - 今日已签 : null 或 HTTP 400 + {"code":10001,"msg":"今天已签到，请明天再来"}
 *                幂等，两种形态都按"已签"处理，不计失败
 *   - 业务错误 : {"code": ..., "msg": ...}
 *   - 登录失效 : HTTP 401/403，需重新登录桌面端
 *
 * 凭据（Workers 无法读取本机文件，改用 Worker 的环境变量 / Secret）：
 *   WORKBUDDY_ACCOUNTS     多账号（推荐）：JSON 数组，每项形如
 *                          [
 *                            {"name":"主号","session":{ workbuddy-desktop.info 的完整 JSON 对象 }},
 *                            {"name":"小号","token":"accessToken","uid":"uid",
 *                             "enterpriseId":"可选","domain":"可选","endpoint":"可选"}
 *                          ]
 *                          其中 session 也允许是整段 JSON 字符串；name 缺省取账号昵称或"账号N"。
 *   WORKBUDDY_SESSION      单账号：workbuddy-desktop.info 的完整 JSON 内容（兼容旧配置）
 *   WORKBUDDY_TOKEN + WORKBUDDY_UID   单账号简化替代
 *   WORKBUDDY_ENTERPRISE_ID / WORKBUDDY_DOMAIN / WORKBUDDY_ENDPOINT  单账号可选项
 *   WORKER_SECRET          可选；设置后需以 ?key=xxx 或请求头 X-Worker-Key 访问（含首页）
 *   KV 绑定（变量名 KV）    可选；保存最近 30 次运行记录，/logs 查看
 *
 * 多账号：
 *   - Cron 触发时依次执行全部账号的 auto（签到 + 成长中心），结果聚合为一条运行记录；
 *   - 手动访问可加 ?account=账号名 只执行其中一个账号；
 *   - 单账号配置的 JSON 输出与旧版完全一致（仅多一个 account 字段）。
 *
 * 路由（URL 路径风格）：
 *   GET /                       首页 / 操作导航（不执行任何动作）
 *   GET /auto|/growth|/status|/claim    执行对应动作
 *   GET /logs                   运行日志列表（每 60 秒自动刷新）；/logs/N 查看第 N 条详情
 *                               （/log 为 /logs 的兼容别名）
 *
 * 页面 / 输出：
 *   - 浏览器直接访问（Accept: text/html）返回可视化 HTML 页面：日志表格、详情、执行结果；
 *   - curl / 程序调用（不带 Accept: text/html）返回 JSON；
 *   - 其余参数仍走查询串：?account=账号名、?key=xxx。
 *
 * 用法（全部在 Cloudflare 控制台完成，无需 wrangler）：
 *   - 部署：创建 Worker → 把本文件全部代码粘贴进编辑器 → 部署
 *   - 配置凭据：该 Worker 的 设置 → 变量和机密 → 添加 Secret
 *   - 定时触发：该 Worker 的 设置 → 触发事件 → Cron 触发器 → 添加如 30 1 * * *
 *     （注意 Cron 按 UTC 计算，30 1 * * * = 北京时间每天 09:30），自动执行 auto（签到 + 成长中心）
 *   - 手动触发：浏览器访问 https://<worker域名>/auto （或 /growth /status /claim /logs）
 */

const DEFAULT_ENDPOINT = "https://copilot.tencent.com";

/* ---------- HTTP 基础（对应 Python 的 _request/post/get） ---------- */

async function request(url, headers, method = "GET", payload = null) {
  const init = { method, headers };
  if (payload !== null && payload !== undefined) init.body = JSON.stringify(payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  init.signal = controller.signal;
  try {
    const resp = await fetch(url, init);
    const raw = await resp.text();
    let body;
    try {
      body = JSON.parse(raw);
    } catch (e) {
      body = { raw: String(raw).slice(0, 500) };
    }
    return { status: resp.status, body };
  } catch (e) {
    const reason = e && e.name === "AbortError" ? "请求超时(30s)" : String((e && e.message) || e);
    return { status: -1, body: { error: reason } };
  } finally {
    clearTimeout(timer);
  }
}

function post(url, headers, payload = null) {
  return request(url, headers, "POST", payload);
}

function get(url, headers) {
  return request(url, headers, "GET");
}

/* ---------- 凭据：单账号头部构建 / 多账号解析 ---------- */

function buildHeaders(session) {
  const auth = (session && session.auth) || {};
  const account = (session && session.account) || {};
  const token = auth.accessToken;
  const uid = account.uid;
  if (!token || !uid) {
    throw new Error("NO_SESSION: 会话凭据中缺少 accessToken 或 uid");
  }
  const headers = {
    "Accept": "application/json",
    "Authorization": "Bearer " + token,
    "Content-Type": "application/json",
    "X-User-Id": String(uid),
    "User-Agent": "WorkBuddy",
  };
  if (account.enterpriseId) {
    headers["X-Enterprise-Id"] = account.enterpriseId;
    headers["X-Tenant-Id"] = account.enterpriseId;
  }
  if (auth.domain) headers["X-Domain"] = auth.domain;
  return headers;
}

// 解析 WORKBUDDY_ACCOUNTS 数组中的一项，返回可直接执行的账号上下文
function buildAccount(conf, index, env) {
  if (!conf || typeof conf !== "object") throw new Error("第 " + (index + 1) + " 项不是 JSON 对象");

  let session = null;
  if (conf.session !== undefined && conf.session !== null && conf.session !== "") {
    // 形态一：{"name":"主号","session":{...整段 info JSON...}}（session 也允许是 JSON 字符串）
    session = typeof conf.session === "string" ? JSON.parse(conf.session) : conf.session;
  } else if (conf.auth && conf.account) {
    // 容错：数组元素本身就是一段 info JSON
    session = conf;
  } else if (conf.token && conf.uid) {
    // 形态二：{"name":"小号","token":"...","uid":"..."}
    session = {
      auth: { accessToken: conf.token },
      account: { uid: String(conf.uid) },
    };
    if (conf.enterpriseId) session.account.enterpriseId = conf.enterpriseId;
    if (conf.domain) session.auth.domain = conf.domain;
  } else {
    throw new Error("缺少 session（整段凭据 JSON）或 token+uid");
  }

  const headers = buildHeaders(session); // 缺 token/uid 时在此抛错
  const endpoint = ((session.auth || {}).endpoint || conf.endpoint || env.WORKBUDDY_ENDPOINT || DEFAULT_ENDPOINT).replace(/\/+$/, "");
  const tokenInfo = inspectToken(session.auth.accessToken);
  const acc = (session.account || {});
  const fallbackName = acc.nickname || acc.name || ("账号" + (index + 1));
  return { name: conf.name ? String(conf.name) : String(fallbackName), headers, endpoint, tokenInfo };
}

// 解析出本次要执行的账号列表；配置非法时抛错，单个账号非法时该账号带 error 字段，不影响其他账号
function resolveAccounts(env, filterName) {
  const accounts = [];

  if (env.WORKBUDDY_ACCOUNTS) {
    let arr;
    try {
      arr = JSON.parse(env.WORKBUDDY_ACCOUNTS);
    } catch (e) {
      throw new Error("NO_SESSION: WORKBUDDY_ACCOUNTS 不是合法 JSON（需为数组，每项含 name 与 session 或 token+uid）");
    }
    if (!Array.isArray(arr) || !arr.length) {
      throw new Error("NO_SESSION: WORKBUDDY_ACCOUNTS 必须是非空 JSON 数组");
    }
    arr.forEach((conf, i) => {
      try {
        accounts.push(buildAccount(conf, i, env));
      } catch (e) {
        accounts.push({ name: (conf && conf.name) || ("账号" + (i + 1)), error: String(e.message || e) });
      }
    });
  } else {
    // 向后兼容：单账号环境变量
    let session = null;
    if (env.WORKBUDDY_SESSION) {
      try {
        session = JSON.parse(env.WORKBUDDY_SESSION);
      } catch (e) {
        throw new Error("NO_SESSION: WORKBUDDY_SESSION 不是合法 JSON");
      }
    } else if (env.WORKBUDDY_TOKEN && env.WORKBUDDY_UID) {
      session = {
        auth: { accessToken: env.WORKBUDDY_TOKEN },
        account: { uid: env.WORKBUDDY_UID },
      };
      if (env.WORKBUDDY_ENTERPRISE_ID) session.account.enterpriseId = env.WORKBUDDY_ENTERPRISE_ID;
      if (env.WORKBUDDY_DOMAIN) session.auth.domain = env.WORKBUDDY_DOMAIN;
    }
    if (!session) {
      throw new Error(
        "NO_SESSION: 未配置登录凭据。请在 Worker 的 设置 → 变量和机密 中添加 Secret：" +
        "多账号用 WORKBUDDY_ACCOUNTS（JSON 数组）；单账号用 WORKBUDDY_SESSION（workbuddy-desktop.info 完整 JSON），" +
        "或分别添加 WORKBUDDY_TOKEN 与 WORKBUDDY_UID。"
      );
    }
    accounts.push(buildAccount({ name: "default", session: session }, 0, env));
  }

  // 重名自动加序号
  const nameCount = {};
  for (const a of accounts) {
    if (nameCount[a.name]) {
      nameCount[a.name] += 1;
      a.name = a.name + "(" + nameCount[a.name] + ")";
    } else {
      nameCount[a.name] = 1;
    }
  }

  // ?account=名字：只执行指定账号
  if (filterName) {
    const hit = accounts.filter((a) => a.name === filterName);
    if (!hit.length) {
      throw new Error("NO_SESSION: 找不到名为「" + filterName + "」的账号；当前已配置：" + accounts.map((a) => a.name).join("、"));
    }
    return hit;
  }
  return accounts;
}

/* ---------- 令牌到期预警 ---------- */

// 解析 JWT payload（不校验签名——签名只对签发方有意义，这里只读 exp 做预警）
function inspectToken(token) {
  try {
    const parts = String(token).split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (!payload.exp) return null;
    const msLeft = payload.exp * 1000 - Date.now();
    if (msLeft <= 0) return { daysLeft: 0, expired: true, expireAt: payload.exp * 1000 };
    return { daysLeft: Math.floor(msLeft / 86400000), expired: false, expireAt: payload.exp * 1000 };
  } catch (e) {
    return null; // 解析失败不影响正常签到
  }
}

// 把令牌状态附到输出上；临期/过期时改写 result 并在 report 里给出醒目警告
function applyTokenWarning(out, tokenInfo) {
  if (!tokenInfo) return out;
  const expireDate = new Date(tokenInfo.expireAt).toISOString().slice(0, 10);
  if (tokenInfo.expired) {
    return {
      ...out,
      token_expired: true,
      token_expire_at: expireDate,
      result: "TOKEN_EXPIRED",
      report: "【令牌已过期】" + out.report + "（请更新该账号的凭据 Secret）",
    };
  }
  if (tokenInfo.daysLeft <= 7) {
    return {
      ...out,
      token_days_left: tokenInfo.daysLeft,
      token_expire_at: expireDate,
      report: "【令牌 " + tokenInfo.daysLeft + " 天后过期，" + expireDate + " 到期，请尽快更新凭据】" + out.report,
    };
  }
  // 常态：仅附带到期信息，不打扰
  return { ...out, token_days_left: tokenInfo.daysLeft, token_expire_at: expireDate };
}

/* ---------- 响应解析工具（与 Python 版一一对应） ---------- */

function dig(obj, key) {
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    if (key in obj && obj[key] !== null && obj[key] !== undefined) return obj[key];
    for (const k of ["data", "result", "resp", "response"]) {
      if (k in obj && obj[k] && typeof obj[k] === "object" && !Array.isArray(obj[k])) {
        const r = dig(obj[k], key);
        if (r !== null && r !== undefined) return r;
      }
    }
  }
  return null;
}

function fmtCredit(v) {
  const n = Number(v);
  return (v !== null && v !== undefined && v !== "" && Number.isFinite(n)) ? Math.trunc(n) : v;
}

function isAlreadyCheckedIn(cbody) {
  if (cbody === null || cbody === undefined) return true;
  if (typeof cbody === "object" && !Array.isArray(cbody)) {
    const msg = String(cbody.msg || "");
    if (cbody.code === 10001 || msg.includes("已签")) return true;
  }
  return false;
}

function alreadyReport(status, via = null) {
  const todayCredit = dig(status, "today_credit") ?? dig(status, "daily_credit");
  const streakDays = dig(status, "streak_days");
  const totalCredits = dig(status, "total_credits");
  const isStreakDay = dig(status, "is_streak_day");
  const nextStreakDay = dig(status, "next_streak_day");
  const inner = [];
  if (todayCredit !== null) inner.push("今日 +" + fmtCredit(todayCredit));
  if (streakDays !== null) inner.push("连续 " + streakDays + " 天");
  if (totalCredits !== null) inner.push("累计 " + fmtCredit(totalCredits) + " 积分");
  const prefix = via || "今日已签过";
  const report = inner.length ? prefix + "（" + inner.join("，") + "）" : prefix;
  return {
    result: "ALREADY",
    report: report,
    today_credit: todayCredit,
    streak_days: streakDays,
    total_credits: totalCredits,
    is_streak_day: isStreakDay,
    next_streak_day: nextStreakDay,
  };
}

/* ---------- 成长中心（对应 Python 的 run_growth） ---------- */

async function runGrowth(headers, endpoint) {
  const base = endpoint + "/v2/activity/growth";
  const parts = [];
  let creditsGained = 0;

  // --- 1. Buddy 旅行：领礼物 + 派出发 ---
  const s = await get(base + "/buddy/travel/status", headers);
  let travel = s.status >= 200 && s.status < 300 ? dig(s.body, "state") : null;

  if (s.status === 401 || s.status === 403) {
    return { code: 1, out: { result: "NO_SESSION", report: "登录态已失效，请重新登录 WorkBuddy 桌面端" } };
  }
  if (travel === "arrived") {
    const recordId = dig(s.body, "record_id");
    const c = await post(base + "/buddy/travel/claim", headers, { record_id: recordId });
    if (c.status >= 200 && c.status < 300 && dig(c.body, "reward_credit") !== null) {
      const got = dig(c.body, "reward_credit");
      creditsGained += Number(got) || 0;
      parts.push("领旅行礼物 +" + fmtCredit(got) + " 积分");
    } else {
      parts.push("领旅行礼物失败（HTTP " + c.status + "）");
    }
    travel = "idle"; // 领完后变 idle
  }
  if (travel === "idle") {
    const c = await get(base + "/buddy/travel/config", headers);
    const locs = c.status >= 200 && c.status < 300 ? dig(c.body, "locations") : null;
    if (locs && locs.length) {
      const loc = locs[0];
      const d = await post(base + "/buddy/travel/depart", headers, { location_id: loc.id });
      if (d.status >= 200 && d.status < 300) {
        const locName = (dig(d.body, "location") || {}).name || "?";
        const dur = dig(d.body, "duration_hours") || (dig(d.body, "location") || {}).duration_hours || "?";
        parts.push("派 Buddy 去" + locName + "（" + dur + " 小时后回）");
      } else {
        const msg = dig(d.body, "msg") || "";
        parts.push("派 Buddy 失败：" + (msg || "HTTP " + d.status));
      }
    }
  } else if (travel === "traveling") {
    const locName = (dig(s.body, "location") || {}).name || "?";
    parts.push("Buddy 旅行中（" + locName + "）");
  }

  // --- 2. 盲盒/抽奖（余额有多少次就抽多少次，上限 10 次防御异常余额） ---
  const l = await get(base + "/lottery/chances", headers);
  const chances = l.status >= 200 && l.status < 300 ? (dig(l.body, "balance") || 0) : 0;
  if (chances > 0) {
    const prizes = [];
    for (let i = 0; i < Math.min(chances, 10); i++) {
      const d = await post(base + "/lottery/draw", headers, {});
      if (d.status >= 200 && d.status < 300) {
        prizes.push(dig(d.body, "prize_name") || dig(d.body, "prize") || "未知");
      } else {
        parts.push("开盲盒失败（HTTP " + d.status + "）");
        break;
      }
    }
    if (prizes.length) parts.push("开盲盒获得：" + prizes.join("、"));
  }

  // --- 3. 任务领奖 ---
  const t = await get(base + "/tasks", headers);
  if (t.status >= 200 && t.status < 300) {
    const tasks = dig(t.body, "tasks") || [];
    for (const task of tasks) {
      const prog = task.progress || {};
      const done = (prog.current || 0) >= (prog.target || 1);
      if (done && task.accept_status !== "claimed" && task.has_reward) {
        const a = await post(base + "/tasks/accept", headers, { task_code: task.task_code });
        if (a.status >= 200 && a.status < 300) {
          const rc = task.reward_credit || 0;
          const re = task.reward_energy || 0;
          creditsGained += rc;
          parts.push("领任务奖「" + (task.title || task.task_code) + "」+credit" + rc + "+energy" + re);
        }
      }
    }
  }

  // --- 4. 能量 & 连签状态 ---
  const e = await get(base + "/energy", headers);
  const energy = e.status >= 200 && e.status < 300 ? dig(e.body, "balance") : null;

  const s2 = await get(base + "/streak", headers);
  // dig 找不到时返回 null；?? null 归一，避免 days 为 undefined 时输出「连签 undefined 天」
  const streakObj = dig(s2.body, "streak") || {};
  const streakDays = streakObj && typeof streakObj === "object" ? (streakObj.days ?? null) : null;

  const tail = [];
  if (energy !== null) tail.push("能量 " + energy);
  if (streakDays !== null) tail.push("连签 " + streakDays + " 天");
  if (creditsGained) tail.push("本次 +共 " + creditsGained + " 积分");

  let report = parts.length ? parts.join("；") : "成长中心无可领取项";
  if (tail.length) report += "（" + tail.join("，") + "）";
  return {
    code: 0,
    out: { result: "GROWTH", report: report, credits_gained: creditsGained, energy: energy, streak_days: streakDays },
  };
}

/* ---------- 签到主逻辑（对应 Python 的 run_auto） ---------- */

async function runAuto(headers, endpoint) {
  const s = await post(endpoint + "/v2/billing/meter/checkin-activity-status", headers);

  if (s.status === 401 || s.status === 403) {
    return {
      code: 1,
      out: { result: "NO_SESSION", report: "登录态已失效（HTTP " + s.status + "），请重新登录 WorkBuddy 桌面端", http: s.status },
    };
  }
  if (!(s.status >= 200 && s.status < 300)) {
    return {
      code: 1,
      out: {
        result: "ERROR",
        report: "签到接口返回异常（HTTP " + s.status + "），可能登录态失效，请重新登录客户端",
        http: s.status,
        status_body: s.body,
      },
    };
  }

  const status = s.body && typeof s.body === "object" ? s.body : {};
  const active = dig(status, "active");
  const activityName = dig(status, "activity_name");

  if (active === false) {
    const report = "签到活动未开启" + (activityName ? "（" + activityName + "）" : "");
    return { code: 0, out: { result: "INACTIVE", report: report, active: false } };
  }

  if (dig(status, "today_checked_in") === true) {
    return { code: 0, out: alreadyReport(status) };
  }

  const c = await post(endpoint + "/v2/billing/meter/daily-checkin", headers);

  if (isAlreadyCheckedIn(c.body)) {
    const s2 = await post(endpoint + "/v2/billing/meter/checkin-activity-status", headers);
    const fresh = s2.status >= 200 && s2.status < 300 && s2.body && typeof s2.body === "object" ? s2.body : status;
    return { code: 0, out: alreadyReport(fresh, "今日已签过（服务端判定已领取）") };
  }

  if (c.status === 401 || c.status === 403) {
    return {
      code: 1,
      out: { result: "NO_SESSION", report: "登录态已失效（HTTP " + c.status + "），请重新登录 WorkBuddy 桌面端", http: c.status },
    };
  }

  const credit = dig(c.body, "credit");
  if (credit !== null) {
    const s2 = await post(endpoint + "/v2/billing/meter/checkin-activity-status", headers);
    const fresh = s2.status >= 200 && s2.status < 300 && s2.body && typeof s2.body === "object" ? s2.body : status;
    // 用 ?? 而非 ||：streak_days 为 0 时不应回退；字段整体缺失时为 null
    const streakDays = dig(fresh, "streak_days") ?? dig(status, "streak_days");
    const totalCredits = dig(fresh, "total_credits");
    const isStreakDay = dig(fresh, "is_streak_day");
    const nextStreakDay = dig(fresh, "next_streak_day");
    // 各片段缺失时不输出，避免出现「连续 null 天」
    const tails = [];
    if (isStreakDay) tails.push("且为连签奖励日");
    if (streakDays !== null && streakDays !== undefined) tails.push("连续 " + streakDays + " 天");
    if (totalCredits !== null) tails.push("累计 " + fmtCredit(totalCredits) + " 积分");
    const report = "成功领取 " + fmtCredit(credit) + " 积分" + (tails.length ? "（" + tails.join("，") + "）" : "");
    return {
      code: 0,
      out: {
        result: "CLAIMED",
        report: report,
        credit: credit,
        streak_days: streakDays,
        total_credits: totalCredits,
        is_streak_day: isStreakDay,
        next_streak_day: nextStreakDay,
      },
    };
  }

  if (c.body && typeof c.body === "object" && ("code" in c.body || "msg" in c.body)) {
    const msg = c.body.msg || "code " + c.body.code;
    return {
      code: 1,
      out: { result: "ERROR", report: "领取失败：" + msg + "（HTTP " + c.status + "）", http: c.status, claim_body: c.body },
    };
  }

  return {
    code: 1,
    out: {
      result: "UNKNOWN",
      report: "未识别的领取返回，请检查接口：" + JSON.stringify(c.body).slice(0, 200),
      http: c.status,
      claim_body: c.body,
    },
  };
}

/* ---------- 动作调度：单账号执行 + 多账号聚合 ---------- */

// trigger：执行来源标记，写入日志便于区分（"cron" = 定时触发 / "http:<action>" = 手动访问）
async function runOne(account, action, trigger) {
  // 该账号自身配置非法（如 JSON 残缺、缺 token），直接返回失败、不发任何请求
  if (account.error) {
    return { code: 1, out: { account: account.name, trigger: trigger, result: "NO_SESSION", report: "账号配置无效：" + account.error } };
  }
  const { headers, endpoint, tokenInfo } = account;

  let r;
  switch (action) {
    case "auto": {
      r = await runAuto(headers, endpoint);
      // 仅当签到链路正常（CLAIMED / ALREADY / INACTIVE，code===0）时才顺带跑成长中心；
      // 登录失效或接口异常（code!==0）时直接返回，避免用失效登录态白打一串成长中心请求
      if (r.code === 0) {
        const g = await runGrowth(headers, endpoint);
        r.out.growth = g.out.report;
        if (g.out.credits_gained) r.out.report += "；" + g.out.report;
      }
      break;
    }
    case "growth":
      r = await runGrowth(headers, endpoint);
      break;
    case "status": {
      const s = await post(endpoint + "/v2/billing/meter/checkin-activity-status", headers);
      r = { code: 0, out: { step: "status", http: s.status, body: s.body } };
      break;
    }
    case "claim": {
      const c = await post(endpoint + "/v2/billing/meter/daily-checkin", headers);
      r = { code: 0, out: { step: "claim", http: c.status, body: c.body } };
      break;
    }
    default:
      return { code: 2, out: { account: account.name, trigger: trigger, result: "BAD_ACTION", report: "未知 action：" + action + "（可选 auto/growth/status/claim）" } };
  }

  // 附上账号名、执行来源与令牌到期预警
  r.out.account = account.name;
  r.out.trigger = trigger;
  r.out = applyTokenWarning(r.out, tokenInfo);
  return r;
}

const GOOD_RESULTS = new Set(["CLAIMED", "ALREADY", "INACTIVE", "GROWTH", "OK"]);

// status/claim 等调试动作的输出没有 result 字段，聚合时按其 HTTP 状态归一：
// 2xx/3xx 算 OK，4xx/5xx/网络异常(-1) 算 ERROR，避免顶层 result 变成 undefined
function effectiveResult(o) {
  if (o.result) return o.result;
  if (o.step) {
    const n = Number(o.http);
    return (n >= 200 && n < 400) ? "OK" : "ERROR";
  }
  return undefined;
}

function aggregateResult(outs) {
  const results = outs.map(effectiveResult);
  const bad = results.filter((x) => !GOOD_RESULTS.has(x));
  if (!bad.length) {
    if (results.every((x) => x === results[0])) return results[0];
    if (results.includes("CLAIMED")) return "CLAIMED"; // 有账号领到积分即算领取成功
    return "OK";
  }
  if (bad.length === results.length && results.every((x) => x === results[0])) return results[0];
  return bad.length === results.length ? "FAILED" : "PARTIAL_FAILED";
}

// 多账号依次执行并聚合；单账号输出保持平铺（与旧版 JSON 形态兼容）
async function runAction(env, action, trigger, filterName) {
  let accounts;
  try {
    accounts = resolveAccounts(env, filterName);
  } catch (e) {
    return { code: 1, out: { trigger: trigger, result: "NO_SESSION", report: String(e.message || e) } };
  }

  const results = [];
  for (const acc of accounts) {
    results.push(await runOne(acc, action, trigger));
  }

  if (results.length === 1) return results[0];

  const outs = results.map((r) => r.out);
  const code = results.some((r) => r.code !== 0) ? 1 : 0;
  return {
    code: code,
    out: {
      result: aggregateResult(outs),
      // 调试动作没有 report，用 debugBrief 生成 "[step] HTTP n"，避免出现 "[账号] ；" 空壳
      report: outs.map((o) => "[" + (o.account || "默认") + "] " + (o.report || debugBrief(o) || "")).join("；"),
      accounts: outs,
      trigger: trigger,
    },
  };
}

/* ---------- KV 运行日志 ---------- */

async function saveLog(env, out) {
  if (!env.KV) return;
  // 北京时间（UTC+8），格式 yyyy-MM-dd HH:mm:ss，如 2026-09-01 08:00:42
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  const time = d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate()) +
    " " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + ":" + p(d.getUTCSeconds());
  const entry = { time: time, ...out };
  try {
    let history = [];
    try {
      history = JSON.parse((await env.KV.get("signin:history")) || "[]");
    } catch (e) {
      history = [];
    }
    history.unshift(entry);
    history = history.slice(0, 30);
    await env.KV.put("signin:history", JSON.stringify(history));
  } catch (e) {
    console.log("[workbuddy-signin] 写入 KV 日志失败：" + e);
  }
}

async function loadHistory(env) {
  if (!env.KV) return [];
  try {
    return JSON.parse((await env.KV.get("signin:history")) || "[]");
  } catch (e) {
    return [];
  }
}

/* ---------- JSON / HTML 响应 ---------- */

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status: status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status: status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function truncate(s, n) {
  s = String(s == null ? "" : s).replace(/\s+/g, " ");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function triggerLabel(t) {
  if (!t) return "-";
  if (t === "cron") return "定时触发";
  if (t.indexOf("http:") === 0) return "手动 · " + t.slice(5);
  return t;
}

// result → 中文徽章文案与样式类
const RESULT_META = {
  CLAIMED: ["已领取", "claimed"],
  ALREADY: ["已签到", "already"],
  GROWTH: ["成长中心", "growth"],
  INACTIVE: ["活动未开", "inactive"],
  TOKEN_EXPIRED: ["令牌过期", "token_expired"],
  NO_SESSION: ["登录失效", "no_session"],
  ERROR: ["错误", "error"],
  UNKNOWN: ["未知", "unknown"],
  PARTIAL_FAILED: ["部分失败", "partial_failed"],
  FAILED: ["失败", "failed"],
  OK: ["正常", "ok"],
};

function badgeFor(out) {
  const r = (out && out.result) || "";
  if (!r && out && out.step) return { label: "调试 · " + out.step, cls: "debug" };
  const m = RESULT_META[r];
  return m ? { label: m[0], cls: m[1] } : { label: r || "-", cls: "inactive" };
}

function badgeHtml(out) {
  const b = badgeFor(out);
  return '<span class="badge b-' + b.cls + '">' + escapeHtml(b.label) + "</span>";
}

const PAGE_CSS = `
*{box-sizing:border-box;}
body{margin:0;background:#F4F3EE;color:#1A1B1C;font-family:'PingFang SC','Segoe UI','Microsoft YaHei',Arial,sans-serif;line-height:1.6;font-size:13.5px;}
.wrap{max-width:920px;margin:0 auto;padding:20px 14px 40px;}
.hd{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px;}
h2{font-size:17px;margin:0;font-weight:600;}
h3{font-size:14px;margin:16px 0 6px;}
.sub{font-size:12px;color:#6B7280;}
hr{border:none;border-top:1px solid #E4E3DD;margin:12px 0;}
a{color:#2E7E96;text-decoration:none;} a:hover{text-decoration:underline;}
code{background:rgba(46,126,150,.08);border:1px solid rgba(46,126,150,.18);border-radius:4px;padding:0 4px;font-size:12px;}
.tbl-scroll{overflow-x:auto;}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #E4E3DD;border-radius:12px;overflow:hidden;}
th{text-align:left;background:rgba(163,213,232,.18);font-size:12px;color:#374151;padding:8px 10px;font-weight:600;white-space:nowrap;}
td{padding:8px 10px;font-size:13px;border-top:1px solid #F0EFEA;vertical-align:top;}
.badge{display:inline-block;padding:2px 9px;border-radius:10px;font-size:12px;white-space:nowrap;}
/* 徽章配色与 trae 版统一：成功/已签=绿，错误/登录失效=红，中性=灰，信息=蓝 */
.b-claimed,.b-already,.b-growth{background:rgba(82,196,26,.14);color:#2F6B12;}
.b-ok,.b-debug{background:rgba(139,200,234,.22);color:#25607A;}
.b-inactive{background:rgba(0,0,0,.05);color:#5B6470;}
.b-no_session,.b-token_expired,.b-error,.b-unknown,.b-partial_failed,.b-failed{background:rgba(234,102,104,.12);color:#A33D3F;}
.card{background:#fff;border:1px solid #E4E3DD;border-radius:12px;padding:12px 14px;margin:10px 0;}
.cardhd{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:4px;}
.accname{font-weight:600;font-size:14px;}
.report{font-size:13.5px;color:#1F2937;word-break:break-word;}
.meta{font-size:12px;color:#6B7280;margin-top:5px;word-break:break-word;}
pre{white-space:pre-wrap;word-break:break-all;background:#fff;border:1px solid #E4E3DD;border-radius:12px;padding:14px;font-size:12.5px;line-height:1.6;}
details{margin-top:8px;} summary{cursor:pointer;color:#6B7280;font-size:12.5px;}
.btnrow a{display:inline-block;padding:6px 14px;border:1px solid #CFDADF;background:#fff;border-radius:999px;font-size:13px;margin:0 8px 8px 0;}
.warn{border-color:rgba(234,102,104,.45);}
`;

function pageShell(title, inner, autoRefresh) {
  return "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">" +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    (autoRefresh ? '<meta http-equiv="refresh" content="60">' : "") +
    "<title>" + escapeHtml(title) + "</title><style>" + PAGE_CSS + "</style></head>" +
    '<body><div class="wrap">' + inner +
    '<footer style="text-align:center;margin-top:18px;font-size:12px;color:#8A919C;">Powered by <a href="https://github.com/chevy222/workbuddy-cf-checkin" target="_blank" rel="noopener">Github</a></footer>' +
    '</div></body></html>';
}

// 内部链接：动作走 URL 路径（与 trae 版一致），访问密钥等仍走查询串。
// keyPart 为不含分隔符的查询片段，如 "key=abc"；extra 为可选的额外查询参数，如 "i=0"。
function linkQ(action, keyPart, extra) {
  const q = [keyPart, extra].filter(Boolean).join("&");
  return "/" + action + (q ? "?" + q : "");
}

function debugBrief(o) {
  if (!o) return "";
  if (o.step) return "[" + o.step + "] HTTP " + o.http;
  return "";
}

// 顶部工具条：胶囊按钮，与 trae 版统一样式（首页本身不用，避免出现指向自己的"首页"按钮）
function toolbar(keyPart) {
  const home = "/" + (keyPart ? "?" + keyPart : "");
  return '<div class="btnrow" style="margin-top:4px;">' +
    '<a href="' + linkQ("auto", keyPart) + '">▶ 立即签到</a>' +
    '<a href="' + linkQ("growth", keyPart) + '">成长中心</a>' +
    '<a href="' + linkQ("logs", keyPart) + '">运行日志</a>' +
    '<a href="' + linkQ("status", keyPart) + '">查状态</a>' +
    '<a href="' + home + '">首页</a>' +
    "</div>";
}

// 单账号兼容配置的内部名 default 不直接展示给用户
function displayName(n) {
  return n && n !== "default" ? n : "默认账号";
}

function accountCard(a) {
  const meta = [];
  if (a.credit != null) meta.push("本次 " + a.credit + " 积分");
  if (a.streak_days != null) meta.push("连续 " + a.streak_days + " 天");
  if (a.total_credits != null) meta.push("累计 " + a.total_credits + " 积分");
  if (a.energy != null) meta.push("能量 " + a.energy);
  if (a.credits_gained != null && a.credits_gained) meta.push("成长中心 +" + a.credits_gained + " 积分");
  if (a.token_days_left != null) meta.push("令牌剩 " + a.token_days_left + " 天（" + a.token_expire_at + " 到期）");
  if (a.token_expired) meta.push("令牌已过期（" + a.token_expire_at + "）");

  // 单账号（内部名 default）不重复显示账号名
  const nameHtml = (a.account && a.account !== "default")
    ? '<span class="accname">' + escapeHtml(a.account) + "</span>"
    : "";
  let html = '<div class="card"><div class="cardhd">' +
    nameHtml + badgeHtml(a) +
    (a.http != null ? '<span class="sub">HTTP ' + a.http + "</span>" : "") +
    '</div><div class="report">' + escapeHtml(a.report || debugBrief(a) || "-") + "</div>";
  if (a.growth) html += '<div class="meta">成长中心：' + escapeHtml(a.growth) + "</div>";
  if (meta.length) html += '<div class="meta">' + meta.map(escapeHtml).join(" · ") + "</div>";
  if (a.step) {
    html += "<details><summary>查看接口原始返回</summary><pre>" + escapeHtml(JSON.stringify(a.body, null, 2)) + "</pre></details>";
  }
  return html + "</div>";
}

// 日志列表页（路径风格 /logs：表格 + 徽章，60 秒自动刷新）
function renderLogList(history, keyPart) {
  let rows = "";
  if (!history.length) {
    rows = '<tr><td colspan="5" class="sub" style="padding:18px 10px;">暂无运行记录，点上方「立即签到」执行一次后即可看到。</td></tr>';
  } else {
    history.forEach((e, idx) => {
      const multi = Array.isArray(e.accounts) && e.accounts.length;
      const lines = multi ? e.accounts : [e];
      lines.forEach((o, j) => {
        const b = badgeFor(o);
        const note = o.report || debugBrief(o) || "";
        let row = "<tr>";
        if (j === 0) {
          row += '<td rowspan="' + lines.length + '" style="white-space:nowrap;color:#6B7280;font-size:12px;">' +
            escapeHtml(e.time) + "<br>" + escapeHtml(triggerLabel(e.trigger)) + "</td>";
        }
        row += '<td><span class="badge b-' + b.cls + '">' + escapeHtml(b.label) + "</span></td>";
        const accLabel = o.account && o.account !== "default" ? o.account : "—";
        row += '<td style="white-space:nowrap;">' + escapeHtml(accLabel) + "</td>";
        row += '<td style="color:#374151;">' + escapeHtml(truncate(note, 120)) + "</td>";
        if (j === 0) {
          row += '<td rowspan="' + lines.length + '" style="white-space:nowrap;"><a href="' + linkQ("logs", keyPart, "i=" + idx) + '">详情</a></td>';
        }
        row += "</tr>";
        rows += row;
      });
    });
  }

  const inner =
    '<div class="hd"><h2>WorkBuddy 签到运行日志</h2>' +
    '<span class="sub">最近 ' + history.length + ' 条运行记录 · 每 60 秒自动刷新 · 仅保留最近 30 次</span></div>' +
    toolbar(keyPart) +
    "<hr>" +
    '<div class="tbl-scroll"><table><thead><tr>' +
    "<th>时间(北京)</th><th>结果</th><th>账号</th><th>说明</th><th></th>" +
    "</tr></thead><tbody>" + rows + "</tbody></table></div>";
  return pageShell("WorkBuddy 签到日志", inner, true);
}

// 日志详情页
function renderDetail(history, i, keyPart) {
  const e = history[i];
  let inner = toolbar(keyPart);
  if (!e) {
    inner += '<div class="card sub">记录不存在（可能已被新记录挤出，仅保留最近 30 次运行）。</div>';
  } else {
    inner += '<div class="card"><b>' + escapeHtml(e.time) + "</b> &nbsp;<span class=\"sub\">" + escapeHtml(triggerLabel(e.trigger)) + "</span></div>" +
      "<pre>" + escapeHtml(JSON.stringify(e, null, 2)) + "</pre>";
  }
  return pageShell("日志详情", inner, false);
}

// 动作执行结果页
function renderResult(out, action, keyPart) {
  const actionName = { auto: "每日签到（/auto）", growth: "成长中心", status: "查询签到状态", claim: "领取签到" }[action] || action;
  let body = "";
  if (Array.isArray(out.accounts) && out.accounts.length > 1) {
    body += '<div class="card"><div class="cardhd"><span class="accname">汇总</span>' + badgeHtml(out) + "</div>" +
      '<div class="report">' + escapeHtml(out.report || "") + "</div></div>";
    body += out.accounts.map(accountCard).join("");
  } else {
    const one = (Array.isArray(out.accounts) && out.accounts[0]) || out;
    body += accountCard(one);
  }
  body += "<details><summary>查看本次完整 JSON</summary><pre>" + escapeHtml(JSON.stringify(out, null, 2)) + "</pre></details>";

  const inner =
    '<div class="hd"><h2>执行结果 · ' + escapeHtml(actionName) + "</h2>" +
    '<span class="sub">' + escapeHtml(triggerLabel(out.trigger)) + "</span></div>" +
    toolbar(keyPart) + body;
  return pageShell("执行结果", inner, false); // 动作页不自动刷新，避免定时重复执行
}

// 裸访问首页
function renderHome(env, keyPart) {
  let accBlock;
  try {
    const accs = resolveAccounts(env);
    const lines = accs.map((a) => {
      if (a.error) return escapeHtml(displayName(a.name)) + '：<span style="color:#B03A3C;">配置无效（' + escapeHtml(a.error) + "）</span>";
      let t = "";
      if (a.tokenInfo) {
        const expireDate = new Date(a.tokenInfo.expireAt).toISOString().slice(0, 10);
        t = a.tokenInfo.expired
          ? '，<span style="color:#B03A3C;">令牌已过期（' + expireDate + "）</span>"
          : "，令牌剩 " + a.tokenInfo.daysLeft + " 天（" + expireDate + " 到期）";
      }
      return escapeHtml(displayName(a.name)) + t;
    });
    accBlock = '<div class="card">已配置 <b>' + accs.length + "</b> 个账号：<br>" + lines.join("<br>") + "</div>";
  } catch (e) {
    accBlock = '<div class="card warn" style="color:#B03A3C;">' + escapeHtml(String(e.message || e)) + "</div>";
  }

  const rows = [
    ["auto", "每日自动化：签到 + 成长中心（Cron 每天执行的就是它）"],
    ["growth", "只跑成长中心：旅行礼物 / 派出 / 盲盒 / 任务奖励"],
    ["status", "只查签到状态（调试用，不领取，不写入日志）"],
    ["claim", "只执行领取（调试用，幂等，不写入日志）"],
    ["logs", "查看最近 30 次运行记录（本页面）"],
  ].map(([act, desc]) =>
    "<tr><td style=\"white-space:nowrap;\"><a href=\"" + linkQ(act, keyPart) + "\">/" + act + "</a></td><td class=\"sub\">" + desc + "</td></tr>"
  ).join("");

  const inner =
    '<div class="hd"><h2>WorkBuddy 签到 Worker</h2><span class="sub">云端自动签到 · 幂等可重复执行</span></div>' +
    accBlock +
    '<div class="btnrow" style="margin-top:6px;">' +
      '<a href="' + linkQ("auto", keyPart) + '">▶ 立即签到</a>' +
      '<a href="' + linkQ("logs", keyPart) + '">运行日志</a>' +
    "</div>" +
    '<h3>可用操作</h3><div class="tbl-scroll"><table><tbody>' + rows + "</tbody></table></div>" +
    '<p class="sub" style="margin-top:12px;">提示：<code>/auto</code>、<code>/growth</code>、<code>/status</code>、<code>/claim</code>、<code>/logs</code> 浏览器可直接打开；程序调用时返回 JSON。多账号可用 <code>?account=账号名</code> 只执行其中一个。</p>';
  return pageShell("WorkBuddy 签到 Worker", inner, false);
}

/* ---------- Workers 入口 ---------- */

function wantsHtml(request) {
  return (request.headers.get("accept") || "").includes("text/html");
}

// 可执行动作集合（日志走独立路由 /logs）
const ACTION_PATHS = new Set(["auto", "growth", "status", "claim"]);

// URL 路径 → 路由（路径风格，与 trae 版一致）：
//   /                       home（说明页，不执行）
//   /auto ... /claim        { kind:"action", action }
//   /logs、/log             { kind:"logs" }；/logs/N（或 /logs?i=N）→ { kind:"detail", i }
//   其余任意路径             { kind:"notfound" }
function parseRoute(url) {
  const segs = url.pathname.split("/").filter(Boolean);
  if (!segs.length) return { kind: "home" };
  const first = String(segs[0]).toLowerCase();
  if (first === "log" || first === "logs") {
    if (segs.length === 1) {
      return url.searchParams.get("i") !== null ? { kind: "detail", i: url.searchParams.get("i") } : { kind: "logs" };
    }
    if (segs.length === 2) return { kind: "detail", i: segs[1] };
    return { kind: "notfound" };
  }
  if (segs.length === 1 && ACTION_PATHS.has(first)) return { kind: "action", action: first };
  return { kind: "notfound" };
}

export default {
  // 定时任务：每天自动签到 + 成长中心（对应 Python 的 auto 模式 + 计划任务；多账号全部执行）
  async scheduled(event, env, ctx) {
    const result = await runAction(env, "auto", "cron");
    console.log("[workbuddy-signin] " + JSON.stringify(result.out, null, 2));
    await saveLog(env, result.out);
  },

  // HTTP 触发（URL 路径风格）：
  //   GET /                       首页/导航（不执行动作）
  //   GET /auto|/growth|/status|/claim                      执行对应动作
  //   GET /logs                   日志列表；/logs/N（或 /logs?i=N）第 N 条详情（/log 为别名）
  //   查询串：?account=名字（多账号筛选）、?key=xxx（访问密钥）
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const route = parseRoute(url);

    // 未知路径（含 /favicon.ico 与扫描器探测）：一律 404，不执行动作、不写日志
    if (route.kind === "notfound") {
      if ((request.headers.get("accept") || "").includes("text/html")) {
        return htmlResponse(pageShell("Not Found",
          '<div class="card">页面不存在。返回 <a href="/">首页</a>，可用路径：/auto、/growth、/status、/claim、/logs。</div>', false), 404);
      }
      return new Response("Not Found", { status: 404 });
    }

    const asHtml = wantsHtml(request);
    // 透传 ?key= 到页面内链接（header 方式访问时无 key 可透传）
    const keyVal = url.searchParams.get("key");
    const keyPart = keyVal != null ? "key=" + encodeURIComponent(keyVal) : "";

    // 配置 WORKER_SECRET 后，所有页面与动作（含首页）都需要密钥，
    // 避免首页泄露账号数量、昵称与令牌到期时间
    if (env.WORKER_SECRET) {
      const key = keyVal || request.headers.get("x-worker-key");
      if (key !== env.WORKER_SECRET) {
        if (asHtml) {
          return htmlResponse(pageShell("未授权", '<div class="card warn" style="color:#B03A3C;">缺少或错误的访问密钥（需在 URL 带 ?key=xxx，或请求头 X-Worker-Key）。</div>', false), 401);
        }
        return jsonResponse({ result: "UNAUTHORIZED", report: "缺少或错误的访问密钥（?key=xxx 或请求头 X-Worker-Key）" }, 401);
      }
    }

    // 裸访问首页：只返回说明页/首页，不执行任何动作。
    // （公网域名会被扫描器频繁访问，若默认执行 auto，每次扫描都会
    //   白跑一遍签到流程并写一条日志）
    if (route.kind === "home") {
      if (asHtml) return htmlResponse(renderHome(env, keyPart));
      return jsonResponse({
        result: "OK",
        report: "WorkBuddy 签到 Worker 运行中。路径：/auto（签到+成长中心）、/growth、/status、/claim、/logs（运行日志）；浏览器访问为可视化页面，旧版 JSON 输出形态仍兼容。",
      });
    }

    if (route.kind === "logs" || route.kind === "detail") {
      if (!env.KV) {
        const msg = "未绑定 KV 命名空间（变量名 KV），无法查询历史记录";
        if (asHtml) return htmlResponse(pageShell("无法查看日志", '<div class="card warn" style="color:#8A5A00;">' + msg + "。</div>", false), 400);
        return jsonResponse({ result: "ERROR", report: msg }, 400);
      }
      const history = await loadHistory(env);
      if (route.kind === "detail") {
        // 详情：/logs/N 或 /logs?i=N
        const idx = Number(route.i);
        if (asHtml) return htmlResponse(renderDetail(history, idx, keyPart));
        return jsonResponse({ result: "DETAIL", index: idx, entry: history[idx] || null });
      }
      if (asHtml) return htmlResponse(renderLogList(history, keyPart));
      return jsonResponse({ result: "LOG", count: history.length, history: history });
    }

    const action = route.action;
    const filterAccount = url.searchParams.get("account") || undefined;
    const result = await runAction(env, action, "http:" + action, filterAccount);
    // 只有 auto / growth 写入运行日志；status / claim 为调试动作，避免刷屏淹没真正的签到记录
    if (action === "auto" || action === "growth") await saveLog(env, result.out);
    if (asHtml) return htmlResponse(renderResult(result.out, action, keyPart), result.code === 0 ? 200 : 500);
    return jsonResponse(result.out, result.code === 0 ? 200 : 500);
  },
};
