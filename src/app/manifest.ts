import type { MetadataRoute } from 'next'
import { APP_DESCRIPTION, APP_NAME, APP_TITLE } from '@cockpit/shared-utils'

const ICON_SIZES = [72, 96, 128, 144, 152, 192, 384, 512]

export default function manifest(): MetadataRoute.Manifest {
  const isDev = process.env.COCKPIT_ENV === 'dev'
  const iconPath = isDev ? '/icons/dev' : '/icons'

  return {
    name: isDev ? `${APP_TITLE} (Dev)` : APP_TITLE,
    // short_name is what fits under a launcher icon — the bare product name,
    // since anything longer is truncated to uselessness.
    short_name: isDev ? `${APP_NAME} Dev` : APP_NAME,
    description: APP_DESCRIPTION,
    // Stable identity + full scope so the installed PWA captures every in-app
    // navigation (desktop workspace AND the mobile /m route).
    id: '/',
    scope: '/',
    // start_url stays '/' on purpose — it's adaptive: boot.js redirects narrow
    // viewports to /m before first paint, while desktop installs land on the
    // full workspace. Hard-coding '/m' would trap desktop PWA users in mobile UI.
    start_url: '/',
    display: 'standalone',
    background_color: '#f9f9fb',
    theme_color: '#111113',
    orientation: 'portrait-primary',
    // Chrome 139+: reuse the existing PWA window instead of opening a new Chrome tab when a matching scope link is clicked
    launch_handler: {
      client_mode: 'navigate-existing',
    },
    icons: ICON_SIZES.map((size) => ({
      src: `${iconPath}/icon-${size}x${size}.png`,
      sizes: `${size}x${size}`,
      type: 'image/png',
      purpose: 'maskable any' as 'any',
    })),
  }
}
