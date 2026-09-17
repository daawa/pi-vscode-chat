import { afterEach, describe, expect, test } from 'bun:test';
import { createProvider, showQuickPick, resetHostFixture } from './host-fixture.ts';
afterEach(resetHostFixture);

describe('chat style picker', () => {
  test.each(['default', 'custom'])('selects the %s stylesheet', async (style) => {
    const { provider, messages } = await createProvider();
    showQuickPick.mockImplementation(async items => items.find(item => item.style === style));
    await provider.handleMessage({ type: 'selectStyle', currentStyle: 'custom' });
    expect(showQuickPick.mock.calls[0][0]).toEqual([
      { label: '$(check) Custom', detail: 'Tinted tool results and light blue code blocks.', style: 'custom', description: 'Currently selected' },
      { label: 'Default', detail: 'Uses VS Code theme colors.', style: 'default', description: undefined },
    ]);
    expect(messages).toEqual([{ type: 'styleSelected', style }]);
  });

  test.each(['default', 'custom'] as const)('marks and initially highlights the current %s style', async (currentStyle) => {
    const { provider } = await createProvider();
    await provider.handleMessage({ type: 'selectStyle', currentStyle });
    const items = showQuickPick.mock.calls[0][0];
    expect(items[0].style).toBe(currentStyle);
    expect(items[0].label).toBe(`$(check) ${currentStyle === 'default' ? 'Default' : 'Custom'}`);
    expect(items[0].description).toBe('Currently selected');
    expect(items[1].label).not.toContain('$(check)');
    expect(items[1].description).toBeUndefined();
  });

  test('cancelling the picker leaves the current style unchanged', async () => {
    const { provider, messages } = await createProvider();
    await provider.handleMessage({ type: 'selectStyle', currentStyle: 'default' });
    expect(showQuickPick).toHaveBeenCalledTimes(1);
    expect(messages).toEqual([]);
  });
});
