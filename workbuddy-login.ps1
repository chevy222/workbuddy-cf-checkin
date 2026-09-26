#!/usr/bin/env pwsh
<#
.SYNOPSIS
    WorkBuddy 短信验证码登录工具 — 获取明文 AccessToken / RefreshToken / UID

.DESCRIPTION
    新版 WorkBuddy 桌面端的 workbuddy-desktop.info 中 accessToken / refreshToken
    已被包装加密，无法直接复制使用。本脚本通过官方插件登录接口直接获取明文凭据。

    用法:
      pwsh workbuddy-login.ps1                          # 交互式（推荐）
      pwsh workbuddy-login.ps1 -Phone 13800000000       # 指定手机号，自动发验证码
      pwsh workbuddy-login.ps1 -Phone 13800000000 -SmsCode 123456   # 手机号+验证码一步到位
      pwsh workbuddy-login.ps1 -VerifyRt                # 登录后额外验证 RT 是否可用

    输出: WORKBUDDY_TOKEN / WORKBUDDY_UID / WORKBUDDY_REFRESH_TOKEN，直接配置到 Cloudflare Worker 变量。
#>

param(
    [string]$Phone = "",
    [string]$SmsCode = "",
    [switch]$VerifyRt
)

$ErrorActionPreference = "Stop"
$BASE = "https://www.workbuddy.cn"
$REFRESH_URL = "https://copilot.tencent.com/v2/plugin/auth/token/refresh"
$UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) WorkBuddy-Login/1.0"

function Send-Sms {
    param([string]$phone)
    Write-Host "[2/4] 发送短信验证码到 $phone ..."
    $body = @{ phone = $phone } | ConvertTo-Json -Compress
    try {
        $resp = Invoke-RestMethod -Uri "$BASE/v2/plugin/login/send-sms" -Method Post `
            -ContentType "application/json" -Body $body -UserAgent $UA
        if ($resp.code -eq 0) {
            $exp = if ($resp.data) { $resp.data.expires_in } else { 300 }
            Write-Host "    ✅ 验证码已发送（有效期 $exp 秒）" -ForegroundColor Green
            return $true
        }
        Write-Host "    ❌ 发送失败: $($resp.msg)" -ForegroundColor Red
        $low = $resp.msg.ToLower()
        if ($low -match "频繁|frequent|too many") {
            Write-Host "    💡 发送过于频繁，请稍后再试" -ForegroundColor Yellow
        }
        return $false
    } catch {
        Write-Host "    ❌ 请求异常: $($_.Exception.Message)" -ForegroundColor Red
        return $false
    }
}

function Invoke-Login {
    param([string]$phone, [string]$smsCode)
    Write-Host "[3/4] 提交登录..."
    $body = @{ login_method = "phone"; phone = $phone; sms_code = $smsCode } | ConvertTo-Json -Compress
    try {
        $resp = Invoke-RestMethod -Uri "$BASE/v2/plugin/login/token" -Method Post `
            -ContentType "application/json" -Body $body -UserAgent $UA
        if ($resp.code -ne 0) {
            Write-Host "    ❌ 登录失败: $($resp.msg)" -ForegroundColor Red
            if ($resp.msg -match "验证码|code|expire") {
                Write-Host "    💡 验证码可能已过期或输入有误，请重新发送" -ForegroundColor Yellow
            }
            return $null
        }
        return $resp.data
    } catch {
        Write-Host "    ❌ 登录请求异常: $($_.Exception.Message)" -ForegroundColor Red
        return $null
    }
}

function Parse-JwtPayload {
    param([string]$token)
    $parts = $token.Split('.')
    if ($parts.Length -lt 2) { return $null }
    $payload = $parts[1].Replace('-', '+').Replace('_', '/')
    $pad = (4 - $payload.Length % 4) % 4
    $payload = $payload.PadRight($payload.Length + $pad, '=')
    try {
        return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload)) | ConvertFrom-Json
    } catch {
        return $null
    }
}

# ── 主流程 ──────────────────────────────────────────────
Write-Host ""
Write-Host "🔐 WorkBuddy 短信登录工具" -ForegroundColor Cyan
Write-Host "════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

Write-Host "[1/4] 准备登录..."
if (-not $Phone) {
    $Phone = Read-Host "    📱 请输入手机号"
}
if (-not $Phone) {
    Write-Host "❌ 手机号不能为空" -ForegroundColor Red
    exit 1
}
Write-Host "    目标: $BASE"

if (-not $SmsCode) {
    if (-not (Send-Sms $Phone)) { exit 1 }
    $SmsCode = Read-Host "    📱 请输入收到的验证码"
} else {
    Write-Host "[2/4] 使用命令行提供的验证码"
}
if (-not $SmsCode) {
    Write-Host "❌ 验证码不能为空" -ForegroundColor Red
    exit 1
}

$data = Invoke-Login $Phone $SmsCode
if (-not $data) { exit 1 }

$at = $data.accessToken
$rt = $data.refreshToken
if (-not $at -or -not $rt) {
    Write-Host "❌ 响应缺少 accessToken / refreshToken" -ForegroundColor Red
    exit 1
}

Write-Host "[4/4] 解析凭据..."
$jwt = Parse-JwtPayload $at
$uid = if ($jwt) { $jwt.sub } else { "(解析失败)" }
$nickname = if ($jwt) { $jwt.nickname } else { "?" }
$expireAt = if ($jwt -and $jwt.exp) {
    [DateTimeOffset]::FromUnixTimeSeconds($jwt.exp).LocalDateTime.ToString("yyyy-MM-dd HH:mm")
} else { "?" }

Write-Host ""
Write-Host "✅ 登录成功！" -ForegroundColor Green
Write-Host "────────────────────────────────"
Write-Host "  UID      : $uid"
Write-Host "  昵称     : $nickname"
Write-Host "  手机号   : $Phone"
Write-Host "  AT 过期  : $expireAt"
Write-Host "────────────────────────────────"
Write-Host ""

Write-Host "📋 请将以下三个值配置到 Cloudflare Worker → 设置 → 变量和机密：" -ForegroundColor Yellow
Write-Host ""
Write-Host "  WORKBUDDY_TOKEN         = $at"
Write-Host "  WORKBUDDY_UID           = $uid"
Write-Host "  WORKBUDDY_REFRESH_TOKEN = $rt"
Write-Host ""
Write-Host "（配置完成后重新部署 Worker 即可生效）" -ForegroundColor DarkGray
Write-Host ""

if ($VerifyRt) {
    Write-Host "🔄 验证刷新令牌..."
    try {
        $r = Invoke-RestMethod -Uri $REFRESH_URL -Method Post -ContentType "application/json" `
            -Headers @{ "X-Refresh-Token" = $rt; "X-Auth-Refresh-Source" = "plugin" } `
            -Body "{}" -UserAgent $UA
        if ($r.code -eq 0 -and $r.data.accessToken) {
            Write-Host "    ✅ 刷新令牌可用（已成功换发新 AT）" -ForegroundColor Green
        } else {
            Write-Host "    ⚠️ 刷新验证未通过: $($r.msg)" -ForegroundColor Yellow
        }
    } catch {
        Write-Host "    ⚠️ 刷新验证异常: $($_.Exception.Message)" -ForegroundColor Yellow
    }
    Write-Host ""
}
