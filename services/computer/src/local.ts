import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dir, '../../..')
const dataRoot = resolve(
  process.env.KHLOEI_COMPUTER_DATA_DIR ??
    resolve(repositoryRoot, '.khloei/computer'),
)

process.env.WORKSPACE_DIR ??= resolve(dataRoot, 'workspace')
process.env.PROFILES_DIR ??= resolve(dataRoot, 'profiles')
process.env.COMPUTER_BOT_ID ??= 'khloei'

await Promise.all([
  mkdir(process.env.WORKSPACE_DIR, { recursive: true }),
  mkdir(process.env.PROFILES_DIR, { recursive: true }),
])

await import('./index')
