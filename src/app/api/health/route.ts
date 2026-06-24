import { COCKPIT_DIR } from '@cockpit/shared-utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Liveness + identity probe used by the single-instance lock in server.mjs.
// `app` is the magic marker (distinguishes a real cockpit from any other service that
// happens to occupy the port); `home` is the data dir (confirms it's THIS data dir's
// instance, not merely some cockpit).
export async function GET() {
  return Response.json({
    app: 'cockpit',
    home: COCKPIT_DIR,
    pid: process.pid,
    port: Number(process.env.COCKPIT_PORT) || null,
    version: process.env.npm_package_version || null,
  });
}
