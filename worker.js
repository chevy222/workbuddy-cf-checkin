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
 *   WORKBUDDY_SESSION        workbuddy-desktop.info 的完整 JSON 内容（推荐）
 *   WORKBUDDY_TOKEN          accessToken（与 WORKBUDDY_UID 搭配，作为简化替代）
 *   WORKBUDDY_UID            账号 uid
 *   WORKBUDDY_ENTERPRISE_ID  可选，企业 ID
 *   WORKBUDDY_DOMAIN         可选
 *   WORKBUDDY_ENDPOINT       可选，默认 https://copilot.tencent.com
 *   WORKER_SECRET            可选；设置后需以 ?key=xxx 或请求头 X-Worker-Key 访问
 *   KV 绑定（变量名 KV）      可选；保存最近 30 次运行记录，?action=log 查看
 *
 * 用法（全部在 Cloudflare 控制台完成，无需 wrangler）：
 *   - 部署：创建 Worker → 把本文件全部代码粘贴进编辑器 → 部署
 *   - 配置凭据：该 Worker 的 设置 → 变量和机密 → 添加 Secret（如 WORKBUDDY_SESSION）
 *   - 定时触发：该 Worker 的 设置 → 触发事件 → Cron 触发器 → 添加如 30 1 * * *
 *     （注意 Cron 按 UTC 计算，30 1 * * * = 北京时间每天 09:30），自动执行 auto（签到 + 成长中心）
 *   - 手动触发：浏览器访问 https://<worker域名>/?action=auto|growth|status|claim|all|log
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

/* ---------- 凭据（对应 Python 的 find_auth_file/load_session/build_headers） ---------- */

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

function resolveContext(env) {
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
      "NO_SESSION: 未配置登录凭据。请在 Worker 的 设置 → 变量和机密 中添加 Secret 变量 WORKBUDDY_SESSION" +
      "（值为 workbuddy-desktop.info 的完整 JSON 内容）；或分别添加 WORKBUDDY_TOKEN 与 WORKBUDDY_UID。"
    );
  }
  const headers = buildHeaders(session);
  const endpoint = (((session.auth || {}).endpoint) || env.WORKBUDDY_ENDPOINT || DEFAULT_ENDPOINT).replace(/\/+$/, "");
  const tokenInfo = inspectToken(session.auth.accessToken);
  return { headers, endpoint, tokenInfo };
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
      report: "【令牌已过期】" + out.report + "（请重新登录 WorkBuddy 桌面端并更新 WORKBUDDY_SESSION）",
    };
  }
  if (tokenInfo.daysLeft <= 7) {
    return {
      ...out,
      token_days_left: tokenInfo.daysLeft,
      token_expire_at: expireDate,
      report: "【令牌 " + tokenInfo.daysLeft + " 天后过期，" + expireDate + " 到期，请尽快更新 WORKBUDDY_SESSION】" + out.report,
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
  const todayCredit = dig(status, "today_credit") || dig(status, "daily_credit");
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

  // --- 2. 盲盒/抽奖 ---
  const l = await get(base + "/lottery/chances", headers);
  const chances = l.status >= 200 && l.status < 300 ? (dig(l.body, "balance") || 0) : 0;
  if (chances > 0) {
    const d = await post(base + "/lottery/draw", headers, {});
    if (d.status >= 200 && d.status < 300) {
      const prize = dig(d.body, "prize_name") || dig(d.body, "prize") || "未知";
      parts.push("开盲盒获得：" + prize);
    } else {
      parts.push("开盲盒失败（HTTP " + d.status + "）");
    }
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
  const streakObj = dig(s2.body, "streak") || {};
  const streakDays = streakObj && typeof streakObj === "object" ? streakObj.days : null;

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
    const streakDays = dig(fresh, "streak_days") || dig(status, "streak_days");
    const totalCredits = dig(fresh, "total_credits");
    const isStreakDay = dig(fresh, "is_streak_day");
    const nextStreakDay = dig(fresh, "next_streak_day");
    const bonus = isStreakDay ? "，且为连签奖励日" : "";
    const cum = totalCredits !== null ? "，累计 " + fmtCredit(totalCredits) + " 积分" : "";
    const report = "成功领取 " + fmtCredit(credit) + " 积分" + bonus + "（连续 " + streakDays + " 天" + cum + "）";
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

/* ---------- 动作调度（对应 Python 的 main） ---------- */

// trigger：执行来源标记，写入日志便于区分（"cron" = 定时触发 / "http:<action>" = 手动访问）
async function runAction(env, action, trigger) {
  let ctx;
  try {
    ctx = resolveContext(env);
  } catch (e) {
    return { code: 1, out: { trigger: trigger, result: "NO_SESSION", report: String(e.message || e) } };
  }
  const { headers, endpoint, tokenInfo } = ctx;

  let r;
  switch (action) {
    case "auto": {
      r = await runAuto(headers, endpoint);
      // 签到后顺带跑成长中心
      const g = await runGrowth(headers, endpoint);
      r.out.growth = g.out.report;
      if (g.out.credits_gained) r.out.report += "；" + g.out.report;
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
    case "all": {
      const s = await post(endpoint + "/v2/billing/meter/checkin-activity-status", headers);
      const c = await post(endpoint + "/v2/billing/meter/daily-checkin", headers);
      r = {
        code: 0,
        out: {
          status: { http: s.status, body: s.body },
          claim: { http: c.status, body: c.body },
        },
      };
      break;
    }
    default:
      return { code: 2, out: { trigger: trigger, result: "BAD_ACTION", report: "未知 action：" + action + "（可选 auto/growth/status/claim/all/log）" } };
  }

  // 附上执行来源与令牌到期预警
  r.out.trigger = trigger;
  r.out = applyTokenWarning(r.out, tokenInfo);
  return r;
}

async function saveLog(env, out) {
  if (!env.KV) return;
  const entry = { time: new Date().toISOString(), ...out };
  try {
    await env.KV.put("signin:last", JSON.stringify(entry));
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

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status: status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/* ---------- Workers 入口 ---------- */

export default {
  // 定时任务：每天自动签到 + 成长中心（对应 Python 的 auto 模式 + 计划任务）
  async scheduled(event, env, ctx) {
    const result = await runAction(env, "auto", "cron");
    console.log("[workbuddy-signin] " + JSON.stringify(result.out, null, 2));
    await saveLog(env, result.out);
  },

  // HTTP 触发：GET /?action=auto|growth|status|claim|all|log
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 忽略 favicon 等非根路径请求（浏览器每次访问页面都会自动请求 /favicon.ico，
    // 若不拦截，会以默认 action=auto 触发一整套签到流程并写入多余日志）
    if (url.pathname !== "/") {
      return new Response("Not Found", { status: 404 });
    }

    const action = (url.searchParams.get("action") || "auto").toLowerCase();

    if (env.WORKER_SECRET) {
      const key = url.searchParams.get("key") || request.headers.get("x-worker-key");
      if (key !== env.WORKER_SECRET) {
        return jsonResponse({ result: "UNAUTHORIZED", report: "缺少或错误的访问密钥（?key=xxx 或请求头 X-Worker-Key）" }, 401);
      }
    }

    if (action === "log") {
      if (!env.KV) {
        return jsonResponse({ result: "ERROR", report: "未绑定 KV 命名空间（变量名 KV），无法查询历史记录" }, 400);
      }
      let history = [];
      try {
        history = JSON.parse((await env.KV.get("signin:history")) || "[]");
      } catch (e) {
        history = [];
      }
      return jsonResponse({ result: "LOG", count: history.length, history: history });
    }

    const result = await runAction(env, action, "http:" + action);
    await saveLog(env, result.out);
    return jsonResponse(result.out, result.code === 0 ? 200 : 500);
  },
};
