import { resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dir, '../../..')
process.env.AGENT_WORKER_DB_PATH ??= resolve(
  repositoryRoot,
  '.khloei/agent-worker/tasks.sqlite',
)
process.env.KHLOEI_APP_URL ??= 'http://127.0.0.1:3000'
process.env.PORT ??= '4200'

await import('./index')
