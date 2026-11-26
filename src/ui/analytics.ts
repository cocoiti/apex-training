import { onLanguageChange, t } from './i18n';
import { SCREEN_HASHES, type ScreenId } from './router';
import type { SafeStorage } from './storage';

/**
 * 画面の表示の計測（docs/spec/overview.md「画面の表示の計測」）。許可した人だけ Google Tag Manager を読み込み、
 * アプリが dataLayer に積むのは GTM の開始の 1 件と画面の表示だけにする。
 * 決定の理由は docs/adr/2026-11-26-gtm-page-views-with-consent.md。
 */

/** 同意の状態を保存するキー。設定の JSON とは別のキーにする。 */
export const ANALYTICS_CONSENT_KEY = 'apex-training:analytics-consent';

/** 同意の状態。unset は未選択。 */
export type AnalyticsConsent = 'unset' | 'granted' | 'denied';

/** 画面ごとの screen_name（docs/spec/overview.md の表）。 */
export const SCREEN_NAMES: Readonly<Record<ScreenId, string>> = {
  top: 'top',
  settings: 'settings',
  'settings-pad': 'pad-calibration',
  'settings-pad-mapping': 'pad-mapping',
  play: 'play',
  result: 'result',
  history: 'history',
  'set-result': 'set-result',
};

/** 同意の案内を出す画面（docs/spec/screens.md「計測の同意の案内」）。プレイ・リザルト・セットのまとめでは出さない。 */
export const CONSENT_SCREENS: ReadonlySet<ScreenId> = new Set<ScreenId>(['top', 'settings', 'history', 'settings-pad', 'settings-pad-mapping']);

/** 保存された同意の状態。値がない・ほかの値のときは未選択。 */
export function loadConsent(storage: Pick<SafeStorage, 'get'>): AnalyticsConsent {
  const value = storage.get(ANALYTICS_CONSENT_KEY);
  return value === 'granted' || value === 'denied' ? value : 'unset';
}

/** 画面の表示の 1 件。アプリが積む項目はこの 3 つだけ。 */
export interface PageView {
  readonly event: 'page_view';
  readonly screen_name: string;
  readonly page_path: string;
}

/** 画面の表示。page_path はベースパスと画面のハッシュで作り、URL のクエリは入れない。 */
export function pageView(screen: ScreenId, basePath: string): PageView {
  return { event: 'page_view', screen_name: SCREEN_NAMES[screen], page_path: `${basePath}${SCREEN_HASHES[screen]}` };
}

/** GTM の開始の 1 件。 */
export function gtmStart(now: number): { readonly 'gtm.start': number; readonly event: 'gtm.js' } {
  return { 'gtm.start': now, event: 'gtm.js' };
}

/** 読み込む GTM のスクリプトの URL。 */
export function gtmScriptUrl(containerId: string): string {
  return `https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(containerId)}`;
}

/** 許可の取り消しで消す Cookie の名前（_ga で始まるものと _gid）。cookie は document.cookie の文字列。 */
export function analyticsCookieNames(cookie: string): string[] {
  return cookie
    .split(';')
    .map((part) => part.split('=')[0]?.trim() ?? '')
    .filter((name) => name.startsWith('_ga') || name === '_gid');
}

/**
 * Cookie を消すときに指定するドメイン。GA は登録できる最も上のドメインに置くことがあるので、
 * 指定なし・ホスト名・親のドメイン（先頭の . の有無の両方）を返す。
 */
export function cookieDomains(hostname: string): string[] {
  // IP アドレスや localhost には親のドメインがない。
  if (hostname === '' || !hostname.includes('.') || /^\d+(?:\.\d+){3}$/.test(hostname)) return hostname === '' ? [''] : ['', hostname];
  const labels = hostname.split('.');
  const domains = [''];
  for (let i = 0; i < labels.length - 1; i += 1) {
    const domain = labels.slice(i).join('.');
    domains.push(domain, `.${domain}`);
  }
  return domains;
}

/** 計測がページに対して行うこと。ブラウザでは window と document に当てる（browserAnalyticsHost）。 */
export interface AnalyticsHost {
  /** dataLayer に 1 件積む。dataLayer がなければ作る。 */
  push(entry: object): void;
  /** スクリプトを非同期で読み込む。 */
  loadScript(url: string): void;
  /** 今の Cookie を消す（_ga で始まるものと _gid）。 */
  clearAnalyticsCookies(): void;
  /** ページを読み込み直す。 */
  reload(): void;
  /** 今の時刻（ミリ秒）。 */
  now(): number;
}

export interface AnalyticsOptions {
  /** GTM のコンテナ ID。空なら計測に関わることを何もしない。 */
  readonly containerId: string;
  readonly storage: Pick<SafeStorage, 'get' | 'set' | 'unavailable'>;
  readonly host: AnalyticsHost;
  /** ベースパス（/apex-training/ など）。page_path の先頭に付ける。 */
  readonly basePath: string;
}

/** 同意の状態と、GTM の読み込みと、画面の表示を積むこと。 */
export class Analytics {
  private state: AnalyticsConsent;
  private started = false;
  /** 今表示している画面。 */
  private screen: ScreenId | undefined;
  /** 最後に画面の表示を積んだ画面。 */
  private sent: ScreenId | undefined;
  /** ページを開いたときに保存できなかったか。保存できない環境では案内を出さない。 */
  private readonly unsaved: boolean;

  constructor(private readonly options: AnalyticsOptions) {
    this.unsaved = options.storage.unavailable;
    // 保存できない環境では、読めた値があっても未選択として扱う（毎回尋ねず、計測もしない）。
    this.state = this.enabled && !this.unsaved ? loadConsent(options.storage) : 'unset';
  }

  /** コンテナ ID があるか。ないときは案内も設定の区分も出さない。 */
  get enabled(): boolean {
    return this.options.containerId !== '';
  }

  get consent(): AnalyticsConsent {
    return this.state;
  }

  /** screen を表示したときに同意の案内を出すか。 */
  bannerVisible(screen: ScreenId): boolean {
    return this.enabled && !this.unsaved && this.state === 'unset' && CONSENT_SCREENS.has(screen);
  }

  /** 画面を表示した。許可のあいだは、表示する画面が変わったときだけ画面の表示を積む。 */
  enter(screen: ScreenId): void {
    this.screen = screen;
    if (this.state !== 'granted') return;
    this.start();
    this.send();
  }

  /** 許可にして保存し、GTM を読み込んで今の画面の画面の表示を積む。 */
  grant(): void {
    if (!this.enabled) return;
    this.state = 'granted';
    this.options.storage.set(ANALYTICS_CONSENT_KEY, 'granted');
    this.start();
    this.send();
  }

  /** 許可しないにして保存する（案内で「許可しない」を選んだ）。 */
  deny(): void {
    if (!this.enabled) return;
    this.state = 'denied';
    this.options.storage.set(ANALYTICS_CONSENT_KEY, 'denied');
  }

  /**
   * 許可を取り消す（設定画面で OFF にした）。許可しないを保存し、GA の Cookie を消してページを読み込み直す。
   * 読み込み済みの GTM は外せないので、読み込み直して止める。
   */
  revoke(): void {
    if (!this.enabled) return;
    this.deny();
    this.options.host.clearAnalyticsCookies();
    this.options.host.reload();
  }

  private start(): void {
    if (this.started || !this.enabled) return;
    this.started = true;
    this.options.host.push(gtmStart(this.options.host.now()));
    this.options.host.loadScript(gtmScriptUrl(this.options.containerId));
  }

  private send(): void {
    const screen = this.screen;
    if (screen === undefined || screen === this.sent) return;
    this.sent = screen;
    this.options.host.push(pageView(screen, this.options.basePath));
  }
}

/** ブラウザの window と document に当てる AnalyticsHost。 */
export function browserAnalyticsHost(win: Window & { dataLayer?: unknown[] }, doc: Document): AnalyticsHost {
  return {
    push: (entry) => {
      win.dataLayer = win.dataLayer ?? [];
      win.dataLayer.push(entry);
    },
    loadScript: (url) => {
      const script = doc.createElement('script');
      script.async = true;
      script.src = url;
      doc.head.append(script);
    },
    clearAnalyticsCookies: () => {
      const paths = ['/', win.location.pathname];
      for (const name of analyticsCookieNames(doc.cookie)) {
        for (const domain of cookieDomains(win.location.hostname)) {
          for (const path of paths) {
            doc.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=${path}${domain === '' ? '' : `; domain=${domain}`}`;
          }
        }
      }
    },
    reload: () => win.location.reload(),
    now: () => Date.now(),
  };
}

/** 同意の案内と設定画面の計測の区分の要素。 */
export interface AnalyticsElements {
  readonly banner: HTMLElement;
  /** 案内の文を出す要素。 */
  readonly message: HTMLElement;
  /** 計測の区分の説明を出す要素。 */
  readonly note: HTMLElement;
  readonly grant: HTMLButtonElement;
  readonly deny: HTMLButtonElement;
  /** 設定画面の計測の区分。 */
  readonly section: HTMLElement;
  /** 計測の ON/OFF の欄。 */
  readonly toggle: HTMLInputElement;
}

/** 同意の案内と計測の設定の表示を、画面を表示するたびに合わせるもの。 */
export interface AnalyticsView {
  /** 画面を表示した。案内を出すかと欄の ON/OFF を合わせ、画面の表示を積む。 */
  enter(screen: ScreenId): void;
}

/**
 * 同意の案内（docs/spec/screens.md「計測の同意の案内」）と設定画面の計測の区分（「計測の設定」）を Analytics に当てる。
 * コンテナ ID がないときは区分を隠したままにし、案内も出さない。
 */
export function bindAnalyticsView(elements: AnalyticsElements, analytics: Analytics): AnalyticsView {
  let screen: ScreenId = 'top';
  const refresh = () => {
    elements.banner.hidden = !analytics.bannerVisible(screen);
    elements.toggle.checked = analytics.consent === 'granted';
  };
  elements.section.hidden = !analytics.enabled;
  // 案内の文（docs/spec/screens.md「計測の同意の案内」）と計測の区分の説明（「計測の設定」）。表示の言語を選び直したら書き直す。
  const writeTexts = () => {
    elements.message.textContent = t('consent.message');
    elements.note.textContent = t('analytics.note');
  };
  writeTexts();
  onLanguageChange(writeTexts);
  if (analytics.enabled) {
    elements.grant.addEventListener('click', () => {
      analytics.grant();
      refresh();
    });
    elements.deny.addEventListener('click', () => {
      analytics.deny();
      refresh();
    });
    elements.toggle.addEventListener('change', () => {
      if (elements.toggle.checked) analytics.grant();
      else analytics.revoke();
      refresh();
    });
  }
  return {
    enter: (next) => {
      screen = next;
      analytics.enter(next);
      refresh();
    },
  };
}
