import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { configSchema } from "./schemas.js";

const DEFAULT_SECRET_VALUES = {
  ingest_token: new Set([
    "replace-with-a-long-random-token",
    "dev-ingest-token-change-me",
  ]),
  session_secret: new Set([
    "replace-with-a-long-random-secret",
    "dev-session-secret-change-me",
  ]),
};

const randomSecret = () => crypto.randomBytes(32).toString("base64url");

export class ConfigStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.value = this.read();
    this.restrictPermissions();
  }

  read() {
    const source = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    const { value, changed } = this.rotateDefaultSecrets(configSchema.parse(source));
    if (changed) this.write(value);
    this.value = value;
    return this.value;
  }

  save(nextValue) {
    const { value: validated } = this.rotateDefaultSecrets(configSchema.parse(nextValue));
    this.write(validated);
    this.value = validated;
    return validated;
  }

  write(validated) {
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    if (process.platform !== "win32") fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, this.filePath);
    this.restrictPermissions();
  }

  rotateDefaultSecrets(value) {
    const security = { ...value.security };
    let changed = false;
    for (const [field, defaults] of Object.entries(DEFAULT_SECRET_VALUES)) {
      if (!defaults.has(security[field])) continue;
      security[field] = randomSecret();
      changed = true;
    }
    return { value: changed ? { ...value, security } : value, changed };
  }

  restrictPermissions() {
    if (process.platform !== "win32") fs.chmodSync(this.filePath, 0o600);
  }

  publicValue() {
    const { app, features, display, monitoring } = this.value;
    return {
      app,
      features,
      display,
      monitoring: {
        enabled: monitoring.enabled,
        interval_seconds: monitoring.interval_seconds,
        danmaku_enabled: monitoring.danmaku_enabled,
      },
    };
  }
}
