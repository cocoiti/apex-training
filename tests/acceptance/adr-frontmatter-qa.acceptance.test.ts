// docs/spec/architecture.md「設計の決定記録（ADR）」（#101）の受け入れテスト（QA）。ARC-101-1〜ARC-101-5 を確かめる。
// 公開された入口（docs/adr/ の ADR・README・index/、CLAUDE.md、docs/spec/architecture.md、目次を作るスクリプトのコマンド
// `python3 ~/dotfiles/scripts/adr-index.py --check`、git の履歴）だけを使う。
//
// - ARC-101-2: 目次を作るスクリプトはリポジトリの外（~/dotfiles）にあるので、ないとき（CI など）は飛ばす。
// - ARC-101-4・ARC-101-5: frontmatter を足す前の版は、#101 の前の main のコミット（BEFORE）の docs/adr/ を git から読む。
//   そのコミットが手元の履歴にないとき（浅い clone など）は飛ばす。
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const ADR_DIR = join(ROOT, 'docs/adr');
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

const STATUSES = ['accepted', 'superseded', 'withdrawn'];
const DOMAINS = ['architecture', 'input', 'modes', 'mouse', 'overview', 'pad', 'scoring', 'screens', 'weapons', 'cross'];
const START = '<!-- adr-index:start -->';
const END = '<!-- adr-index:end -->';
/** ADR の名前（ファイル名から .md を除いたもの）の形。 */
const ADR_NAME = /\d{4}-\d{2}-\d{2}-[a-z0-9-]+/g;

/** 目次を作るスクリプト（CLAUDE.md・docs/adr/README.md に書いてあるもの）。 */
const INDEX_SCRIPT = join(homedir(), 'dotfiles/scripts/adr-index.py');
const HAS_SCRIPT = existsSync(INDEX_SCRIPT) && spawnSync('python3', ['--version']).status === 0;

/** frontmatter を足す前の版（#101 の前の main のコミット）。 */
const BEFORE = 'd169acc';
const HAS_BEFORE = spawnSync('git', ['cat-file', '-e', `${BEFORE}^{commit}`], { cwd: ROOT }).status === 0;

interface Front {
  meta: Record<string, string>;
  body: string;
}

/** 先頭の `---` で囲んだ部分を「項目: 値」にする（値の前後の引用符は除く）。frontmatter がなければ undefined。 */
function parseFront(text: string): Front | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!m) return undefined;
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0 || /^\s/.test(line)) continue;
    meta[line.slice(0, i).trim()] = line
      .slice(i + 1)
      .trim()
      .replace(/^(["'])([\s\S]*)\1$/, '$2');
  }
  return { meta, body: text.slice(m[0].length) };
}

const adrFiles = () =>
  readdirSync(ADR_DIR)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .sort();

/** 空行の続きを 1 つにし、行末の空白と前後の空行を除く。 */
const normalize = (s: string) =>
  s
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

function git(args: string[]): string {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} が失敗した: ${r.stderr}`);
  return r.stdout;
}

/** BEFORE の版の docs/adr/ の ADR（README.md 以外）の名前と本文。 */
function beforeAdrs(): { file: string; text: string }[] {
  return git(['ls-tree', '--name-only', BEFORE, 'docs/adr/'])
    .split('\n')
    .filter((p) => p.endsWith('.md') && !p.endsWith('/README.md'))
    .map((p) => ({ file: p.replace(/^docs\/adr\//, ''), text: git(['show', `${BEFORE}:${p}`]) }));
}

const statusLine = (text: string) => text.split(/\r?\n/).find((l) => /^状態[:：]/.test(l));

/**
 * 前の版の状態の書き方は 2 通りある: 「状態: <値>」の行と、「## 状態」の見出しの節（中の最初の行が値）。
 * 値と、それを除いた本文を返す。状態がなければ value は undefined。
 */
function splitOldStatus(text: string): { value: string | undefined; body: string } {
  const line = statusLine(text);
  if (line !== undefined) {
    return { value: line.replace(/^状態[:：]\s*/, ''), body: text.split(/\r?\n/).filter((l) => l !== line).join('\n') };
  }
  const sec = /(^|\n)## 状態[ \t]*\n([\s\S]*?)(?=\n## |\n# |$)/.exec(text);
  if (sec) {
    const value = sec[2]!.split(/\r?\n/).find((l) => l.trim() !== '')?.trim();
    return { value, body: text.slice(0, sec.index) + sec[1] + text.slice(sec.index + sec[0].length) };
  }
  return { value: undefined, body: text };
}

describe('QA ARC-101-1: ADR の frontmatter', () => {
  const files = adrFiles();

  it('docs/adr/ に README.md 以外の ADR がある', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('README.md 以外のすべての .md が先頭に frontmatter を持ち、status・domain・summary が決まりどおり', () => {
    const problems: string[] = [];
    for (const f of files) {
      const front = parseFront(readFileSync(join(ADR_DIR, f), 'utf8'));
      if (!front) {
        problems.push(`${f}: 先頭に frontmatter がない`);
        continue;
      }
      const { status, domain, summary } = front.meta;
      if (!status || !STATUSES.includes(status)) problems.push(`${f}: status が ${String(status)}`);
      if (!domain || !DOMAINS.includes(domain)) problems.push(`${f}: domain が ${String(domain)}`);
      if (!summary || summary.trim() === '') problems.push(`${f}: summary が空`);
    }
    expect(problems).toEqual([]);
  });

  it('superseded の ADR はすべて superseded_by を持ち、その名前の ADR が docs/adr/ にある', () => {
    const problems: string[] = [];
    for (const f of files) {
      const front = parseFront(readFileSync(join(ADR_DIR, f), 'utf8'));
      if (!front || front.meta.status !== 'superseded') continue;
      const by = front.meta.superseded_by;
      if (!by) problems.push(`${f}: superseded_by がない`);
      else if (!existsSync(join(ADR_DIR, `${by}.md`))) problems.push(`${f}: superseded_by の ${by}.md が docs/adr/ にない`);
    }
    expect(problems).toEqual([]);
  });

  it('調べ方の確認: frontmatter のないファイルや引用符で囲んだ値を読み分ける', () => {
    expect(parseFront('# 見出し\n\n本文\n')).toBeUndefined();
    const f = parseFront('---\nstatus: accepted\nsummary: "a: b"\nrelated: [x, y]\n---\n# 見出し\n');
    expect(f?.meta).toEqual({ status: 'accepted', summary: 'a: b', related: '[x, y]' });
    expect(f?.body).toBe('# 見出し\n');
  });
});

describe('QA ARC-101-2: 目次を作るスクリプトの確認のモード', () => {
  const temps: string[] = [];
  afterAll(() => {
    for (const t of temps) rmSync(t, { recursive: true, force: true });
  });

  const runCheck = (cwd: string) =>
    spawnSync('python3', [INDEX_SCRIPT, '--check'], { cwd, encoding: 'utf8', timeout: 60_000 });

  it.skipIf(!HAS_SCRIPT)('リポジトリのルートで --check を実行すると終了コード 0 で、標準エラーに frontmatter がない ADR が出ない', () => {
    const r = runCheck(ROOT);
    expect(r.error).toBeUndefined();
    expect(r.status, `stdout: ${r.stdout}\nstderr: ${r.stderr}`).toBe(0);
    expect(r.stderr).not.toMatch(/frontmatter/i);
    for (const f of adrFiles()) expect(r.stderr).not.toContain(f.replace(/\.md$/, ''));
  });

  it.skipIf(!HAS_SCRIPT)('調べ方の確認: 写しで 1 つの ADR の frontmatter を消すと、--check がその ADR を標準エラーに出して 0 以外で終わる', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'qa101-'));
    temps.push(tmp);
    cpSync(ADR_DIR, join(tmp, 'docs/adr'), { recursive: true });
    const victim = adrFiles()[0]!;
    const path = join(tmp, 'docs/adr', victim);
    const front = parseFront(readFileSync(path, 'utf8'))!;
    writeFileSync(path, front.body);
    const r = runCheck(tmp);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(victim.replace(/\.md$/, ''));
  });
});

describe('QA ARC-101-3: README のドメインの一覧と CLAUDE.md の読み方', () => {
  const readme = read('docs/adr/README.md');

  it('README に adr-index:start と adr-index:end の印が 1 組あり、その間に各ドメインと置き換え済み・取り下げの目次へのリンクがある', () => {
    const s = readme.indexOf(START);
    const e = readme.indexOf(END);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(e).toBeGreaterThan(s);
    expect(readme.indexOf(START, s + 1)).toBe(-1);
    expect(readme.indexOf(END, e + 1)).toBe(-1);
    const block = readme.slice(s + START.length, e);
    const used = new Set(
      adrFiles()
        .map((f) => parseFront(readFileSync(join(ADR_DIR, f), 'utf8'))?.meta)
        .filter((m) => m?.status === 'accepted')
        .map((m) => m!.domain),
    );
    for (const d of used) {
      expect(block, `ドメイン ${d} の行`).toContain(`index/${d}.md`);
      expect(existsSync(join(ADR_DIR, 'index', `${d}.md`)), `index/${d}.md`).toBe(true);
    }
    expect(block).toContain('index/inactive.md');
    expect(existsSync(join(ADR_DIR, 'index/inactive.md'))).toBe(true);
    // ドメインの一覧で、ADR を 1 件ずつ並べていない。
    expect(block.match(ADR_NAME) ?? []).toEqual([]);
  });

  it('README に手で書いた ADR の一覧の表がない（どの表の行にも ADR の名前やファイルへのリンクがない）', () => {
    const rows = readme.split(/\r?\n/).filter((l) => /^\s*\|/.test(l));
    const listed = rows.filter((l) => (l.match(ADR_NAME) ?? []).length > 0);
    expect(listed).toEqual([]);
    const names = adrFiles().map((f) => f.replace(/\.md$/, ''));
    const outside = readme.slice(0, readme.indexOf(START)) + readme.slice(readme.indexOf(END));
    expect(names.filter((n) => outside.includes(n))).toEqual([]);
  });

  it('CLAUDE.md に、ドメインの一覧から対象の領域と cross の目次（docs/adr/index/<ドメイン>.md）だけを読むことが書いてある', () => {
    const claude = read('CLAUDE.md');
    const adrPart = claude
      .split(/\r?\n/)
      .filter((l, i, all) => /ADR|adr/.test(l) || /ADR|adr/.test(all[i - 1] ?? ''))
      .join('\n');
    expect(adrPart).toContain('docs/adr/README.md');
    expect(adrPart).toContain('ドメインの一覧');
    expect(adrPart).toMatch(/`?cross`?/);
    expect(adrPart).toContain('docs/adr/index/<ドメイン>.md');
    expect(adrPart).toMatch(/だけを読/);
  });

  it('CLAUDE.md に、ADR を足したら目次を作るスクリプトで作り直すことが書いてある', () => {
    const claude = read('CLAUDE.md');
    const line = claude.split(/\r?\n/).find((l) => l.includes('adr-index.py'));
    expect(line, 'adr-index.py を書いた行').toBeDefined();
    expect(line!).toMatch(/作り直/);
    expect(line!).toMatch(/ADR を足/);
  });
});

describe.skipIf(!HAS_BEFORE)(`QA ARC-101-4: frontmatter を足す前（${BEFORE}）と比べた本文の違い`, () => {
  it('前の版の ADR はどれも今もあり、本文の違いは frontmatter と消した「状態:」の行（移した「置き換え」の節を含む）だけ', () => {
    const problems: string[] = [];
    const before = beforeAdrs();
    expect(before.length).toBeGreaterThan(0);
    for (const { file, text } of before) {
      const path = join(ADR_DIR, file);
      if (!existsSync(path)) {
        problems.push(`${file}: 今の docs/adr/ にない`);
        continue;
      }
      const front = parseFront(readFileSync(path, 'utf8'));
      if (!front) {
        problems.push(`${file}: frontmatter がない`);
        continue;
      }
      const { value: oldStatus, body: oldBody } = splitOldStatus(text);
      let body = front.body;
      if (statusLine(body) || /(^|\n)## 状態[ \t]*\n/.test(body)) problems.push(`${file}: 本文に「状態:」の行（「## 状態」の節）が残っている`);
      // 一部が置き換わった説明を移した「置き換え」の節は、前の「状態:」の行の ADR の名前をすべて持つなら除いて比べる。
      const sec = /(^|\n)## 置き換え[^\n]*\n[\s\S]*?(?=\n## |\n# |$)/.exec(body);
      if (sec && !/(^|\n)## 置き換え/.test(oldBody)) {
        const refs = oldStatus?.match(ADR_NAME) ?? [];
        // 節に移してよいのは、前の「状態:」の行にあった置き換えの説明（状態の語のほかの部分）だけ。
        if (!oldStatus || refs.length === 0) problems.push(`${file}: 前の「状態:」の行に置き換えの説明がないのに「置き換え」の節がある`);
        for (const n of refs) if (!sec[0].includes(n)) problems.push(`${file}: 「置き換え」の節に ${n} がない`);
        body = body.slice(0, sec.index) + body.slice(sec.index + sec[0].length);
      } else if (oldStatus && /一部置き換え/.test(oldStatus)) {
        // 置き換えの説明は節に移すか summary に書く。どちらにもなければ説明が消えている。
        const refs = oldStatus.match(ADR_NAME) ?? [];
        for (const n of refs)
          if (!(front.meta.summary ?? '').includes(n)) problems.push(`${file}: 一部置き換えの ${n} の説明が節にも summary にもない`);
      }
      if (normalize(body) !== normalize(oldBody)) problems.push(`${file}: frontmatter と「状態:」の行のほかに本文が変わっている`);
    }
    expect(problems).toEqual([]);
  });
});

describe.skipIf(!HAS_BEFORE)(`QA ARC-101-5: 前の状態（${BEFORE}）と今の status`, () => {
  it('前に「置き換え済み」だった ADR は superseded、「承認」か「一部置き換え済み」だった ADR は accepted か withdrawn', () => {
    const problems: string[] = [];
    let seen = 0;
    for (const { file, text } of beforeAdrs()) {
      const { value } = splitOldStatus(text);
      const path = join(ADR_DIR, file);
      if (value === undefined) {
        problems.push(`${file}: 前の版に状態がない`);
        continue;
      }
      if (!existsSync(path)) continue;
      const status = parseFront(readFileSync(path, 'utf8'))?.meta.status;
      if (value.startsWith('一部置き換え済み') || value.startsWith('承認')) {
        seen++;
        if (status !== 'accepted' && status !== 'withdrawn') problems.push(`${file}: 前は「${value}」で今は ${String(status)}`);
      } else if (value.startsWith('置き換え済み')) {
        seen++;
        if (status !== 'superseded') problems.push(`${file}: 前は「置き換え済み」で今は ${String(status)}`);
      } else {
        problems.push(`${file}: 前の状態「${value}」を読めない`);
      }
    }
    expect(seen).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });
});

describe('QA（受け入れ条件のほか）: architecture.md の「設計の決定記録（ADR）」の小見出し', () => {
  it('置き場所・frontmatter の各項目・状態を frontmatter だけに書くこと・置き換えのやり方・スクリプトで作る目次が書いてある', () => {
    const spec = read('docs/spec/architecture.md');
    const m = /### 設計の決定記録（ADR）\n([\s\S]*?)(?=\n#{2,3} )/.exec(spec);
    expect(m, '小見出し').not.toBeNull();
    const sec = m![1]!;
    for (const word of ['docs/adr/', 'status', 'domain', 'summary', 'related', 'superseded_by', '状態:', START, END, 'index/inactive.md'])
      expect(sec, word).toContain(word);
    expect(sec).toMatch(/index\/<ドメイン>\.md/);
    expect(sec).toMatch(/新しい ADR/);
  });
});
