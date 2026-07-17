# NyaBiliLive

一个用于整理哔哩哔哩直播场次、弹幕、进房用户、礼物和打赏排行的自托管 Web 应用。

## 功能

- 通过 `domain.com/<房间号>` 或 `domain.com/<别名>` 访问直播间归档。
- 场次选择包含封面、标题、直播状态、分区和时间。
- 场次概览支持折叠，并在浏览器本地记住显示状态。
- 按场次查看峰值人气、弹幕、观众与打赏统计。
- 礼物汇总、支持者排行和礼物流水。
- 礼物支持总览/个人送礼切换，并同时显示电池原单位与人民币折算。
- 弹幕全文、用户名、UID 搜索及分页。
- 进房用户列表，可按最低发言条数和用户信息筛选。
- 真实 UID 用户的头像可直接打开对应的 Bilibili 个人空间。
- 管理后台支持房间增改删、创建场次，以及表单/JSON 双模式配置编辑。
- 访客态轮询 Bilibili 公开房间接口，自动同步主播名称、头像、封面、标题、分区和热度。
- 检测到开播时自动创建场次，直播期间持续更新，下播后自动结束场次。
- 配置可关闭公开房间目录或后台房间管理；API 同步执行开关权限。
- 内置 Bilibili 弹幕 WebSocket 采集器，自动记录弹幕、进房、礼物和醒目留言。
- 管理后台支持 Bilibili 扫码登录或手动 Cookie 鉴权，以获取未脱敏昵称和真实 UID。
- 支持 Web Cookie refresh，以及使用公开 APPKey 的 TV/APP 扫码登录，保存约 180 天的 access key 与 refresh token。
- 带令牌的采集 API，仍可接入其他采集器或补录数据。
- SQLite WAL 模式，外键级联清理，零前端构建步骤。

## 运行

需要 Node.js 20 或更高版本，以及 pnpm。

```powershell
pnpm install
pnpm start
```

首次启动会创建 `data/nyabililive.db`，添加房间 `9213049`，附带三场明确标记的测试场次、弹幕和礼物，并自动同步真实主播名称、头像和直播状态。默认地址：

- 前台：<http://127.0.0.1:8765/naya>
- 管理后台：<http://127.0.0.1:8765/admin>
- 默认账号：`admin`
- 默认密码：`nya123nya321`

部署前必须在管理后台或 `config.json` 中更换管理员密码、采集令牌与会话签名密钥。

## 配置

`config.json` 是实际配置，`config.example.json` 是可提交的示例。后台保存配置时会先用 Zod 校验，再以两个空格缩进格式化写入。主要开关：

```json
{
  "features": {
    "admin_room_management": true,
    "public_room_directory": true
  }
}
```

房间监视器默认每 60 秒检查一次：

```json
{
  "monitoring": {
    "enabled": true,
    "interval_seconds": 60,
    "request_timeout_seconds": 10,
    "auto_update_room_profile": true,
    "danmaku_enabled": true,
    "danmaku_reconcile_seconds": 10
  }
}
```

房间基础资料使用 Bilibili 的访客态公开接口，不需要账号登录令牌。内置采集器会跟随直播中场次建立和关闭 WebSocket，并自动申请接口下发的房间握手 token；这个 token 不是账号登录令牌。

默认使用 `uid: 0` 的访客模式。Bilibili 会对未登录连接隐藏其他用户的真实 UID，并将昵称显示为 `月***` 一类的脱敏文本。可在“系统配置 / Bilibili 鉴权”中扫码登录，或粘贴包含 `SESSDATA`、`DedeUserID`、`buvid3`/`buvid4` 的完整 Cookie；采集器会自动以登录 UID 建立连接。扫码登录的有效期由 Bilibili 决定，通常比手工复制临时请求参数更持久。

即使已经登录，房间资料、开播状态、标题、封面和主播公开资料仍始终以访客状态请求，不携带 Cookie 或 APP access key。登录态只用于弹幕 WebSocket 获取未脱敏用户信息，以及凭证校验、刷新和续期。

切换 Bilibili 账号时，新扫码结果会完整替换旧账号凭证，不会合并旧 Cookie；也可在管理后台点击“清除登录凭证”，一次清空 Web/APP 凭证并立即断开旧账号的弹幕连接。

鉴权支持两条独立链路：

- Web 扫码登录：保存 Cookie 与 Web `refresh_token`，服务启动时及每 24 小时检查官方 Cookie refresh 状态，需要时执行刷新与确认。
- APP 扫码登录：使用 TV 端 `4409e2ce8ffd12b8` APPKey 签名，保存 `access_key`、APP `refresh_token`、到期时间及接口返回的 Cookie。

鉴权请求只使用 `passport.bilibili.com`、`api.bilibili.com` 和 `www.bilibili.com`，未使用仅中国大陆线路的 TV 域名，可部署在香港等海外区域。接口仍可能受到 Bilibili 的账号风控和区域策略影响。

若管理后台显示 `-352` 或人机验证，说明当前网络请求触发了 Bilibili 风控。Cookie 属于敏感凭证，只保存在本地 `config.json`，不要提交到版本库或发送给他人。本项目不会绕过 Bilibili 风控；无法使用内置连接时仍可通过下方的采集 API 写入。

可用环境变量：

- `PORT`、`HOST`：覆盖监听地址。
- `NYABILILIVE_DB`：覆盖 SQLite 路径。
- `NYABILILIVE_CONFIG`：覆盖配置文件路径。

## 采集 API

所有采集请求使用 `Authorization: Bearer <security.ingest_token>`。先在后台创建直播场次，再向 `POST /api/ingest` 写入事件。

## 安全配置

- 若 `security.ingest_token` 或 `security.session_secret` 仍是 `config.example.json` 中的占位值，服务首次启动时会分别生成 256 位随机值并写回 `config.json`。
- `config.json` 不会由静态文件服务公开；若通过 `NYABILILIVE_CONFIG` 指向 `static` 目录，服务会拒绝启动。Linux/macOS 每次保存配置后都会自动收紧为 `0600`。
- Windows 的 `chmod` 不能替代 NTFS ACL。发行部署应使用专用系统账号运行，并执行 `icacls .\config.json /inheritance:r /grant:r "${env:USERNAME}:(R,W)"`，仅让运行账号读写配置。
- 后台 Cookie 使用 `HttpOnly`、`SameSite=Strict`，HTTPS 请求会自动增加 `Secure`；后台和登录接口禁止缓存，浏览器跨来源写请求会被拒绝。
- 本机反向代理会被自动识别，以便正确处理 HTTPS 来源并签发 `Secure` Cookie。仅当可信反向代理不在本机时才设置 `NYABILILIVE_TRUST_PROXY=1`。

- 默认后台账号为 `admin`，默认密码为 `nya123nya321`。首次使用默认密码登录后必须立即修改，完成前所有 `/api/admin/*` 接口都会拒绝访问。
- `security.ingest_token` 是外部采集程序调用 `POST /api/ingest` 时使用的 Bearer Token，不是 Bilibili 凭证。
- `security.session_secret` 用于签名管理员登录 Cookie。应使用足够长的随机字符串；更换它会让现有后台登录会话全部失效。
- Bilibili Cookie、APP access key 和 refresh token 能代表登录账号，应只保存在受限的 `config.json` 中。生产部署建议使用独立低权限账号，并限制配置文件读取权限。

弹幕事件：

```json
{
  "type": "danmaku",
  "session_id": 1,
  "timestamp": "2026-07-16T12:30:00.000Z",
  "user": {
    "uid": "123456",
    "username": "观众名称",
    "avatar_url": "",
    "guard_level": 0
  },
  "content": "晚上好",
  "medal_name": "粉丝牌",
  "medal_level": 12
}
```

支持的 `type`：

- `enter`：进房记录。
- `danmaku`：弹幕并自动累计用户发言数。
- `gift`：礼物，字段包括 `gift_name`、`gift_icon_url`、`count`、`unit_price`、`trade_id`。

同一 `trade_id` 只会记录一次礼物，可用于采集端重试去重。

## 开发与验证

```powershell
pnpm run dev
pnpm run check
pnpm test
```

测试使用临时 SQLite 数据库，覆盖公开查询、用户筛选、后台鉴权、配置权限开关和采集写入。
