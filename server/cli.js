import path from "node:path";
import { fileURLToPath } from "node:url";
import { ArchiveDatabase } from "./database.js";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2];

if (command !== "seed") {
  console.error("Usage: node server/cli.js seed");
  process.exitCode = 1;
} else {
  const databasePath = process.env.NYABILILIVE_DB || path.join(rootDirectory, "data", "nyabililive.db");
  const database = new ArchiveDatabase(databasePath, { seed: true });
  console.log("Database ready:", database.counts());
  database.close();
}

