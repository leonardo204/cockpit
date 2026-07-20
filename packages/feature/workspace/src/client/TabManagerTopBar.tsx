'use client';

import { toast } from '@cockpit/shared-ui';
import { useTranslation } from 'react-i18next';
import { publishTopic } from '@cockpit/effect-react';
import { Topics } from '@cockpit/effect-services';

// ============================================
// TopBar
// ============================================

interface TabManagerTopBarProps {
  initialCwd?: string;
}

// ============================================
// TabManagerTopBar
// ============================================

export function TabManagerTopBar({ initialCwd }: TabManagerTopBarProps) {
  const { t } = useTranslation();
  return (
    <div className="border-b border-border bg-card shrink-0">
      <div className="flex items-center justify-between px-4 py-2 relative">
        {/* Left: Logo + project path */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <img
              src="/icons/icon-72x72.png"
              alt="Cockpit"
              className="w-6 h-6 cursor-pointer"
              title={t('tabManagerTopBar.copyPageUrl')}
              onClick={() => {
                navigator.clipboard.writeText(window.location.href).then(() => {
                  toast(t('toast.copiedPageUrl'), 'success');
                });
              }}
            />
            {initialCwd ? (
              <>
                <span
                  className="text-sm text-foreground max-w-md truncate cursor-help"
                  title={`CWD: ${initialCwd}`}
                >
                  {initialCwd}
                </span>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(initialCwd);
                    toast(t('toast.copiedDirPath'));
                  }}
                  className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
                  title={t('tabManagerTopBar.copyDirPath')}
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                </button>
              </>
            ) : (
              <h1 className="text-lg font-semibold text-foreground">
                Cockpit
              </h1>
            )}
          </div>
        </div>

        {/* Right: session-related */}
        <div className="flex items-center gap-2">
          {/* Reload current project */}
          <button
            onClick={() => window.location.reload()}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
            title={t('tabManagerTopBar.refreshProject')}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
          {/* Token stats */}
          <button
            onClick={() => publishTopic(Topics.OpenTokenStats, {})}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
            title={t('tabManagerTopBar.tokenStats')}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
          </button>
          {/* Surething website */}
          <button
            onClick={() => window.open('https://surething.io?from=cockpit', '_blank')}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
            title={t('tabManagerTopBar.openSurething')}
          >
            <img src="https://surething.io/logo.png?from=cockpit" alt="Surething" className="w-5 h-5 rounded-sm" />
          </button>
        </div>
      </div>
    </div>
  );
}
