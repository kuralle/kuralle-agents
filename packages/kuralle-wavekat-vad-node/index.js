// Loader for the platform-specific @napi-rs binary. Mirrors the standard
// generated layout but written by hand because we hit
// https://github.com/napi-rs/napi-rs/issues — type-def stage didn't emit
// type_def.txt for our build profile, and the auto-generated index.js was
// blank. Same end result, simpler to audit.

import { createRequire } from 'node:module';
import { platform, arch } from 'node:os';

const require = createRequire(import.meta.url);

const platformArch = `${platform()}-${arch()}`;
let binaryFile;
switch (platformArch) {
  case 'darwin-arm64':
    binaryFile = './kuralle-wavekat-vad-node.darwin-arm64.node';
    break;
  case 'darwin-x64':
    binaryFile = './kuralle-wavekat-vad-node.darwin-x64.node';
    break;
  case 'linux-x64':
    binaryFile = './kuralle-wavekat-vad-node.linux-x64-gnu.node';
    break;
  case 'linux-arm64':
    binaryFile = './kuralle-wavekat-vad-node.linux-arm64-gnu.node';
    break;
  default:
    throw new Error(`Unsupported platform: ${platformArch}`);
}

const binding = require(binaryFile);

export const Vad = binding.Vad;
export const VadBackend = binding.VadBackend;
export const WebRtcMode = binding.WebRtcMode;
export default binding;
