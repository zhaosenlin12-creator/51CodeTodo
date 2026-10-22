import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Produces candidates only. Publishing and deployment are separate operations.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const mode = args[0] && !args[0].startsWith("--") ? args.shift() : "byok";
if (!["byok", "official"].includes(mode)) throw new Error("构建类型只能是 byok 或 official");
let output;
let offline = false;
while (args.length) {
  const arg = args.shift();
  if (arg === "--offline") offline = true;
  else if (arg === "--output" && args[0] && !args[0].startsWith("--")) output = args.shift();
  else throw new Error(`不支持的参数：${arg}`);
}
const destination = resolve(root, output || `artifacts/${mode}`);
if (existsSync(destination) && readdirSync(destination).length) throw new Error("输出目录已有文件，请选择新的候选目录");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const config = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
const cargoVersion = readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8").match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const lockVersion = readFileSync(join(root, "src-tauri/Cargo.lock"), "utf8").match(/name = "pometodo-desktop"\r?\nversion = "([^"]+)"/)?.[1];
if (![config.version, cargoVersion, lockVersion].every(version => version === pkg.version)) throw new Error("版本号不一致，停止打包");

const env = { ...process.env };
delete env.POMETODO_SERVICE_EXTENSION;
delete env.POMETODO_API_BASE_URL;
delete env.CARGO_TARGET_DIR;
// Keep candidates separate from the executable the author may be using.
env.CARGO_TARGET_DIR = join(root, "artifacts", `target-${mode}`);
if (mode === "official") {
  for (const file of ["src/features/official/useServiceExtension.tsx", "src/contracts/official.ts", "src-tauri/src/official.rs"]) {
    if (!existsSync(join(root, file))) throw new Error("官网构建需要单独保存的私有账户模块；公开源码请选择默认构建");
  }
  const base = process.env.POMETODO_API_BASE_URL;
  if (!base) throw new Error("官网候选构建需明确设置官方服务地址");
  const url = new URL(base);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("官方服务地址应为不含凭据的 HTTPS 根地址");
  env.POMETODO_API_BASE_URL = url.href;
  env.POMETODO_SERVICE_EXTENSION = "src/features/official/useServiceExtension.tsx";
}
const artifactRoot = join(root, "artifacts");
mkdirSync(artifactRoot, { recursive: true });
const lockPath = join(artifactRoot, ".installer-build.lock");
const lock = openSync(lockPath, "wx");
function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: root, env, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`构建失败，退出码 ${result.status}`);
}
function sha(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
try {
  run(process.execPath, [join(root, "scripts/collect-licenses.mjs")]);
  const licenseDir = join(root, "artifacts/licenses");
  copyFileSync(join(root, "LICENSE"), join(licenseDir, "POMETODO-SOURCE-GPL-3.0.txt"));
  writeFileSync(join(licenseDir, "POMETODO-SOURCE.txt"), `PomeTodo ${pkg.version}\nPublic Windows source: https://github.com/ShiliuX-Team/pometodo\nBuild: ${mode}\n${mode === "official" ? "The official account extension is provided separately and is not included in the public source. The included GPL text describes the public source license, not an additional license grant for that extension." : "This build is made from the public GPL-3.0-only source. See the release for the corresponding source revision and build instructions."}\nThird-party notices and MPL source archives in this directory retain their respective licenses.\n`);
  const cliArgs = [join(root, "node_modules/@tauri-apps/cli/tauri.js"), "build", "--ci", "--bundles", "nsis", "--config", JSON.stringify({ bundle: { active: true, resources: { "../artifacts/licenses/": "licenses/" } } })];
  if (mode === "official") cliArgs.push("--features", "official-services");
  cliArgs.push("--", "--locked", "--no-default-features");
  if (offline) cliArgs.push("--offline");
  run(process.execPath, cliArgs);
  const bundle = join(env.CARGO_TARGET_DIR, "release/bundle/nsis");
  const productName = config.productName || "PomeTodo";
  const installers = readdirSync(bundle).filter(name => name === `${productName}_${pkg.version}_x64-setup.exe`);
  if (installers.length !== 1) throw new Error("未找到本次版本的唯一安装包");
  mkdirSync(destination, { recursive: true });
  const installerName = `${productName}-${pkg.version}-${mode}-setup.exe`;
  const installer = join(destination, installerName);
  const executable = join(destination, "pometodo-desktop.exe");
  copyFileSync(join(bundle, installers[0]), installer);
  copyFileSync(join(env.CARGO_TARGET_DIR, "release/pometodo-desktop.exe"), executable);
  const record = {
    product: "pometodo", version: pkg.version, mode,
    channel: mode === "official" ? "standalone" : "byok",
    builtAt: new Date().toISOString(), candidate: true,
    installer: installerName, sha256: sha(installer), byteLength: readFileSync(installer).length,
    executableSha256: sha(executable),
    cargoFeatures: mode === "official" ? ["official-services"] : [],
    offline, published: false, thirdPartyNoticesSha256: sha(join(licenseDir, "THIRD-PARTY-NOTICES.txt")),
  };
  writeFileSync(join(destination, "build.json"), JSON.stringify(record, null, 2) + "\n");
  console.log(`候选已生成：${destination}`);
} finally {
  closeSync(lock);
  unlinkSync(lockPath);
}
