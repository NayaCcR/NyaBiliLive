import { z } from "zod";

const requiredText = z.string().trim().min(1);
const optionalUrl = z.union([z.url(), z.literal("")]).default("");

export const configSchema = z.object({
  app: z.object({
    site_name: requiredText,
    tagline: z.string(),
    host: requiredText,
    port: z.coerce.number().int().min(1).max(65535),
    timezone: requiredText,
  }),
  features: z.object({
    admin_room_management: z.boolean(),
    public_room_directory: z.boolean(),
  }),
  security: z.object({
    admin_username: requiredText,
    admin_password: requiredText,
    ingest_token: requiredText,
    session_secret: requiredText,
    bilibili_cookie: z.string().default(""),
    bilibili_web_refresh_token: z.string().default(""),
    bilibili_app_access_key: z.string().default(""),
    bilibili_app_refresh_token: z.string().default(""),
    bilibili_app_expires_at: z.string().default(""),
  }),
  display: z.object({
    default_min_messages: z.coerce.number().int().min(0),
    danmaku_page_size: z.coerce.number().int().min(10).max(200),
    currency: z.string().length(3),
  }),
  monitoring: z.object({
    enabled: z.boolean(),
    interval_seconds: z.coerce.number().int().min(15).max(3600),
    request_timeout_seconds: z.coerce.number().int().min(3).max(60),
    auto_update_room_profile: z.boolean(),
    danmaku_enabled: z.boolean().default(true),
    danmaku_reconcile_seconds: z.coerce.number().int().min(5).max(300).default(10),
  }).default({
    enabled: true,
    interval_seconds: 60,
    request_timeout_seconds: 10,
    auto_update_room_profile: true,
    danmaku_enabled: true,
    danmaku_reconcile_seconds: 10,
  }),
});

export const roomCreateSchema = z.object({
  room_number: requiredText.max(32),
  alias: z.string().trim().max(64).regex(/^[a-zA-Z0-9_-]*$/, "别名只能包含字母、数字、下划线和连字符").default(""),
  streamer_name: z.string().trim().max(100).default(""),
  avatar_url: optionalUrl,
  description: z.string().trim().max(500).default(""),
  enabled: z.boolean().default(true),
});

export const roomUpdateSchema = roomCreateSchema.partial();

export const sessionCreateSchema = z.object({
  title: requiredText.max(200),
  cover_url: optionalUrl,
  area: z.string().trim().max(100).default(""),
  parent_area: z.string().trim().max(100).default(""),
  started_at: z.iso.datetime().optional(),
  ended_at: z.union([z.iso.datetime(), z.literal(""), z.null()]).optional(),
  status: z.enum(["live", "ended"]).default("live"),
  peak_popularity: z.coerce.number().int().min(0).default(0),
  note: z.string().trim().max(1000).default(""),
});

export const sessionUpdateSchema = sessionCreateSchema.partial();

const eventUserSchema = z.object({
  uid: z.union([z.string(), z.number()]).transform(String),
  username: z.string().trim().min(1),
  avatar_url: optionalUrl,
  guard_level: z.coerce.number().int().min(0).default(0),
});

const baseEventSchema = z.object({
  session_id: z.coerce.number().int().positive(),
  timestamp: z.iso.datetime().optional(),
  user: eventUserSchema,
});

export const ingestEventSchema = z.discriminatedUnion("type", [
  baseEventSchema.extend({ type: z.literal("enter") }),
  baseEventSchema.extend({
    type: z.literal("danmaku"),
    content: requiredText.max(500),
    medal_name: z.string().trim().max(50).default(""),
    medal_level: z.coerce.number().int().min(0).default(0),
  }),
  baseEventSchema.extend({
    type: z.literal("gift"),
    gift_name: requiredText.max(100),
    gift_icon_url: optionalUrl,
    count: z.coerce.number().int().positive().default(1),
    unit_price: z.coerce.number().min(0).default(0),
    trade_id: z.string().trim().max(200).default(""),
  }),
]);

export const loginSchema = z.object({
  username: requiredText,
  password: requiredText,
});

export const changePasswordSchema = z.object({
  current_password: requiredText,
  new_password: z.string().min(10, "新密码至少需要 10 位").max(200),
  confirm_password: z.string(),
}).refine((value) => value.new_password === value.confirm_password, {
  message: "两次输入的新密码不一致",
  path: ["confirm_password"],
});
