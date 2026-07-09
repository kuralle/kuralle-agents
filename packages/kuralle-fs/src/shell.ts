// `@kuralle-agents/fs/shell` — the just-bash-backed virtual shell.
//
// Isolated from the root export because `just-bash`'s bundle pulls `turndown`,
// which is not workerd-clean. Import this subpath on Node (and inside a CF
// container); the root `@kuralle-agents/fs` stays Workers-clean. For a shell on
// the Cloudflare edge, use `@kuralle-agents/fs/cloudflare` (a Sandbox DO wrapper).
export { bashShell, type BashLike } from './bash-shell.js';
export { virtualShell, justBashFsToFileSystem } from './virtual-shell.js';
