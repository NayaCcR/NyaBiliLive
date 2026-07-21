import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import DatabaseDriver from "better-sqlite3";

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_number TEXT NOT NULL UNIQUE,
  alias TEXT UNIQUE,
  streamer_name TEXT NOT NULL,
  avatar_url TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  bili_uid TEXT,
  live_status INTEGER NOT NULL DEFAULT 0,
  last_checked_at TEXT,
  last_sync_at TEXT,
  last_sync_error TEXT NOT NULL DEFAULT '',
  room_title TEXT NOT NULL DEFAULT '',
  room_cover_url TEXT NOT NULL DEFAULT '',
  room_area TEXT NOT NULL DEFAULT '',
  room_parent_area TEXT NOT NULL DEFAULT '',
  claim_key TEXT NOT NULL DEFAULT '',
  attention INTEGER NOT NULL DEFAULT 0,
  online INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS live_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  cover_url TEXT NOT NULL DEFAULT '',
  area TEXT NOT NULL DEFAULT '',
  parent_area TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL DEFAULT 'ended' CHECK(status IN ('live', 'ended')),
  peak_popularity INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bili_uid TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL,
  avatar_url TEXT NOT NULL DEFAULT '',
  guard_level INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_users (
  session_id INTEGER NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  first_entered_at TEXT NOT NULL,
  last_entered_at TEXT NOT NULL,
  entry_count INTEGER NOT NULL DEFAULT 1,
  message_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, user_id)
);

CREATE TABLE IF NOT EXISTS danmaku (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  medal_name TEXT NOT NULL DEFAULT '',
  medal_level INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  gift_name TEXT NOT NULL,
  gift_icon_url TEXT NOT NULL DEFAULT '',
  count INTEGER NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  total_value REAL NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL,
  trade_id TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS room_user_notes (
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS room_claim_managers (
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  bili_uid TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (room_id, bili_uid)
);

CREATE INDEX IF NOT EXISTS idx_sessions_room_started ON live_sessions(room_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_danmaku_session_sent ON danmaku(session_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_gifts_session_received ON gifts(session_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_users_messages ON session_users(session_id, message_count DESC);
CREATE INDEX IF NOT EXISTS idx_room_user_notes_updated ON room_user_notes(room_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_room_claim_managers_uid ON room_claim_managers(bili_uid);
`;

const now = () => new Date().toISOString();
const randomBase36 = (length) => crypto.randomBytes(length * 2).toString("base64")
  .toLowerCase()
  .replace(/[^a-z0-9]/g, "")
  .slice(0, length)
  .padEnd(length, "0");
const normalizeUid = (value) => String(value || "").trim();
const uniqueUids = (values) => [...new Set(values.map(normalizeUid).filter(Boolean))];

export class ArchiveDatabase {
  constructor(filePath, { seed = true } = {}) {
    this.filePath = path.resolve(filePath);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.db = new DatabaseDriver(this.filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(SCHEMA);
    this.migrate();
    this.prepare();
    if (seed && this.db.prepare("SELECT COUNT(*) AS count FROM rooms").get().count === 0) {
      this.seedDemo();
    }
  }

  migrate() {
    const roomColumns = new Set(this.db.prepare("PRAGMA table_info(rooms)").all().map((column) => column.name));
    const additions = [
      ["bili_uid", "TEXT"],
      ["live_status", "INTEGER NOT NULL DEFAULT 0"],
      ["last_checked_at", "TEXT"],
      ["last_sync_at", "TEXT"],
      ["last_sync_error", "TEXT NOT NULL DEFAULT ''"],
      ["room_title", "TEXT NOT NULL DEFAULT ''"],
      ["room_cover_url", "TEXT NOT NULL DEFAULT ''"],
      ["room_area", "TEXT NOT NULL DEFAULT ''"],
      ["room_parent_area", "TEXT NOT NULL DEFAULT ''"],
      ["claim_key", "TEXT NOT NULL DEFAULT ''"],
      ["attention", "INTEGER NOT NULL DEFAULT 0"],
      ["online", "INTEGER NOT NULL DEFAULT 0"],
      ["sort_order", "INTEGER NOT NULL DEFAULT 0"],
    ];
    for (const [name, definition] of additions) {
      if (!roomColumns.has(name)) this.db.exec(`ALTER TABLE rooms ADD COLUMN ${name} ${definition}`);
    }
    const keyInUse = this.db.prepare("SELECT 1 FROM rooms WHERE claim_key = ? AND id != ?").pluck();
    const updateClaimKey = this.db.prepare("UPDATE rooms SET claim_key = ?, updated_at = ? WHERE id = ?");
    for (const row of this.db.prepare("SELECT id FROM rooms WHERE claim_key = '' OR claim_key IS NULL").all()) {
      let claimKey = "";
      do { claimKey = randomBase36(4); } while (keyInUse.get(claimKey, row.id));
      updateClaimKey.run(claimKey, now(), row.id);
    }
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_claim_key ON rooms(claim_key)");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS room_claim_managers (
        room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        bili_uid TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (room_id, bili_uid)
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_room_claim_managers_uid ON room_claim_managers(bili_uid)");
    this.db.prepare(`
      INSERT OR IGNORE INTO room_claim_managers (room_id, bili_uid, created_at)
      SELECT id, bili_uid, ? FROM rooms
      WHERE bili_uid IS NOT NULL AND bili_uid != ''
    `).run(now());
  }

  prepare() {
    this.statements = {
      roomByIdentifier: this.db.prepare("SELECT * FROM rooms WHERE (room_number = ? OR alias = ?) AND enabled = 1"),
      roomById: this.db.prepare("SELECT * FROM rooms WHERE id = ?"),
      roomClaimKeyExists: this.db.prepare("SELECT 1 FROM rooms WHERE claim_key = ?").pluck(),
      insertRoom: this.db.prepare(`
        INSERT INTO rooms (room_number, alias, streamer_name, avatar_url, description, enabled, sort_order, claim_key, created_at, updated_at)
        VALUES (@room_number, NULLIF(@alias, ''), @streamer_name, @avatar_url, @description, @enabled, @sort_order, @claim_key, @created_at, @updated_at)
      `),
      deleteRoom: this.db.prepare("DELETE FROM rooms WHERE id = ?"),
      insertSession: this.db.prepare(`
        INSERT INTO live_sessions
          (room_id, title, cover_url, area, parent_area, started_at, ended_at, status, peak_popularity, note, created_at)
        VALUES (@room_id, @title, @cover_url, @area, @parent_area, @started_at, NULLIF(@ended_at, ''), @status, @peak_popularity, @note, @created_at)
      `),
      sessionById: this.db.prepare(`
        SELECT s.*, r.room_number, r.alias, r.streamer_name
        FROM live_sessions s JOIN rooms r ON r.id = s.room_id WHERE s.id = ?
      `),
      upsertUser: this.db.prepare(`
        INSERT INTO users (bili_uid, username, avatar_url, guard_level, updated_at)
        VALUES (@uid, @username, @avatar_url, @guard_level, @updated_at)
        ON CONFLICT(bili_uid) DO UPDATE SET
          username = excluded.username,
          avatar_url = CASE WHEN excluded.avatar_url = '' THEN users.avatar_url ELSE excluded.avatar_url END,
          guard_level = excluded.guard_level,
          updated_at = excluded.updated_at
      `),
      updateUserProfile: this.db.prepare(`
        UPDATE users SET
          avatar_url = CASE WHEN @avatar_url != '' THEN @avatar_url ELSE avatar_url END,
          updated_at = @updated_at
        WHERE bili_uid = @uid
      `),
      usersMissingAvatars: this.db.prepare(`
        SELECT bili_uid AS uid, username FROM users
        WHERE avatar_url = '' AND bili_uid NOT LIKE 'guest:%'
        ORDER BY id ASC LIMIT ?
      `),
      userAvatarByUid: this.db.prepare("SELECT avatar_url FROM users WHERE bili_uid = ?"),
      userId: this.db.prepare("SELECT id FROM users WHERE bili_uid = ?"),
      sessionExists: this.db.prepare("SELECT 1 FROM live_sessions WHERE id = ?"),
      ensureSessionUser: this.db.prepare(`
        INSERT INTO session_users
          (session_id, user_id, first_entered_at, last_entered_at, entry_count, message_count)
        VALUES (@session_id, @user_id, @timestamp, @timestamp, 0, 0)
        ON CONFLICT(session_id, user_id) DO NOTHING
      `),
      recordEntry: this.db.prepare(`
        INSERT INTO session_users
          (session_id, user_id, first_entered_at, last_entered_at, entry_count, message_count)
        VALUES (@session_id, @user_id, @timestamp, @timestamp, 1, 0)
        ON CONFLICT(session_id, user_id) DO UPDATE SET
          last_entered_at = excluded.last_entered_at,
          entry_count = session_users.entry_count + 1
      `),
      insertDanmaku: this.db.prepare(`
        INSERT INTO danmaku (session_id, user_id, content, medal_name, medal_level, sent_at)
        VALUES (@session_id, @user_id, @content, @medal_name, @medal_level, @timestamp)
      `),
      incrementMessage: this.db.prepare(`
        UPDATE session_users SET message_count = message_count + 1
        WHERE session_id = @session_id AND user_id = @user_id
      `),
      insertGift: this.db.prepare(`
        INSERT INTO gifts
          (session_id, user_id, gift_name, gift_icon_url, count, unit_price, total_value, received_at, trade_id)
        VALUES (@session_id, @user_id, @gift_name, @gift_icon_url, @count, @unit_price, @total_value, @timestamp, NULLIF(@trade_id, ''))
      `),
      upsertRoomUserNote: this.db.prepare(`
        INSERT INTO room_user_notes (room_id, user_id, note, updated_at)
        VALUES (@room_id, @user_id, @note, @updated_at)
        ON CONFLICT(room_id, user_id) DO UPDATE SET
          note = excluded.note,
          updated_at = excluded.updated_at
      `),
      deleteRoomUserNote: this.db.prepare("DELETE FROM room_user_notes WHERE room_id = ? AND user_id = ?"),
      listRoomClaimManagers: this.db.prepare(`
        SELECT room_id, bili_uid, created_at
        FROM room_claim_managers
        WHERE room_id = ?
        ORDER BY CASE WHEN bili_uid = (SELECT bili_uid FROM rooms WHERE id = room_id) THEN 0 ELSE 1 END ASC, created_at ASC, bili_uid ASC
      `),
      insertRoomClaimManager: this.db.prepare(`
        INSERT INTO room_claim_managers (room_id, bili_uid, created_at)
        VALUES (@room_id, @bili_uid, @created_at)
        ON CONFLICT(room_id, bili_uid) DO NOTHING
      `),
      deleteRoomClaimManagers: this.db.prepare("DELETE FROM room_claim_managers WHERE room_id = ?"),
      claimDanmakuByRoomManager: this.db.prepare(`
        SELECT d.id, d.sent_at, d.content, u.bili_uid, u.username
        FROM danmaku d
        JOIN users u ON u.id = d.user_id
        JOIN live_sessions s ON s.id = d.session_id
        JOIN room_claim_managers m ON m.room_id = s.room_id AND m.bili_uid = u.bili_uid
        WHERE s.room_id = ? AND s.status = 'live' AND d.content = ?
        ORDER BY d.sent_at DESC, d.id DESC
        LIMIT 1
      `),
    };

    this.ingestTransaction = this.db.transaction((event) => {
      if (!this.statements.sessionExists.get(event.session_id)) throw new Error("场次不存在");
      const user = { ...event.user, updated_at: now() };
      this.statements.upsertUser.run(user);
      const userId = this.statements.userId.get(user.uid).id;
      const common = { session_id: event.session_id, user_id: userId, timestamp: event.timestamp || now() };
      if (event.type === "enter") {
        this.statements.recordEntry.run(common);
        return { type: "enter" };
      }
      this.statements.ensureSessionUser.run(common);
      if (event.type === "danmaku") {
        const result = this.statements.insertDanmaku.run({ ...common, ...event });
        this.statements.incrementMessage.run(common);
        return { id: Number(result.lastInsertRowid), type: "danmaku" };
      }
      const result = this.statements.insertGift.run({
        ...common,
        ...event,
        total_value: Math.round(event.count * event.unit_price * 100) / 100,
      });
      return { id: Number(result.lastInsertRowid), type: "gift" };
    });
  }

  close() {
    this.db.close();
  }

  counts() {
    return Object.fromEntries(["rooms", "live_sessions", "users", "session_users", "danmaku", "gifts"]
      .map((table) => [table, this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]));
  }

  listRooms({ enabledOnly = false } = {}) {
    return this.db.prepare(`
      SELECT r.*, COUNT(s.id) AS session_count, MAX(s.started_at) AS last_live_at,
        COALESCE((SELECT NULLIF(title, '') FROM live_sessions recent WHERE recent.room_id = r.id ORDER BY recent.started_at DESC LIMIT 1), r.room_title) AS current_title,
        COALESCE((SELECT NULLIF(cover_url, '') FROM live_sessions recent WHERE recent.room_id = r.id ORDER BY recent.started_at DESC LIMIT 1), r.room_cover_url) AS current_cover,
        COALESCE((SELECT NULLIF(area, '') FROM live_sessions recent WHERE recent.room_id = r.id ORDER BY recent.started_at DESC LIMIT 1), r.room_area) AS current_area,
        COALESCE((SELECT NULLIF(parent_area, '') FROM live_sessions recent WHERE recent.room_id = r.id ORDER BY recent.started_at DESC LIMIT 1), r.room_parent_area) AS current_parent_area,
        (SELECT started_at FROM live_sessions recent WHERE recent.room_id = r.id ORDER BY recent.started_at DESC LIMIT 1) AS current_started_at,
        (SELECT ended_at FROM live_sessions recent WHERE recent.room_id = r.id ORDER BY recent.started_at DESC LIMIT 1) AS current_ended_at,
        (SELECT status FROM live_sessions recent WHERE recent.room_id = r.id ORDER BY recent.started_at DESC LIMIT 1) AS current_session_status,
        (SELECT COUNT(*) FROM room_claim_managers managers WHERE managers.room_id = r.id) AS claim_manager_count
      FROM rooms r LEFT JOIN live_sessions s ON s.room_id = r.id
      ${enabledOnly ? "WHERE r.enabled = 1" : ""}
      GROUP BY r.id ORDER BY r.sort_order ASC, r.id ASC
    `).all();
  }

  getRoom(identifier) {
    return this.statements.roomByIdentifier.get(identifier, identifier) || null;
  }

  getRoomById(id) {
    return this.statements.roomById.get(id) || null;
  }

  listMonitorableRooms() {
    return this.db.prepare("SELECT * FROM rooms WHERE enabled = 1 ORDER BY id").all();
  }

  listLiveRoomsWithSessions() {
    return this.db.prepare(`
      SELECT r.*, s.id AS session_id, s.started_at AS session_started_at
      FROM rooms r
      JOIN live_sessions s ON s.id = (
        SELECT active.id FROM live_sessions active
        WHERE active.room_id = r.id AND active.status = 'live'
        ORDER BY active.started_at DESC LIMIT 1
      )
      WHERE r.enabled = 1 AND r.live_status = 1
      ORDER BY r.id
    `).all();
  }

  getActiveSessionForRoom(roomId) {
    return this.db.prepare(
      "SELECT * FROM live_sessions WHERE room_id = ? AND status = 'live' ORDER BY started_at DESC LIMIT 1",
    ).get(roomId) || null;
  }

  createRoom(input) {
    const timestamp = now();
    const nextOrder = this.db.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM rooms").get().value;
    let claimKey = "";
    do { claimKey = randomBase36(4); } while (this.statements.roomClaimKeyExists.get(claimKey));
    const result = this.statements.insertRoom.run({
      ...input,
      streamer_name: input.streamer_name || `直播间 ${input.room_number}`,
      enabled: Number(input.enabled),
      sort_order: nextOrder,
      claim_key: claimKey,
      created_at: timestamp,
      updated_at: timestamp,
    });
    return this.getRoomById(Number(result.lastInsertRowid));
  }

  updateRoom(id, input) {
    const allowed = ["room_number", "alias", "streamer_name", "avatar_url", "description", "enabled"];
    const entries = Object.entries(input).filter(([key]) => allowed.includes(key));
    if (!entries.length) return this.getRoomById(id);
    const assignments = entries.map(([key]) => `${key} = @${key}`).concat("updated_at = @updated_at");
    const values = Object.fromEntries(entries);
    if ("alias" in values) values.alias = values.alias || null;
    if ("enabled" in values) values.enabled = Number(values.enabled);
    const result = this.db.prepare(`UPDATE rooms SET ${assignments.join(", ")} WHERE id = @id`)
      .run({ ...values, updated_at: now(), id });
    return result.changes ? this.getRoomById(id) : null;
  }

  deleteRoom(id) {
    return this.statements.deleteRoom.run(id).changes > 0;
  }

  listSessions(roomId) {
    return this.db.prepare(`
      SELECT s.*,
        (SELECT COUNT(*) FROM session_users su WHERE su.session_id = s.id) AS viewer_count,
        (SELECT COUNT(*) FROM danmaku d WHERE d.session_id = s.id) AS danmaku_count,
        (SELECT COALESCE(SUM(g.total_value), 0) FROM gifts g WHERE g.session_id = s.id) AS gift_revenue
      FROM live_sessions s WHERE s.room_id = ? ORDER BY s.started_at DESC
    `).all(roomId);
  }

  getSession(id) {
    return this.statements.sessionById.get(id) || null;
  }

  createSession(roomId, input) {
    const result = this.statements.insertSession.run({
      room_id: roomId,
      ...input,
      started_at: input.started_at || now(),
      ended_at: input.ended_at || "",
      created_at: now(),
    });
    return this.getSession(Number(result.lastInsertRowid));
  }

  updateSession(id, input) {
    const allowed = ["title", "cover_url", "area", "parent_area", "started_at", "ended_at", "status", "peak_popularity", "note"];
    const entries = Object.entries(input).filter(([key]) => allowed.includes(key));
    if (!entries.length) return this.getSession(id);
    const assignments = entries.map(([key]) => `${key} = @${key}`);
    const values = Object.fromEntries(entries);
    if ("ended_at" in values) values.ended_at = values.ended_at || null;
    const result = this.db.prepare(`UPDATE live_sessions SET ${assignments.join(", ")} WHERE id = @id`)
      .run({ ...values, id });
    return result.changes ? this.getSession(id) : null;
  }

  sessionSummary(id) {
    const session = this.getSession(id);
    if (!session) return null;
    const stats = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM danmaku WHERE session_id = ?) AS danmaku_count,
        (SELECT COUNT(*) FROM session_users WHERE session_id = ?) AS viewer_count,
        (SELECT COALESCE(SUM(total_value), 0) FROM gifts WHERE session_id = ?) AS gift_revenue,
        (SELECT COALESCE(SUM(count), 0) FROM gifts WHERE session_id = ?) AS gift_count
    `).get(id, id, id, id);
    return { ...session, stats };
  }

  listDanmaku(sessionId, { query = "", limit = 50, offset = 0, order = "desc", includeNotes = false } = {}) {
    const search = query ? "AND (d.content LIKE @needle OR u.username LIKE @needle OR u.bili_uid LIKE @needle)" : "";
    const params = { sessionId, needle: `%${query}%`, limit, offset };
    const direction = order === "asc" ? "ASC" : "DESC";
    const total = this.db.prepare(`
      SELECT COUNT(*) AS count FROM danmaku d JOIN users u ON u.id = d.user_id
      WHERE d.session_id = @sessionId ${search}
    `).get(params).count;
    const items = this.db.prepare(`
      SELECT d.*, u.bili_uid, u.username, u.avatar_url, u.guard_level, COALESCE(run.note, '') AS room_note
      FROM danmaku d
      JOIN users u ON u.id = d.user_id
      JOIN live_sessions s ON s.id = d.session_id
      LEFT JOIN room_user_notes run ON run.room_id = s.room_id AND run.user_id = d.user_id
      WHERE d.session_id = @sessionId ${search}
      ORDER BY d.sent_at ${direction}, d.id ${direction} LIMIT @limit OFFSET @offset
    `).all(params).map((item) => ({ ...item, room_note: includeNotes ? item.room_note : "" }));
    return { items, total, limit, offset, order };
  }

  giftReport(sessionId, { includeNotes = false } = {}) {
    const ranking = this.db.prepare(`
      SELECT u.bili_uid, u.username, u.avatar_url, u.guard_level, COALESCE(run.note, '') AS room_note,
        SUM(g.total_value) AS total_value, SUM(g.count) AS gift_count, COUNT(g.id) AS send_count
      FROM gifts g
      JOIN users u ON u.id = g.user_id
      JOIN live_sessions s ON s.id = g.session_id
      LEFT JOIN room_user_notes run ON run.room_id = s.room_id AND run.user_id = g.user_id
      WHERE g.session_id = ?
      GROUP BY u.id ORDER BY total_value DESC, gift_count DESC
    `).all(sessionId).map((item) => ({ ...item, room_note: includeNotes ? item.room_note : "" }));
    const gifts = this.db.prepare(`
      SELECT g.gift_name, g.gift_icon_url, SUM(g.count) AS count,
        SUM(g.total_value) AS total_value, MAX(g.unit_price) AS unit_price
      FROM gifts g WHERE g.session_id = ? GROUP BY g.gift_name, g.gift_icon_url
      ORDER BY total_value DESC, count DESC
    `).all(sessionId);
    const history = this.db.prepare(`
      SELECT g.*, u.bili_uid, u.username, u.avatar_url, COALESCE(run.note, '') AS room_note FROM gifts g
      JOIN users u ON u.id = g.user_id
      JOIN live_sessions s ON s.id = g.session_id
      LEFT JOIN room_user_notes run ON run.room_id = s.room_id AND run.user_id = g.user_id
      WHERE g.session_id = ?
      ORDER BY g.received_at DESC, g.id DESC
    `).all(sessionId).map((item) => ({ ...item, room_note: includeNotes ? item.room_note : "" }));
    return { ranking, gifts, history, history_total: history.length };
  }

  listViewers(sessionId, {
    minMessages = 0,
    query = "",
    limit = 100,
    offset = 0,
    sortBy = "last_entered_at",
    order = "desc",
    includeNotes = false,
  } = {}) {
    const search = query ? "AND (u.username LIKE @needle OR u.bili_uid LIKE @needle)" : "";
    const params = { sessionId, minMessages, needle: `%${query}%`, limit, offset };
    const sortColumn = sortBy === "first_entered_at" ? "su.first_entered_at" : "su.last_entered_at";
    const direction = order === "asc" ? "ASC" : "DESC";
    const total = this.db.prepare(`
      SELECT COUNT(*) AS count FROM session_users su JOIN users u ON u.id = su.user_id
      WHERE su.session_id = @sessionId AND su.message_count >= @minMessages ${search}
    `).get(params).count;
    const items = this.db.prepare(`
      SELECT su.*, u.bili_uid, u.username, u.avatar_url, u.guard_level, COALESCE(run.note, '') AS room_note
      FROM session_users su
      JOIN users u ON u.id = su.user_id
      JOIN live_sessions s ON s.id = su.session_id
      LEFT JOIN room_user_notes run ON run.room_id = s.room_id AND run.user_id = su.user_id
      WHERE su.session_id = @sessionId AND su.message_count >= @minMessages ${search}
      ORDER BY ${sortColumn} ${direction}, su.user_id ${direction} LIMIT @limit OFFSET @offset
    `).all(params).map((item) => ({ ...item, room_note: includeNotes ? item.room_note : "" }));
    return { items, total, min_messages: minMessages, limit, offset, sort_by: sortBy, order };
  }

  saveRoomUserNote(roomId, biliUid, note) {
    const room = this.getRoomById(Number(roomId));
    if (!room) return null;
    const user = this.statements.userId.get(String(biliUid));
    if (!user) return null;
    const normalizedNote = String(note || "").trim();
    const updatedAt = now();
    if (normalizedNote) {
      this.statements.upsertRoomUserNote.run({
        room_id: Number(roomId),
        user_id: user.id,
        note: normalizedNote,
        updated_at: updatedAt,
      });
    } else {
      this.statements.deleteRoomUserNote.run(Number(roomId), user.id);
    }
    return {
      room_id: Number(roomId),
      bili_uid: String(biliUid),
      note: normalizedNote,
      updated_at: updatedAt,
    };
  }

  ingest(event) {
    return this.ingestTransaction(event);
  }

  listRoomClaimManagers(roomId) {
    return this.statements.listRoomClaimManagers.all(Number(roomId))
      .map((item) => ({ room_id: Number(item.room_id), bili_uid: String(item.bili_uid), created_at: item.created_at }));
  }

  ensureRoomClaimManager(roomId, biliUid) {
    const normalizedUid = normalizeUid(biliUid);
    if (!normalizedUid) return false;
    this.statements.insertRoomClaimManager.run({
      room_id: Number(roomId),
      bili_uid: normalizedUid,
      created_at: now(),
    });
    return true;
  }

  replaceRoomClaimManagers(roomId, uids) {
    const room = this.getRoomById(Number(roomId));
    if (!room) return null;
    const nextUids = uniqueUids([room.bili_uid, ...(Array.isArray(uids) ? uids : [])]);
    const apply = this.db.transaction(() => {
      this.statements.deleteRoomClaimManagers.run(Number(roomId));
      const createdAt = now();
      nextUids.forEach((biliUid) => this.statements.insertRoomClaimManager.run({
        room_id: Number(roomId),
        bili_uid: biliUid,
        created_at: createdAt,
      }));
      return this.listRoomClaimManagers(roomId);
    });
    return apply();
  }

  findActiveClaimDanmaku(roomId, claimCode) {
    return this.statements.claimDanmakuByRoomManager.get(Number(roomId), String(claimCode)) || null;
  }

  updateUserProfile({ uid, avatar_url = "" }) {
    return this.statements.updateUserProfile.run({
      uid: String(uid),
      avatar_url: String(avatar_url || ""),
      updated_at: now(),
    }).changes > 0;
  }

  listUsersMissingAvatars(limit = 5000) {
    return this.statements.usersMissingAvatars.all(Math.max(1, Math.min(Number(limit) || 5000, 5000)));
  }

  userHasAvatar(uid) {
    return Boolean(this.statements.userAvatarByUid.get(String(uid))?.avatar_url);
  }

  recordRoomSyncError(roomId, message) {
    this.db.prepare(`
      UPDATE rooms SET last_checked_at = ?, last_sync_error = ?, updated_at = ? WHERE id = ?
    `).run(now(), String(message).slice(0, 500), now(), roomId);
    return this.getRoomById(roomId);
  }

  applyRoomSnapshot(roomId, snapshot, { updateProfile = true } = {}) {
    const apply = this.db.transaction(() => {
      const room = this.getRoomById(roomId);
      if (!room) throw new Error("房间不存在");
      const timestamp = now();
      this.db.prepare(`
        UPDATE rooms SET
          room_number = @room_number,
          streamer_name = CASE WHEN @update_profile = 1 AND @streamer_name != '' THEN @streamer_name ELSE streamer_name END,
          avatar_url = CASE WHEN @update_profile = 1 AND @avatar_url != '' THEN @avatar_url ELSE avatar_url END,
          bili_uid = @bili_uid,
          live_status = @live_status,
          last_checked_at = @timestamp,
          last_sync_at = @timestamp,
          last_sync_error = '',
          room_title = @title,
          room_cover_url = @cover_url,
          room_area = @area,
          room_parent_area = @parent_area,
          attention = @attention,
          online = @online,
          updated_at = @timestamp
        WHERE id = @room_id
      `).run({
        room_id: roomId,
        room_number: String(snapshot.room_number || room.room_number),
        streamer_name: snapshot.streamer_name || "",
        avatar_url: snapshot.avatar_url || "",
        bili_uid: snapshot.bili_uid ? String(snapshot.bili_uid) : null,
        live_status: Number(snapshot.live_status || 0),
        title: snapshot.title || "",
        cover_url: snapshot.cover_url || "",
        area: snapshot.area || "",
        parent_area: snapshot.parent_area || "",
        attention: Number(snapshot.attention || 0),
        online: Number(snapshot.online || 0),
        update_profile: Number(updateProfile),
        timestamp,
      });
      if (snapshot.bili_uid) this.ensureRoomClaimManager(roomId, snapshot.bili_uid);

      const activeSession = this.db.prepare(
        "SELECT * FROM live_sessions WHERE room_id = ? AND status = 'live' ORDER BY started_at DESC LIMIT 1",
      ).get(roomId);
      let session = activeSession || null;
      if (snapshot.live_status === 1) {
        const sessionData = {
          title: snapshot.title || "未命名直播",
          cover_url: snapshot.cover_url || "",
          area: snapshot.area || "",
          parent_area: snapshot.parent_area || "",
          status: "live",
          peak_popularity: Math.max(Number(activeSession?.peak_popularity || 0), Number(snapshot.online || 0)),
          note: activeSession?.note || "由 Bilibili 房间监视器自动创建",
        };
        session = activeSession
          ? this.updateSession(activeSession.id, sessionData)
          : this.createSession(roomId, {
              ...sessionData,
              started_at: snapshot.live_time || timestamp,
              ended_at: "",
            });
      } else if (activeSession) {
        session = this.updateSession(activeSession.id, { status: "ended", ended_at: timestamp });
      }
      return { room: this.getRoomById(roomId), session, snapshot };
    });
    return apply();
  }

  seedDemo() {
    const add = this.db.transaction(() => {
      const room = this.createRoom({
        room_number: "9213049",
        alias: "naya",
        streamer_name: "",
        avatar_url: "",
        description: "柳柳的直播间",
        enabled: true,
      });
      const current = Date.now();
      const sessions = [
        this.createSession(room.id, {
          title: "测试场次 01 · 夏夜歌回", cover_url: "", area: "视频唱见", parent_area: "娱乐",
          started_at: new Date(current - 166 * 60_000).toISOString(),
          ended_at: new Date(current - 60 * 60_000).toISOString(), status: "ended",
          peak_popularity: 12840, note: "初始化生成的测试场次，可在管理后台删除。",
        }),
        this.createSession(room.id, {
          title: "测试场次 02 · 独立游戏试玩", cover_url: "", area: "单机游戏", parent_area: "游戏",
          started_at: new Date(current - 3 * 86_400_000 - 3 * 3_600_000).toISOString(),
          ended_at: new Date(current - 3 * 86_400_000).toISOString(), status: "ended",
          peak_popularity: 9620, note: "",
        }),
        this.createSession(room.id, {
          title: "测试场次 03 · 周末电台", cover_url: "", area: "电台", parent_area: "娱乐",
          started_at: new Date(current - 8 * 86_400_000 - 2 * 3_600_000).toISOString(),
          ended_at: new Date(current - 8 * 86_400_000).toISOString(), status: "ended",
          peak_popularity: 7350, note: "",
        }),
      ];
      const users = [
        ["103824", "云朵收集员", 3], ["284913", "白桃汽水", 0], ["568231", "凌晨三点半", 2],
        ["791024", "今天也要早睡", 0], ["992781", "月见团子", 1], ["120584", "北纬三十度", 0],
        ["478520", "向海边走", 0], ["857201", "深蓝色耳机", 0],
      ];
      const messages = [
        "晚上好，刚好赶上开场！", "这首歌前奏一响就喜欢了", "今天的声音状态好好", "弹幕签到",
        "耳机党已经准备好了", "这个转音绝了", "好听好听", "可以再唱一遍吗", "刚从首页点进来",
        "今晚的歌单很适合夏天", "谢谢你的直播", "下一首会是什么", "这个背景好漂亮", "已经加入循环列表",
        "晚风真的吹进来了", "前排合影",
      ];
      sessions.forEach((session, sessionIndex) => {
        users.forEach(([uid, username, guardLevel], userIndex) => {
          const user = { uid, username, guard_level: guardLevel, avatar_url: "" };
          this.ingest({ type: "enter", session_id: session.id, user,
            timestamp: new Date(current - (156 - userIndex * 7 + sessionIndex * 4000) * 60_000).toISOString() });
          const messageTotal = Math.max(1, 7 - userIndex - sessionIndex);
          for (let messageIndex = 0; messageIndex < messageTotal; messageIndex += 1) {
            this.ingest({ type: "danmaku", session_id: session.id, user,
              timestamp: new Date(current - (140 - userIndex * 6 - messageIndex * 3 + sessionIndex * 4000) * 60_000).toISOString(),
              content: messages[(userIndex * 2 + messageIndex + sessionIndex) % messages.length],
              medal_name: userIndex < 5 ? "Nya团" : "", medal_level: userIndex < 5 ? 18 - userIndex * 2 : 0 });
          }
        });
        [[0, "醒目留言", 1, 50], [2, "小花花", 12, 1], [4, "打call", 5, 6], [1, "牛哇牛哇", 3, 5]]
          .forEach(([userIndex, giftName, count, unitPrice], giftIndex) => {
            const [uid, username, guardLevel] = users[userIndex];
            this.ingest({ type: "gift", session_id: session.id,
              user: { uid, username, guard_level: guardLevel, avatar_url: "" }, gift_name: giftName,
              gift_icon_url: "", count, unit_price: unitPrice, trade_id: `demo-${session.id}-${giftIndex}`,
              timestamp: new Date(current - (110 - giftIndex * 13 + sessionIndex * 4000) * 60_000).toISOString() });
          });
      });
    });
    add();
  }

  moveRoom(id, direction) {
    const move = this.db.transaction(() => {
      const rooms = this.db.prepare("SELECT id FROM rooms ORDER BY sort_order ASC, id ASC").all();
      const index = rooms.findIndex((room) => room.id === id);
      if (index < 0) return null;
      const target = direction === "up" ? index - 1 : index + 1;
      if (target < 0 || target >= rooms.length) return this.getRoomById(id);
      [rooms[index], rooms[target]] = [rooms[target], rooms[index]];
      const update = this.db.prepare("UPDATE rooms SET sort_order = ?, updated_at = ? WHERE id = ?");
      const timestamp = now();
      rooms.forEach((room, position) => update.run(position, timestamp, room.id));
      return this.getRoomById(id);
    });
    return move();
  }

}
