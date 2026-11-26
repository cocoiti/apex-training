import { describe, expect, it } from 'vitest';
import { FLICK_RANGE_OPTION, FLICK_SIZE_OPTION } from '../../src/modes/aim/flick';
import { SPEED_OPTION } from '../../src/modes/tracking';
import { modeOptionChoices, modeOptionValues } from '../../src/modes/types';

// 練習の選択肢（docs/spec/modes.md「モードの登録」）の値の決め方。
describe('練習の選択肢の値', () => {
  const flick = { options: [FLICK_RANGE_OPTION, FLICK_SIZE_OPTION] };

  it('モードの選択肢の並び順に、渡した値を選ぶ', () => {
    const chosen = modeOptionChoices(flick, { 'flick-size': 'small', 'flick-range': 'far' });
    expect(chosen.map((s) => [s.option.id, s.choice.id, s.choice.name.ja])).toEqual([
      ['flick-range', 'far', '遠い'],
      ['flick-size', 'small', '小'],
    ]);
    expect(modeOptionValues(chosen)).toEqual({ 'flick-range': 'far', 'flick-size': 'small' });
  });

  it('渡されなかった選択肢と選択肢にない値は既定の値にし、ほかのモードの選択肢の値は使わない', () => {
    const chosen = modeOptionChoices(flick, { 'flick-range': 'warp', speed: 'fast' });
    expect(chosen.map((s) => s.choice.id)).toEqual(['normal', 'medium']);
    expect(modeOptionChoices({ options: [SPEED_OPTION] }, { speed: 'fast', 'flick-range': 'far' }).map((s) => s.choice.id)).toEqual(['fast']);
  });

  it('選択肢を持たないモードでは空', () => {
    expect(modeOptionChoices({}, { speed: 'fast' })).toEqual([]);
    expect(modeOptionValues([])).toEqual({});
  });
});
