import type { Metadata, Viewport } from "next";
import { Inter, Lora, JetBrains_Mono } from "next/font/google";
import { readFileSync } from "fs";
import { join } from "path";
import "./globals.css";
import { Providers } from "@cockpit/feature-workspace";
import { APP_DESCRIPTION, APP_NAME, APP_TITLE } from "@cockpit/shared-utils";

// boot.js runs synchronously before first paint (mobile redirect + theme + SW
// cleanup). Inlined from the source file rather than referenced via
// <script src> so it executes during SSR without the React "script tag inside
// a component is never executed on the client" warning — the standard
// FOUC-prevention pattern. Read once at module load. NOTE: after editing
// public/boot.js in dev, edit/save this file so the module re-evaluates and
// re-reads the script (mtime-only touches don't bust Turbopack's cache).
let bootScript = "";
try {
  bootScript = readFileSync(join(process.cwd(), "public", "boot.js"), "utf8");
} catch {
  // Degrade gracefully: if the file can't be read (e.g. server launched from an
  // unexpected cwd), the app still renders — theme/redirect just won't pre-run —
  // instead of crashing the entire root layout.
}

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const lora = Lora({
  variable: "--font-lora",
  subsets: ["latin"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: APP_TITLE,
  description: APP_DESCRIPTION,
  // Manifest is served by app/manifest.ts at /manifest.webmanifest and linked
  // automatically by Next — don't point at a stale /manifest.json (404).
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    // Home-screen label when installed as a PWA. The bare product name, not
    // APP_TITLE: iOS truncates this hard and "(Alpha version)" would be all a
    // user sees of it.
    title: APP_NAME,
  },
  icons: {
    icon: "/icons/icon-192x192.png",
    apple: "/icons/icon-192x192.png",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f9f9fb" },
    { media: "(prefers-color-scheme: dark)", color: "#111113" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning className="overflow-hidden">
      <head>
        {/*
         * boot.js inlined (see bootScript above). Runs synchronously on initial
         * HTML parse — before first paint and hydration — to apply the theme
         * class (no FOUC), redirect narrow viewports to /m, and clean up legacy
         * Service Workers. Inlined via dangerouslySetInnerHTML (not <script src>)
         * so React does not warn that the script won't execute on client render.
         */}
        <script dangerouslySetInnerHTML={{ __html: bootScript }} />
      </head>
      <body
        className={`${inter.variable} ${lora.variable} ${jetbrainsMono.variable} antialiased overflow-hidden`}
      >
        <Providers>
          {children}
        </Providers>
      </body>
    </html>
  );
}
