'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFonts } from '@cockpit/shared-ui';
import {
  CHAT_SCALES,
  UI_SCALES,
  sanitizeFontFamily,
  type CodeFontPreset,
  type UiFontPreset,
} from '@cockpit/shared-utils';

/**
 * THE FONT SETTINGS — four controls, live, in the General tab.
 *
 * FLAT, like every other panel in this pane: one sentence of description, the
 * controls, a preview, a reset. No card around it (the section is already flat
 * and the pane draws the rule between sections), and no tinted box around the
 * preview — a left accent says "this is a sample, not a control" without a
 * fourth rectangle. See `settingsLayout.test.ts` for the contract.
 *
 * WHY IT IS ITS OWN FILE rather than more JSX in `SettingsModal`: the modal's
 * content pane is asserted to contain no `<label>` (a stray one is a section
 * that was missed), and these are four labelled selects. A panel file is also
 * how every other multi-control settings surface here is written.
 *
 * EVERY CHANGE APPLIES IMMEDIATELY. There is no Save button, because there is
 * nothing to preview a font in except the app itself — `useFonts().setFonts`
 * writes the CSS variables onto <html>, mirrors them into localStorage, PUTs
 * them into settings.json and broadcasts to the project iframes, all before this
 * component re-renders.
 */
export function FontSettingsPanel() {
  const { t } = useTranslation();
  const { fonts, setFonts, resetFonts } = useFonts();

  // The raw text in the two custom-family inputs.
  //
  // KEPT SEPARATE FROM THE SETTING ON PURPOSE. The stored value is sanitized on
  // every keystroke (quotes, semicolons and commas are dropped and the result is
  // trimmed), and rendering that back into the input would delete the space the
  // user just typed in the middle of "Apple SD ▍Gothic Neo". So the input shows
  // what was typed and the app uses what survived sanitising.
  const [uiDraft, setUiDraft] = useState(fonts.uiFontCustom);
  const [codeDraft, setCodeDraft] = useState(fonts.codeFontCustom);

  // …but a change from ELSEWHERE (the reset button, another frame's broadcast)
  // must still reach the inputs. Only when it disagrees with what the draft
  // sanitises to, so ordinary typing is never interrupted.
  useEffect(() => {
    setUiDraft((draft) => (sanitizeFontFamily(draft) === fonts.uiFontCustom ? draft : fonts.uiFontCustom));
  }, [fonts.uiFontCustom]);
  useEffect(() => {
    setCodeDraft((draft) => (sanitizeFontFamily(draft) === fonts.codeFontCustom ? draft : fonts.codeFontCustom));
  }, [fonts.codeFontCustom]);

  const selectClass =
    'text-xs px-2 py-1 rounded border border-border bg-background text-foreground';
  const inputClass = `${selectClass} min-w-[12rem]`;
  const labelClass = 'flex flex-col gap-0.5';
  const captionClass = 'text-[0.714rem] text-muted-foreground';

  return (
    <div className="space-y-3" data-testid="font-settings">
      <p className="text-xs text-muted-foreground">{t('fonts.description')}</p>

      <div className="flex gap-3 flex-wrap">
        <label className={labelClass}>
          <span className={captionClass}>{t('fonts.uiFont')}</span>
          <select
            data-testid="font-ui-family"
            value={fonts.uiFont}
            onChange={(e) => setFonts({ uiFont: e.target.value as UiFontPreset })}
            className={selectClass}
          >
            <option value="system">{t('fonts.preset.system')}</option>
            <option value="pretendard">{t('fonts.preset.pretendard')}</option>
            <option value="noto-sans-kr">{t('fonts.preset.notoSansKr')}</option>
            <option value="custom">{t('fonts.preset.custom')}</option>
          </select>
        </label>

        {fonts.uiFont === 'custom' ? (
          <label className={labelClass}>
            <span className={captionClass}>{t('fonts.customFamily')}</span>
            <input
              data-testid="font-ui-custom"
              value={uiDraft}
              placeholder={t('fonts.customPlaceholder')}
              onChange={(e) => {
                setUiDraft(e.target.value);
                setFonts({ uiFontCustom: e.target.value });
              }}
              className={inputClass}
            />
          </label>
        ) : null}

        <label className={labelClass}>
          <span className={captionClass}>{t('fonts.scale')}</span>
          <select
            data-testid="font-scale"
            value={fonts.scale}
            onChange={(e) => setFonts({ scale: Number(e.target.value) })}
            className={selectClass}
          >
            {UI_SCALES.map((s) => (
              <option key={s} value={s}>{`${s}%`}</option>
            ))}
          </select>
        </label>

        <label className={labelClass}>
          <span className={captionClass}>{t('fonts.chatScale')}</span>
          <select
            data-testid="font-chat-scale"
            value={fonts.chatScale}
            onChange={(e) => setFonts({ chatScale: Number(e.target.value) })}
            className={selectClass}
          >
            {CHAT_SCALES.map((s) => (
              <option key={s} value={s}>{`${s}%`}</option>
            ))}
          </select>
        </label>

        <label className={labelClass}>
          <span className={captionClass}>{t('fonts.codeFont')}</span>
          <select
            data-testid="font-code-family"
            value={fonts.codeFont}
            onChange={(e) => setFonts({ codeFont: e.target.value as CodeFontPreset })}
            className={selectClass}
          >
            <option value="system-mono">{t('fonts.mono.system')}</option>
            <option value="jetbrains-mono">{t('fonts.mono.jetbrains')}</option>
            <option value="fira-code">{t('fonts.mono.firaCode')}</option>
            <option value="custom">{t('fonts.preset.custom')}</option>
          </select>
        </label>

        {fonts.codeFont === 'custom' ? (
          <label className={labelClass}>
            <span className={captionClass}>{t('fonts.customFamily')}</span>
            <input
              data-testid="font-code-custom"
              value={codeDraft}
              placeholder={t('fonts.customPlaceholder')}
              onChange={(e) => {
                setCodeDraft(e.target.value);
                setFonts({ codeFontCustom: e.target.value });
              }}
              className={inputClass}
            />
          </label>
        ) : null}
      </div>

      <p className={captionClass}>{t('fonts.installHint')}</p>

      {/* THE PREVIEW IS THE ONLY HONEST ONE POSSIBLE: it is drawn by the same
          variables the rest of the app reads, so it cannot disagree with what
          the user is about to see. The second line carries `chat-content`, which
          is the class the message bubbles carry — it is how the chat scale can
          be judged without leaving Settings. */}
      <div className="border-l-2 border-border pl-2.5 space-y-1" data-testid="font-preview">
        <p className={captionClass}>{t('fonts.preview')}</p>
        <p className="text-sm text-foreground">
          {t('fonts.previewText')} · <code className="font-mono">{t('fonts.previewCode')}</code>
        </p>
        <p className="chat-content text-sm text-muted-foreground">{t('fonts.previewChat')}</p>
      </div>

      <button
        type="button"
        data-testid="font-reset"
        onClick={resetFonts}
        className="text-xs px-2 py-1 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
      >
        {t('fonts.reset')}
      </button>
    </div>
  );
}
