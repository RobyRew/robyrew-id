// One-off: write an approved handle plan into Logto through the Management API.
//
//   LOGTO_ENDPOINT=https://auth.robyrew.com LOGTO_M2M_APP_ID=… LOGTO_M2M_APP_SECRET=… \
//     node scripts/migrate-handles.ts plan.json            # dry run: prints what would change
//     node scripts/migrate-handles.ts plan.json --apply    # writes it
//
// plan.json: { "users": [ { "id": "<logto id>", "username": "robyrew", "reserve": ["robyrew2"] } ] }
// Each user is written with one PATCH (username and customData together); Logto
// then sends User.Data.Updated to every app's webhook.
import { readFileSync } from 'node:fs'
import { createManagementClient, ManagementError } from '../src/lib/management.ts'
import { planStep, type PlanEntry } from '../src/lib/migration.ts'

const [file, flag] = process.argv.slice(2)
if (!file) {
  console.error('usage: node scripts/migrate-handles.ts plan.json [--apply]')
  process.exit(2)
}
const apply = flag === '--apply'
const plan = JSON.parse(readFileSync(file, 'utf8')) as { users: PlanEntry[] }
const env = (name: string) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}
const management = createManagementClient({
  endpoint: env('LOGTO_ENDPOINT'),
  appId: env('LOGTO_M2M_APP_ID'),
  appSecret: env('LOGTO_M2M_APP_SECRET'),
  resource: process.env.LOGTO_MANAGEMENT_RESOURCE || 'https://default.logto.app/api',
})

let failed = 0
for (const entry of plan.users) {
  const user = await management.getUser(entry.id)
  const step = planStep(user, entry)
  if (step.kind === 'unchanged') {
    console.log(`${entry.id}: unchanged (${user.username ?? 'no username'})`)
    continue
  }
  if (step.kind === 'error') {
    console.log(`${entry.id}: REFUSED — ${step.error}`)
    failed++
    continue
  }
  console.log(`${entry.id}: ${step.changes.join('; ')}${apply ? '' : ' (dry run)'}`)
  if (!apply) continue
  try {
    const after = await management.patchUser(entry.id, step.patch)
    console.log(`${entry.id}: written, username now ${after.username}`)
  } catch (err) {
    failed++
    console.log(`${entry.id}: FAILED — ${err instanceof ManagementError ? `${err.status} ${err.code}` : String(err)}`)
  }
}
process.exitCode = failed ? 1 : 0
