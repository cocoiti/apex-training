import { describe, expect, it } from 'vitest';
import {
  Analytics,
  ANALYTICS_CONSENT_KEY,
  analyticsCookieNames,
  cookieDomains,
  CONSENT_SCREENS,
  gtmScriptUrl,
  loadConsent,
  pageView,
  SCREEN_NAMES,
  type AnalyticsHost,
  type PageView,
} from '../../src/ui/analytics';
import { SCREEN_HASHES, type ScreenId } from '../../src/ui/router';
import { gtmContainerId, GTM_CONTAINER_ID } from '../../vite.config';

const BASE = '/apex-training/';
const ID = 'GTM-TEST123';

/** SafeStorage の代わり。unavailable は保存できない環境。 */
class MemoryStorage {
  readonly items = new Map<string, string>();
  constructor(readonly unavailable = false) {}
  get(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  set(key: string, value: string): boolean {
    this.items.set(key, value);
    return !this.unavailable;
  }
}

/** ページに対して行ったことを記録する AnalyticsHost。 */
class RecordingHost implements AnalyticsHost {
  readonly dataLayer: object[] = [];
  readonly scripts: string[] = [];
  cookiesCleared = 0;
  reloads = 0;
  push(entry: object): void {
    this.dataLayer.push(entry);
  }
  loadScript(url: string): void {
    this.scripts.push(url);
  }
  clearAnalyticsCookies(): void {
    this.cookiesCleared += 1;
  }
  reload(): void {
    this.reloads += 1;
  }
  now(): number {
    return 1234;
  }
}

function setup(options: { containerId?: string; saved?: string; unavailable?: boolean } = {}) {
  const storage = new MemoryStorage(options.unavailable);
  if (options.saved !== undefined) storage.items.set(ANALYTICS_CONSENT_KEY, options.saved);
  const host = new RecordingHost();
  const analytics = new Analytics({ containerId: options.containerId ?? ID, storage, host, basePath: BASE });
  return { storage, host, analytics };
}

const views = (host: RecordingHost) => host.dataLayer.filter((entry): entry is PageView => (entry as { event?: string }).event === 'page_view');

describe('コンテナ ID の設定', () => {
  it('公開するビルドのコンテナ ID は GTM-MNFCCG6N で、環境変数があればその値（空を含む）で置き換える', () => {
    expect(GTM_CONTAINER_ID).toBe('GTM-MNFCCG6N');
    expect(gtmContainerId({})).toBe('GTM-MNFCCG6N');
    expect(gtmContainerId({ APEX_GTM_CONTAINER_ID: '' })).toBe('');
    expect(gtmContainerId({ APEX_GTM_CONTAINER_ID: 'GTM-OTHER' })).toBe('GTM-OTHER');
  });

  it('読み込むのは GTM の gtm.js で、gtag.js ではない', () => {
    expect(gtmScriptUrl('GTM-MNFCCG6N')).toBe('https://www.googletagmanager.com/gtm.js?id=GTM-MNFCCG6N');
  });
});

describe('同意の状態', () => {
  it('granted と denied のほかは未選択として扱う', () => {
    const storage = new MemoryStorage();
    expect(loadConsent(storage)).toBe('unset');
    storage.items.set(ANALYTICS_CONSENT_KEY, 'granted');
    expect(loadConsent(storage)).toBe('granted');
    storage.items.set(ANALYTICS_CONSENT_KEY, 'denied');
    expect(loadConsent(storage)).toBe('denied');
    storage.items.set(ANALYTICS_CONSENT_KEY, 'yes');
    expect(loadConsent(storage)).toBe('unset');
  });
});

describe('画面の表示', () => {
  it('screen_name とハッシュは SPEC の表のとおり', () => {
    expect(SCREEN_NAMES).toEqual({
      top: 'top',
      settings: 'settings',
      'settings-pad': 'pad-calibration',
      'settings-pad-mapping': 'pad-mapping',
      play: 'play',
      result: 'result',
      history: 'history',
      'set-result': 'set-result',
    });
    expect(pageView('settings-pad', BASE)).toEqual({ event: 'page_view', screen_name: 'pad-calibration', page_path: '/apex-training/#/settings/pad' });
    expect(pageView('top', BASE)).toEqual({ event: 'page_view', screen_name: 'top', page_path: '/apex-training/#/' });
  });

  it('項目は event・screen_name・page_path の 3 つだけ', () => {
    for (const screen of Object.keys(SCREEN_HASHES) as ScreenId[]) {
      expect(Object.keys(pageView(screen, BASE)).sort()).toEqual(['event', 'page_path', 'screen_name']);
    }
  });
});

describe('許可でないあいだ', () => {
  it('OVR-21: 未選択のときは GTM を読み込まず、何も積まない', () => {
    const { host, analytics } = setup();
    analytics.enter('top');
    analytics.enter('settings');
    expect(host.scripts).toEqual([]);
    expect(host.dataLayer).toEqual([]);
    expect(analytics.bannerVisible('top')).toBe(true);
  });

  it('OVR-22: 許可しないを選ぶと保存し、画面を切り替えても読み込まず積まない', () => {
    const { storage, host, analytics } = setup();
    analytics.enter('top');
    analytics.deny();
    analytics.enter('settings');
    analytics.enter('history');
    expect(storage.items.get(ANALYTICS_CONSENT_KEY)).toBe('denied');
    expect(host.scripts).toEqual([]);
    expect(host.dataLayer).toEqual([]);
    expect(analytics.bannerVisible('top')).toBe(false);
    // 読み込み直したあとも案内を出さない。
    const reloaded = new Analytics({ containerId: ID, storage, host, basePath: BASE });
    reloaded.enter('top');
    expect(reloaded.bannerVisible('top')).toBe(false);
    expect(host.scripts).toEqual([]);
  });

  it('OVR-25: コンテナ ID が空なら案内を出さず、許可を選んでも読み込まず積まない', () => {
    const { storage, host, analytics } = setup({ containerId: '', saved: 'granted' });
    expect(analytics.enabled).toBe(false);
    analytics.enter('top');
    analytics.grant();
    expect(analytics.bannerVisible('top')).toBe(false);
    expect(host.scripts).toEqual([]);
    expect(host.dataLayer).toEqual([]);
    expect(storage.items.get(ANALYTICS_CONSENT_KEY)).toBe('granted');
  });

  it('OVR-26: 保存できない環境では、保存された値があっても案内を出さず読み込まない', () => {
    const { host, analytics } = setup({ unavailable: true, saved: 'granted' });
    analytics.enter('top');
    expect(analytics.consent).toBe('unset');
    expect(analytics.bannerVisible('top')).toBe(false);
    expect(host.scripts).toEqual([]);
    // 設定画面で許可すると、そのページのあいだだけ計測する。
    analytics.enter('settings');
    analytics.grant();
    expect(host.scripts).toEqual([gtmScriptUrl(ID)]);
    expect(views(host)).toEqual([pageView('settings', BASE)]);
  });
});

describe('同意の案内を出す画面', () => {
  it('UI-112: トップ・設定・履歴・パッドの画面で出し、プレイ・リザルト・セットのまとめでは出さない', () => {
    expect([...CONSENT_SCREENS].sort()).toEqual(['history', 'settings', 'settings-pad', 'settings-pad-mapping', 'top']);
    const { analytics } = setup();
    expect(analytics.bannerVisible('play')).toBe(false);
    expect(analytics.bannerVisible('result')).toBe(false);
    expect(analytics.bannerVisible('set-result')).toBe(false);
    expect(analytics.bannerVisible('top')).toBe(true);
  });
});

describe('許可のあいだ', () => {
  it('OVR-23: 許可すると GTM の開始を 1 件積んで gtm.js を 1 回読み込み、今の画面と、切り替えた画面の表示を積む', () => {
    const { storage, host, analytics } = setup();
    analytics.enter('top');
    analytics.grant();
    analytics.enter('top');
    analytics.enter('settings');
    analytics.enter('history');
    expect(storage.items.get(ANALYTICS_CONSENT_KEY)).toBe('granted');
    expect(host.scripts).toEqual(['https://www.googletagmanager.com/gtm.js?id=GTM-TEST123']);
    expect(host.dataLayer).toEqual([
      { 'gtm.start': 1234, event: 'gtm.js' },
      pageView('top', BASE),
      pageView('settings', BASE),
      pageView('history', BASE),
    ]);
  });

  it('許可が保存された状態で開くと、案内を出さずに最初の画面で読み込む', () => {
    const { host, analytics } = setup({ saved: 'granted' });
    expect(analytics.bannerVisible('top')).toBe(false);
    expect(host.scripts).toEqual([]);
    analytics.enter('top');
    expect(host.scripts).toHaveLength(1);
    expect(host.dataLayer).toEqual([{ 'gtm.start': 1234, event: 'gtm.js' }, pageView('top', BASE)]);
  });

  it('UI-116: 表示する画面が変わらないあいだは積まない', () => {
    const { host, analytics } = setup({ saved: 'granted' });
    analytics.enter('top');
    analytics.enter('play');
    analytics.enter('play');
    analytics.enter('result');
    expect(views(host).map((v) => v.screen_name)).toEqual(['top', 'play', 'result']);
  });

  it('UI-114: 設定画面で許可すると、設定画面の表示を 1 件積み、続けて同じ画面に入っても積まない', () => {
    const { host, analytics } = setup({ saved: 'denied' });
    analytics.enter('settings');
    analytics.grant();
    analytics.enter('settings');
    expect(views(host)).toEqual([pageView('settings', BASE)]);
    // 何度許可しても GTM は 1 回だけ読み込む。
    analytics.grant();
    expect(host.scripts).toHaveLength(1);
  });

  it('UI-115: 取り消すと許可しないを保存し、Cookie を消してページを読み込み直す', () => {
    const { storage, host, analytics } = setup({ saved: 'granted' });
    analytics.enter('settings');
    analytics.revoke();
    expect(storage.items.get(ANALYTICS_CONSENT_KEY)).toBe('denied');
    expect(host.cookiesCleared).toBe(1);
    expect(host.reloads).toBe(1);
    const reloaded = new RecordingHost();
    const after = new Analytics({ containerId: ID, storage, host: reloaded, basePath: BASE });
    after.enter('settings');
    after.enter('top');
    expect(reloaded.scripts).toEqual([]);
    expect(reloaded.dataLayer).toEqual([]);
  });
});

describe('取り消しで消す Cookie', () => {
  it('名前が _ga で始まるものと _gid だけ', () => {
    expect(analyticsCookieNames('_ga=GA1.1.1; _ga_ABC=GS1; _gid=GA1.2; other=1; x_ga=2; _gidx=3')).toEqual(['_ga', '_ga_ABC', '_gid']);
    expect(analyticsCookieNames('')).toEqual([]);
  });

  it('指定なし・ホスト名・親のドメインで消す', () => {
    expect(cookieDomains('cocoiti.github.io')).toEqual(['', 'cocoiti.github.io', '.cocoiti.github.io', 'github.io', '.github.io']);
    expect(cookieDomains('localhost')).toEqual(['', 'localhost']);
    expect(cookieDomains('127.0.0.1')).toEqual(['', '127.0.0.1']);
  });
});
