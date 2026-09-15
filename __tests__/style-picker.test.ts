import { afterEach, describe, expect, test } from 'bun:test';
import { createProvider, showQuickPick, resetHostFixture } from './host-fixture.ts';
afterEach(resetHostFixture);

describe('chat style picker', () => {
  test.each(['default', 'custom'])('selects the %s stylesheet', async (style) => {
    const { provider, messages } = await createProvider();
    showQuickPick.mockImplementation(async items => items.find(item => item.style === style));
    await provider.handleMessage({ type: 'selectStyle', currentStyle: 'custom' });
    expect(showQuickPick.mock.calls[0][0]).toEqual([
      { label: 'Default', detail: 'Uses VS Code theme colors.', style: 'default', description: undefined },
      { label: 'Custom', detail: 'Tinted tool results and light blue code blocks.', style: 'custom', description: 'Current' },
    ]);
    expect(messages).toEqual([{ type: 'styleSelected', style }]);
  });

  test('cancelling the picker leaves the current style unchanged', async () => {
    const { provider, messages } = await createProvider();
    await provider.handleMessage({ type: 'selectStyle', currentStyle: 'default' });
    expect(showQuickPick).toHaveBeenCalledTimes(1);
    expect(messages).toEqual([]);
  });
});
