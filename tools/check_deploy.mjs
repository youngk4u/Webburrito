#!/usr/bin/env node
// Runs before every Hosting deploy (firebase.json "predeploy").
// The site is served from the repo root, so any stray file in this folder would be
// published, e.g. an old copy of the project inside a Dropbox folder. This stops the
// deploy if anything would go live that isn't in git and isn't in hosting.ignore.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

function toRegex(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") { re += "(?:.*/)?"; i += 2; } else { re += ".*"; i += 1; }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

let untracked;
try {
  // Untracked files, including git-ignored ones. A nested repo shows up as "dir/".
  untracked = execFileSync("git", ["ls-files", "--others", "-z"], { encoding: "utf8", maxBuffer: 64 << 20 })
    .split("\0")
    .filter(Boolean);
} catch {
  console.error("✖ Deploy stopped: run it from a git checkout of the site (couldn't run `git ls-files`).");
  process.exit(1);
}

const ignore = JSON.parse(readFileSync("firebase.json", "utf8")).hosting.ignore.map(toRegex);
const skipped = (p) => ignore.some((re) => re.test(p) || re.test(p.replace(/\/$/, "")) || re.test(`${p}x`));
const extra = untracked.filter((p) => !skipped(p));

if (extra.length) {
  console.error("✖ Deploy stopped. These aren't in git but would be published on the website:");
  for (const p of extra.slice(0, 20)) console.error(`   ${p}${p.endsWith("/") ? "  (whole folder)" : ""}`);
  if (extra.length > 20) console.error(`   …and ${extra.length - 20} more`);
  console.error('Move them out of this folder, commit them if they belong on the site, or add them to "hosting.ignore" in firebase.json.');
  process.exit(1);
}
console.log("✔ Deploy check: only files that are in git will be published.");
