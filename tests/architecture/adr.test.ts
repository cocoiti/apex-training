// 設計の決定記録（docs/spec/architecture.md「設計の決定記録（ADR）」、ARC-101-1・ARC-101-3）の確認。
// 目次を作るスクリプト（ARC-101-2）はリポジトリの外にあるので、ここでは frontmatter と README・CLAUDE.md・目次のファイルを調べる。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const ADR_DIR = join(ROOT, 'docs/adr');
const STATUSES = ['accepted', 'superseded', 'withdrawn'];
const DOMAINS = ['architecture', 'input', 'modes', 'mouse', 'overview', 'pad', 'scoring', 'screens', 'weapons', 'cross'];
const START = '<!-- adr-index:start -->';
const END = '<!-- adr-index:end -->';

interface Adr {
  name: string;
  /** frontmatter の項目（なければ undefined）。 */
  meta: Record<string, string> | undefined;
  body: string;
}

/** ファイルの先頭の `---` で囲んだ部分を「項目: 値」の組にする（値の前後の引用符は除く）。 */
function parseFrontmatter(text: string): { meta: Record<string, string> | undefined; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return { meta: undefined, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: text.slice(m[0].length) };
}

function readAdrs(): Adr[] {
  return readdirSync(ADR_DIR)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .sort()
    .map((f) => ({ name: f.replace(/\.md$/, ''), ...parseFrontmatter(readFileSync(join(ADR_DIR, f), 'utf8')) }));
}

describe('frontmatter の読み取り', () => {
  it('先頭の --- で囲んだ部分を項目にし、本文と分ける', () => {
    const { meta, body } = parseFrontmatter('---\nstatus: accepted\nsummary: "a: b"\n---\n# 見出し\n');
    expect(meta).toEqual({ status: 'accepted', summary: 'a: b' });
    expect(body).toBe('# 見出し\n');
  });

  it('先頭に frontmatter がなければ項目を持たない', () => {
    expect(parseFrontmatter('# 見出し\n\n---\nstatus: accepted\n---\n').meta).toBeUndefined();
  });
});

/** ADR の frontmatter が ARC-101-1 に合わない点（ADR の名前と理由）。 */
function frontmatterProblems(adrs: Adr[]): string[] {
  const names = new Set(adrs.map((a) => a.name));
  const problems: string[] = [];
  for (const { name, meta } of adrs) {
    if (!meta) {
      problems.push(`${name}: frontmatter がない`);
      continue;
    }
    if (!STATUSES.includes(meta.status ?? '')) problems.push(`${name}: status が ${meta.status}`);
    if (!DOMAINS.includes(meta.domain ?? '')) problems.push(`${name}: domain が ${meta.domain}`);
    if (!meta.summary) problems.push(`${name}: summary が空`);
    if (meta.status === 'superseded') {
      if (!meta.superseded_by) problems.push(`${name}: superseded_by がない`);
      else if (!names.has(meta.superseded_by)) problems.push(`${name}: ${meta.superseded_by}.md がない`);
    } else if (meta.superseded_by !== undefined) {
      problems.push(`${name}: superseded でないのに superseded_by がある`);
    }
  }
  return problems;
}

describe('ARC-101-1: ADR の frontmatter', () => {
  // ファイルはテストの中で読む（-t で絞った実行や、docs/ のない写しで流すテストで、集めるときに失敗しないように）。
  it('ADR が 1 つ以上あり、どれも status・domain・summary を正しく持ち、superseded のものは docs/adr/ にある ADR を superseded_by に持つ', () => {
    const adrs = readAdrs();
    expect(adrs.length).toBeGreaterThan(0);
    expect(frontmatterProblems(adrs)).toEqual([]);
  });

  it('合わない frontmatter を見つける', () => {
    const adr = (name: string, meta?: Record<string, string>): Adr => ({ name, meta, body: '' });
    expect(
      frontmatterProblems([
        adr('a'),
        adr('b', { status: 'deprecated', domain: 'ui', summary: '' }),
        adr('c', { status: 'superseded', domain: 'pad', summary: 's' }),
        adr('d', { status: 'superseded', domain: 'pad', summary: 's', superseded_by: 'zzz' }),
        adr('e', { status: 'accepted', domain: 'cross', summary: 's', superseded_by: 'd' }),
        adr('f', { status: 'superseded', domain: 'cross', summary: 's', superseded_by: 'e' }),
      ]),
    ).toEqual([
      'a: frontmatter がない',
      'b: status が deprecated',
      'b: domain が ui',
      'b: summary が空',
      'c: superseded_by がない',
      'd: zzz.md がない',
      'e: superseded でないのに superseded_by がある',
    ]);
  });

  it('本文に「状態:」の行と「## 状態」の節を持たない', () => {
    const withState = readAdrs().filter((a) => /^(状態: |## 状態\s*$)/m.test(a.body)).map((a) => a.name);
    expect(withState).toEqual([]);
  });
});

describe('ARC-101-3: スクリプトで作る目次と読み方', () => {
  it('README に手で書いた ADR の一覧の表がなく、印の間にドメインの一覧がある', () => {
    const readme = readFileSync(join(ADR_DIR, 'README.md'), 'utf8');
    expect(readme).not.toMatch(/^\| \[\d{4}-\d{2}-\d{2}-/m);
    const start = readme.indexOf(START);
    const end = readme.indexOf(END);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const block = readme.slice(start, end);
    const active = new Set(readAdrs().filter((a) => a.meta?.status === 'accepted').map((a) => a.meta!.domain!));
    for (const domain of active) {
      expect(block).toContain(`[index/${domain}.md](index/${domain}.md)`);
      expect(existsSync(join(ADR_DIR, 'index', `${domain}.md`)), `index/${domain}.md がない`).toBe(true);
    }
    expect(block).toContain('[index/inactive.md](index/inactive.md)');
  });

  it('CLAUDE.md に、対象の領域と cross の目次だけを読むことと、ADR を足したらスクリプトで目次を作り直すことが書いてある', () => {
    const claude = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');
    expect(claude).toContain('`cross` の目次');
    expect(claude).toContain('`docs/adr/index/<ドメイン>.md`');
    expect(claude).toContain('python3 ~/dotfiles/scripts/adr-index.py');
    expect(claude).not.toContain('目次の `docs/adr/README.md` だけを読み');
  });
});
