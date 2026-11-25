/** 保存できないときにフッターに出す文言（docs/spec/overview.md「保存」）。 */
export const STORAGE_UNAVAILABLE_MESSAGE = 'この環境では設定と記録を保存できません。練習はそのまま続けられます。';

const PROBE_KEY = 'apex-training:probe';

/**
 * 例外を投げない localStorage。プライベートウィンドウや保存の拒否で読み書きが例外になっても、呼び出し側には投げない。
 * 書いた値はページを開いている間はメモリにも持つので、保存できない環境でも同じページの中では読み返せる。
 * 起動時の試しの書き込みか保存で一度でも失敗したら「保存できない」になり、ページを開いている間は戻らない。
 */
export class SafeStorage {
  private readonly memory = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private failed = false;

  /** getStorage は localStorage を返す。window.localStorage の参照そのものが例外になる環境があるので関数で受け取る。 */
  constructor(private readonly getStorage: () => Storage) {}

  /** 保存できないと分かったか。 */
  get unavailable(): boolean {
    return this.failed;
  }

  /** 試しに書き込んで消す。保存できれば true を返す。 */
  probe(): boolean {
    return this.attempt((storage) => {
      storage.setItem(PROBE_KEY, '1');
      storage.removeItem(PROBE_KEY);
    });
  }

  /** 値を読む。このページで書いた値があればそれを返す。読み出しが例外になったら null。 */
  get(key: string): string | null {
    const written = this.memory.get(key);
    if (written !== undefined) return written;
    try {
      return this.getStorage().getItem(key);
    } catch {
      return null;
    }
  }

  /** 値を書く。localStorage に保存できたら true を返す。失敗してもページを開いている間は get で読み返せる。 */
  set(key: string, value: string): boolean {
    this.memory.set(key, value);
    return this.attempt((storage) => storage.setItem(key, value));
  }

  /** 保存できないと分かったときに 1 回呼ぶ。すでに分かっていればすぐに呼ぶ。外すための関数を返す。 */
  onUnavailable(listener: () => void): () => void {
    if (this.failed) {
      listener();
      return () => {};
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private attempt(write: (storage: Storage) => void): boolean {
    try {
      write(this.getStorage());
      return true;
    } catch {
      this.markFailed();
      return false;
    }
  }

  private markFailed(): void {
    if (this.failed) return;
    this.failed = true;
    const listeners = [...this.listeners];
    this.listeners.clear();
    for (const listener of listeners) listener();
  }
}

/** アプリの設定と自己ベストの保存先。localStorage は使うときに初めて参照する。 */
export const appStorage = new SafeStorage(() => window.localStorage);
