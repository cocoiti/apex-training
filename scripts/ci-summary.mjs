// CI のまとめのジョブで、待ったジョブの結果をまとめる（docs/spec/architecture.md「継続的インテグレーション（CI）」、ARC-57・ARC-97-4）。
// 環境変数 NEEDS に GitHub Actions の `toJSON(needs)`（ジョブ名ごとの { result }）を、引数に待つジョブの名前を渡す。
// 引数のどのジョブも結果が success のときだけ 0 で終わり、1 つでも success でない（failure・cancelled・skipped・結果がない）ときは
// そのジョブと結果を示して 1 で終わる。NEEDS を読めないときも 1 で終わる。
//   例: NEEDS='{"check":{"result":"success"},"browser":{"result":"failure"}}' node scripts/ci-summary.mjs check browser
const names = process.argv.slice(2);

/** @returns {Record<string, { result?: unknown }>} */
function readNeeds() {
  try {
    const needs = JSON.parse(process.env.NEEDS ?? '');
    if (needs && typeof needs === 'object' && !Array.isArray(needs)) return needs;
  } catch {
    // 下で失敗にする
  }
  console.error(`環境変数 NEEDS が、ジョブ名ごとの結果の JSON（toJSON(needs)）でない: ${JSON.stringify(process.env.NEEDS ?? '')}`);
  process.exit(1);
}

if (names.length === 0) {
  console.error('待つジョブの名前を引数に渡す（例: node scripts/ci-summary.mjs check browser）');
  process.exit(1);
}

const needs = readNeeds();
const results = names.map((name) => ({ name, result: typeof needs[name]?.result === 'string' ? needs[name].result : '（結果がない）' }));
for (const { name, result } of results) console.log(`${name}: ${result}`);
const failed = results.filter((r) => r.result !== 'success');
if (failed.length > 0) {
  console.error(`成功していないジョブ: ${failed.map((r) => `${r.name}（${r.result}）`).join('、')}`);
  process.exit(1);
}
console.log('すべてのジョブが成功した');
