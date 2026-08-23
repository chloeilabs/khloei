import { resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dir, '../../..')
const dataRoot = resolve(
  process.env.KHLOEI_COMPUTER_DATA_DIR ??
    resolve(repositoryRoot, '.khloei/computer'),
)

process.env.WORKSPACE_DIR ??= resolve(dataRoot, 'workspace')
process.env.PROFILES_DIR ??= resolve(dataRoot, 'profiles')
process.env.AUDIT_DIR ??= resolve(dataRoot, 'audit')
process.env.COMPUTER_BOT_ID ??= 'khloei'

await import('./index')
