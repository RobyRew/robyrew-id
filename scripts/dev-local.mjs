// Runs robyrew-id locally against a fake Logto (from @robyrew/astro-logto/testing):
// no real IdP, no secrets. Sign in by picking a seeded user on the fake's page.
//
//   npm run dev:local   →  http://localhost:4345  (fake Logto on http://127.0.0.1:4346)
import { spawn } from 'node:child_process';
import { startFakeLogto } from '@robyrew/astro-logto/testing';

const SITE = 'http://localhost:4345';
const HOOK_KEY = 'dev-webhook-signing-key';

const logto = await startFakeLogto({
  port: 4346,
  apps: { 'robyrew-id-dev': 'dev-app-secret' },
  m2mApps: { 'robyrew-id-m2m': 'dev-m2m-secret' },
  users: [
    { id: 'devalice0001', username: 'alice', name: 'Alice Example', primaryEmail: 'alice@example.test' },
    { id: 'devbob000002', username: 'Bob', name: 'Bob (username breaks the rule)' },
    { id: 'devcarol0003', username: null, name: 'Carol (no username yet)' },
  ],
});
logto.addHook({
  url: `${SITE}/api/hooks/logto`,
  signingKey: HOOK_KEY,
  events: ['User.Created', 'User.Data.Updated', 'User.Deleted', 'User.SuspensionStatus.Updated'],
});
console.log(`fake Logto on ${logto.endpoint}`);

const child = spawn('npx', ['astro', 'dev', '--port', '4345', '--host', 'localhost'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    PUBLIC_SITE_URL: SITE,
    LOGTO_ENDPOINT: logto.endpoint,
    LOGTO_APP_ID: 'robyrew-id-dev',
    LOGTO_APP_SECRET: 'dev-app-secret',
    LOGTO_COOKIE_SECRET: 'dev-only-session-secret-not-for-production',
    LOGTO_M2M_APP_ID: 'robyrew-id-m2m',
    LOGTO_M2M_APP_SECRET: 'dev-m2m-secret',
    LOGTO_WEBHOOK_SIGNING_KEY: HOOK_KEY,
    DATA_DIR: './data/dev',
  },
});

const stop = async () => {
  child.kill('SIGTERM');
  await logto.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', async (code) => {
  await logto.close();
  process.exit(code ?? 0);
});
