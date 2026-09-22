import { chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";

chmodSync(".githooks/pre-push", 0o755);
execFileSync("git", ["config", "core.hooksPath", ".githooks"], {
  stdio: "inherit",
});
execFileSync("git", ["config", "push.default", "current"], {
  stdio: "inherit",
});
console.log("Installed the main/master push guard. Feature PRs target dev.");
