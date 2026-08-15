import { describe, expect, it, vi } from 'vitest';
import { mapEvolutionStatus } from './evolution-status';

describe('mapEvolutionStatus', () => {
  it('maps known Baileys/Evolution connection states to the internal enum', () => {
    expect(mapEvolutionStatus('open')).toBe('connected');
    expect(mapEvolutionStatus('connected')).toBe('connected');
    expect(mapEvolutionStatus('connecting')).toBe('connecting');
    expect(mapEvolutionStatus('close')).toBe('disconnected');
    expect(mapEvolutionStatus('closed')).toBe('disconnected');
    expect(mapEvolutionStatus('disconnected')).toBe('disconnected');
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(mapEvolutionStatus('OPEN')).toBe('connected');
    expect(mapEvolutionStatus('  Close  ')).toBe('disconnected');
  });

  it('falls back to "error" and logs a warning for an unrecognized status', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(mapEvolutionStatus('some-future-state')).toBe('error');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('unmapped status: some-future-state')
    );
    warnSpy.mockRestore();
  });

  it('falls back to "error" for empty/unknown input without throwing', () => {
    expect(mapEvolutionStatus('')).toBe('error');
    // @ts-expect-error — defensive runtime check for a non-string webhook payload field
    expect(mapEvolutionStatus(undefined)).toBe('error');
  });
});
