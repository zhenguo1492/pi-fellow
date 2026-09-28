/**
 * The languages Alt+right-click translates a sentence into (`voiceAgent.translateTo`):
 * twenty of the world's most spoken, by Google Translate's codes. Shared by the settings page, the
 * extension host and the webview; package.json lists the same codes.
 */

export interface TranslationLanguage {
    /** Google Translate's code, as saved in the setting. */
    code: string;
    /** In English. */
    name: string;
    /** In the language itself. */
    native: string;
}

export const TRANSLATION_LANGUAGES: readonly TranslationLanguage[] = [
    { code: 'zh-CN', name: 'Chinese (Simplified)', native: '简体中文' },
    { code: 'zh-TW', name: 'Chinese (Traditional)', native: '繁體中文' },
    { code: 'en', name: 'English', native: 'English' },
    { code: 'es', name: 'Spanish', native: 'Español' },
    { code: 'hi', name: 'Hindi', native: 'हिन्दी' },
    { code: 'ar', name: 'Arabic', native: 'العربية' },
    { code: 'bn', name: 'Bengali', native: 'বাংলা' },
    { code: 'pt', name: 'Portuguese', native: 'Português' },
    { code: 'ru', name: 'Russian', native: 'Русский' },
    { code: 'ja', name: 'Japanese', native: '日本語' },
    { code: 'de', name: 'German', native: 'Deutsch' },
    { code: 'fr', name: 'French', native: 'Français' },
    { code: 'ko', name: 'Korean', native: '한국어' },
    { code: 'it', name: 'Italian', native: 'Italiano' },
    { code: 'tr', name: 'Turkish', native: 'Türkçe' },
    { code: 'vi', name: 'Vietnamese', native: 'Tiếng Việt' },
    { code: 'id', name: 'Indonesian', native: 'Bahasa Indonesia' },
    { code: 'ur', name: 'Urdu', native: 'اردو' },
    { code: 'th', name: 'Thai', native: 'ไทย' },
    { code: 'pl', name: 'Polish', native: 'Polski' },
];

export const DEFAULT_TRANSLATION_LANGUAGE = 'zh-CN';

/** The language of `code`; an unknown code (a hand-edited setting) falls back to the default. */
export function translationLanguage(code: string | undefined): TranslationLanguage {
    return (
        TRANSLATION_LANGUAGES.find((l) => l.code === code) ?? TRANSLATION_LANGUAGES.find((l) => l.code === DEFAULT_TRANSLATION_LANGUAGE)!
    );
}
