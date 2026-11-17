import type { Paths } from '../../openapi-common.js';
import { adminClaudePaths } from './openapi-claude.js';
import { adminDirectoryPaths } from './openapi-directory.js';
import { adminMailboxPaths } from './openapi-mailboxes.js';

/** /v1/admin 的全部路径（管理员 Key） */
export function adminPaths(): Paths {
  return { ...adminMailboxPaths(), ...adminDirectoryPaths(), ...adminClaudePaths() };
}
