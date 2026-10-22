import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = resolve(root, process.argv[2] || "artifacts/licenses");
const webviewSdkSource = "https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.3650.58";
const sections = [];
const missing = [];
const supplemental = JSON.parse(readFileSync(join(root, "docs/licenses/supplemental.json"), "utf8")).records;
function licenseFiles(directory, depth = 0) {
  const found = [];
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    if (item.isFile() && /^(licen[cs]e|copying|copyright|notice|authors)([._-]|$)/i.test(item.name)) found.push(join(directory, item.name));
    if (item.isDirectory() && depth < 2 && /^(licen[cs]es?|third.party|vendor|sqlite3|zlib)$/i.test(item.name)) found.push(...licenseFiles(join(directory, item.name), depth + 1));
  }
  return found;
}
function append(name, license, directory, explicitFile, packageKey, sourceUrl) {
  const files = [...new Set([...licenseFiles(directory), ...(explicitFile && existsSync(explicitFile) ? [explicitFile] : [])])];
  const supplement = supplemental.find(record => record.packages.includes(packageKey));
  if (!files.some(file => /licen[cs]e|copying|copyright/i.test(file)) && !supplement) missing.push(name);
  const texts = files.sort().map(file => `${file.slice(directory.length + 1).replaceAll("\\", "/")}\n${readFileSync(file, "utf8").trim()}`).join("\n\n");
  const extra = supplement ? `\n${supplement.notice || ""}\n` + supplement.sources.map(source => `${source.url}${source.path ? ` (${source.path})` : ""}\n${source.text}`).join("\n\n") : "";
  sections.push(`===== ${name} (${license || "See license text"}) =====\n${sourceUrl ? `Source: ${sourceUrl}\n` : ""}${texts}${extra}`);
}

// Frontend runtime dependency tree (not the development toolchain).
const visited = new Set();
function npmPackage(directory) {
  directory = realpathSync(directory);
  if (visited.has(directory)) return;
  visited.add(directory);
  const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  append(`npm: ${pkg.name} ${pkg.version}`, pkg.license, directory, undefined, `${pkg.name}@${pkg.version}`, `https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}`);
  const require = createRequire(join(directory, "package.json"));
  for (const name of Object.keys(pkg.dependencies || {})) npmPackage(dirname(require.resolve(`${name}/package.json`)));
}
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
for (const name of Object.keys(pkg.dependencies)) npmPackage(join(root, "node_modules", name));

// Include the locked Windows Rust dependency graph, including build/test tools;
// their notices are harmless extras and avoid dropping a linked component's notice.
const result = spawnSync("cargo", ["metadata", "--manifest-path", "src-tauri/Cargo.toml", "--locked", "--offline", "--format-version", "1", "--filter-platform", "x86_64-pc-windows-msvc"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
if (result.status !== 0) throw new Error("无法读取已锁定的本机 Rust 依赖，请先准备构建依赖");
const packages = JSON.parse(result.stdout).packages.filter(entry => entry.source);
if (!packages.some(entry => entry.name === "webview2-com-sys" && entry.version === "0.38.2")) throw new Error("WebView2 版本已改变，须重新核对 SDK 许可");
mkdirSync(join(destination, "mpl-source"), { recursive: true });
for (const entry of packages) {
  const directory = dirname(entry.manifest_path);
  append(`crate: ${entry.name} ${entry.version}`, entry.license, directory, entry.license_file ? resolve(directory, entry.license_file) : undefined, `${entry.name}@${entry.version}`, `https://crates.io/api/v1/crates/${entry.name}/${entry.version}/download`);
  if (entry.license?.includes("MPL-2.0")) {
    const crateName = `${entry.name}-${entry.version}.crate`;
    const archive = join(dirname(dirname(dirname(directory))), "cache", dirname(directory).split(/[\\/]/).at(-1), crateName);
    if (!existsSync(archive)) throw new Error(`缺少 MPL 组件原始源码归档：${crateName}`);
    copyFileSync(archive, join(destination, "mpl-source", crateName));
  }
}
if (missing.length) throw new Error(`以下组件缺少本机完整许可文件，发布前需补核：${missing.join(", ")}`);
mkdirSync(destination, { recursive: true });
const sysroot = spawnSync("rustc", ["--print", "sysroot"], { encoding: "utf8", windowsHide: true }).stdout.trim();
const rustDocs = join(sysroot, "share/doc/rust");
if (!existsSync(join(rustDocs, "COPYRIGHT-library.html"))) throw new Error("缺少标准库版权资料，请安装与当前工具链匹配的 rust-docs 组件");
copyFileSync(join(rustDocs, "COPYRIGHT-library.html"), join(destination, "RUST-COPYRIGHT-library.html"));
mkdirSync(join(destination, "licenses"), { recursive: true });
for (const name of readdirSync(join(rustDocs, "licenses"))) copyFileSync(join(rustDocs, "licenses", name), join(destination, "licenses", name));
for (const name of ["WEBVIEW2-LICENSE.txt", "WEBVIEW2-NOTICE.txt"]) copyFileSync(join(root, "docs/licenses", name), join(destination, name));
writeFileSync(join(destination, "WEBVIEW2-SOURCE.txt"), `Microsoft WebView2 SDK / Loader 1.0.3650.58\nLicense and notices copied from the exact NuGet package: ${webviewSdkSource}\n`);
writeFileSync(join(destination, "THIRD-PARTY-NOTICES.txt"), "PomeTodo third-party copyright and license notices\n\nThe following notices apply to their respective third-party components. Build/test dependency notices may also be included. They do not change the license of other components. Rust standard-library notices are in RUST-COPYRIGHT-library.html. Unmodified MPL-covered crate source archives are included in mpl-source/; they are gzip-compressed tar files and retain their original licenses. Each component's source download URL is also listed below.\n\n" + sections.sort().join("\n\n") + "\n");
console.log(`Collected notices for ${sections.length} components.`);
