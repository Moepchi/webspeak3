// Copies the AEC3 WASM module's prebuilt assets into public/vendor/ so they're
// served unhashed, at the exact filenames the module's own glue code expects
// (it resolves its .wasm next to its own <script src> by a hardcoded literal
// name - see web/src/aec3.ts). Run via predev/prebuild rather than committed,
// so the binary blobs never enter git.
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = path.join(webRoot, "node_modules/@ennuicastr/webrtcaec3.js");
const { version } = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
const outDir = path.join(webRoot, "public/vendor");

mkdirSync(outDir, { recursive: true });
// The .js is renamed to a stable name (we choose its <script src>, so nothing
// depends on this filename); the .wasm keeps its exact original name (the glue
// code's own lookup is hardcoded to it).
copyFileSync(path.join(pkgDir, "dist", `webrtcaec3-${version}.js`), path.join(outDir, "webrtcaec3.js"));
copyFileSync(path.join(pkgDir, "dist", `webrtcaec3-${version}.wasm`), path.join(outDir, `webrtcaec3-${version}.wasm`));
