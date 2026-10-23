import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFileLogger, createNoopLogger } from "../server/logger.js";

const silentConsole = { info() {}, warn() {}, error() {}, log() {}, debug() {} };

test("writes level-tagged lines to a durable file and still forwards to the console", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nyabililive-log-"));
  const forwarded = [];
  const consoleLike = { info: (...a) => forwarded.push(a), warn() {}, error() {}, log() {}, debug() {} };
  const logger = createFileLogger({ directory, console: consoleLike });

  logger.info("[danmaku] connecting room 9911");
  logger.warn("心跳或消息已静默 600 秒");
  logger.error(new Error("场次不存在"));

  const raw = fs.readFileSync(logger.path, "utf8");
  // Error stacks span several physical lines, so count tagged records instead.
  assert.equal(raw.match(/^[\d-]+T[\d:.]+Z \[info\] /gm)?.length, 1);
  assert.equal(raw.match(/^[\d-]+T[\d:.]+Z \[warn\] /gm)?.length, 1);
  assert.equal(raw.match(/^[\d-]+T[\d:.]+Z \[error\] /gm)?.length, 1);
  assert.match(raw, /\[info\] \[danmaku\] connecting room 9911/);
  assert.match(raw, /\[warn\] 心跳或消息已静默 600 秒/);
  assert.match(raw, /\[error\] Error: 场次不存在/);
  assert.equal(forwarded.length, 1);
  logger.close();
});

test("rotates the log file without dropping lines once it exceeds the configured size", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nyabililive-log-"));
  const logger = createFileLogger({ directory, maxBytes: 1500, console: silentConsole });
  const written = [];
  for (let index = 0; index < 20; index += 1) {
    const line = `第 ${index} 条足够长的日志内容，用于触发轮转`;
    written.push(line);
    logger.info(line);
  }
  logger.close();

  const current = path.join(directory, "nyabililive.log");
  const rotated = path.join(directory, "nyabililive.log.1");
  assert.equal(fs.existsSync(rotated), true, "轮转文件应存在");
  assert.equal(fs.existsSync(current), true, "当前日志文件应存在");

  // Rotation must not lose data: every line still lives in one of the two files.
  const combined = fs.readFileSync(rotated, "utf8") + fs.readFileSync(current, "utf8");
  for (const line of written) assert.ok(combined.includes(line), `轮转后丢失: ${line}`);

  // The file that triggered the rotation was capped before rolling over.
  assert.ok(fs.statSync(rotated).size <= 1500, "轮转文件应受 maxBytes 约束");
  assert.ok(fs.readFileSync(current, "utf8").includes("第 19 条"), "最新一条应留在当前文件");
});

test("noop logger reports no path and never touches the filesystem", () => {
  const logger = createNoopLogger();
  assert.equal(logger.path, "");
  logger.info("ignored");
  logger.error(new Error("ignored"));
  logger.close();
});
