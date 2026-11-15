import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const out = execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" });
const files = JSON.parse(out)[0].files.map((f) => f.path);
const allowed = ["package.json", ...JSON.parse(readFileSync("package.json", "utf8")).files];
for (const file of files) {
  if (!allowed.some((path) => file === path || file.startsWith(`${path}/`))) throw new Error(`Unexpected packed file: ${file}`);
  if (/(^|\/)(\.env(?:[.-][^/]*)?|[^/]*(?:token|secret|password|private[-_.]?key)[^/]*|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.[^/]*)?)($|\/)|\.(?:key|pem|p12|pfx)$/i.test(file)) throw new Error(`Sensitive packed path: ${file}`);
}
for (const required of ["manifest.json", "dist/manifest.js", "dist/worker.js", "dist/ui/index.js", "migrations/001_init.sql", "LICENSE", "README.md", "CHANGELOG.md"]) {
  if (!files.includes(required)) throw new Error(`Packed artifact is missing ${required}`);
}
console.log(`pack:check ok (${files.length} files)`);
