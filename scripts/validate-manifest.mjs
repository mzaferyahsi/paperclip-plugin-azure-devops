import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { pluginManifestV1Schema } = require("../node_modules/@paperclipai/shared/dist/validators/plugin.js");
const parsed = pluginManifestV1Schema.parse(JSON.parse(fs.readFileSync("manifest.json", "utf8")));
if (parsed.id !== "mzaferyahsi.azure-devops") throw new Error("Unexpected plugin id");
if (!fs.existsSync(`${parsed.database.migrationsDir}/001_init.sql`)) throw new Error("Missing 001_init.sql");
console.log(`Manifest valid against the installed Paperclip validator (${parsed.tools?.length ?? 0} tools)`);
