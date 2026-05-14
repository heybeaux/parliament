import { describe, expect, it } from 'vitest';
import { validateIPv4, isValidIPv4 } from './ip_validator.js';

// ---------------------------------------------------------------------------
// validateIPv4 — valid addresses
// ---------------------------------------------------------------------------

describe('validateIPv4 — valid addresses', () => {
  it('accepts 0.0.0.0 (all-zeros)', () => {
    expect(validateIPv4('0.0.0.0')).toEqual({ valid: true });
  });

  it('accepts 255.255.255.255 (all-max)', () => {
    expect(validateIPv4('255.255.255.255')).toEqual({ valid: true });
  });

  it('accepts a typical private address', () => {
    expect(validateIPv4('192.168.1.1')).toEqual({ valid: true });
  });

  it('accepts loopback 127.0.0.1', () => {
    expect(validateIPv4('127.0.0.1')).toEqual({ valid: true });
  });

  it('accepts address with a zero octet in the middle', () => {
    expect(validateIPv4('10.0.0.1')).toEqual({ valid: true });
  });

  it('accepts single-digit octets', () => {
    expect(validateIPv4('1.2.3.4')).toEqual({ valid: true });
  });
});

// ---------------------------------------------------------------------------
// validateIPv4 — out-of-range octets
// ---------------------------------------------------------------------------

describe('validateIPv4 — out-of-range octets', () => {
  it('rejects 256.0.0.1 (first octet too large)', () => {
    const result = validateIPv4('256.0.0.1');
    expect(result.valid).toBe(false);
  });

  it('rejects 999.999.999.999 (all octets too large)', () => {
    const result = validateIPv4('999.999.999.999');
    expect(result.valid).toBe(false);
  });

  it('rejects 192.168.1.256 (last octet too large)', () => {
    const result = validateIPv4('192.168.1.256');
    expect(result.valid).toBe(false);
  });

  it('rejects 0.0.0.256', () => {
    expect(validateIPv4('0.0.0.256').valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateIPv4 — leading zeros (RFC violation)
// ---------------------------------------------------------------------------

describe('validateIPv4 — leading zeros', () => {
  it('rejects 01.02.03.04', () => {
    expect(validateIPv4('01.02.03.04').valid).toBe(false);
  });

  it('rejects 192.168.001.1', () => {
    expect(validateIPv4('192.168.001.1').valid).toBe(false);
  });

  it('rejects 00.0.0.0 (double zero)', () => {
    expect(validateIPv4('00.0.0.0').valid).toBe(false);
  });

  it('allows bare 0 (single zero is fine)', () => {
    expect(validateIPv4('0.0.0.0').valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateIPv4 — wrong number of octets
// ---------------------------------------------------------------------------

describe('validateIPv4 — wrong number of octets', () => {
  it('rejects "1.2.3" (only 3 octets)', () => {
    const result = validateIPv4('1.2.3');
    expect(result.valid).toBe(false);
  });

  it('rejects "1.2.3.4.5" (5 octets)', () => {
    const result = validateIPv4('1.2.3.4.5');
    expect(result.valid).toBe(false);
  });

  it('rejects "1" (single token)', () => {
    expect(validateIPv4('1').valid).toBe(false);
  });

  it('rejects empty string', () => {
    const result = validateIPv4('');
    expect(result.valid).toBe(false);
  });

  it('rejects a string that is just dots "..."', () => {
    expect(validateIPv4('...').valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateIPv4 — non-numeric / malformed input
// ---------------------------------------------------------------------------

describe('validateIPv4 — malformed / non-numeric input', () => {
  it('rejects "abc"', () => {
    expect(validateIPv4('abc').valid).toBe(false);
  });

  it('rejects "abc.def.ghi.jkl"', () => {
    expect(validateIPv4('abc.def.ghi.jkl').valid).toBe(false);
  });

  it('rejects an address with embedded spaces "192.168.1 .1"', () => {
    expect(validateIPv4('192.168.1 .1').valid).toBe(false);
  });

  it('rejects an address with a sign character "+1.2.3.4"', () => {
    expect(validateIPv4('+1.2.3.4').valid).toBe(false);
  });

  it('rejects an address with a negative octet "-1.2.3.4"', () => {
    expect(validateIPv4('-1.2.3.4').valid).toBe(false);
  });

  it('rejects hex notation "0xff.0.0.1"', () => {
    expect(validateIPv4('0xff.0.0.1').valid).toBe(false);
  });

  it('rejects floating-point octet "1.2.3.4.0" embedded', () => {
    expect(validateIPv4('1.2.3.4.0').valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateIPv4 — IPv6 graceful rejection
// ---------------------------------------------------------------------------

describe('validateIPv4 — IPv6 graceful rejection', () => {
  it('rejects a full IPv6 address with a descriptive reason', () => {
    const result = validateIPv4('2001:0db8:85a3:0000:0000:8a2e:0370:7334');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/IPv6/i);
    }
  });

  it('rejects compressed IPv6 "::1"', () => {
    const result = validateIPv4('::1');
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isValidIPv4 — boolean convenience wrapper
// ---------------------------------------------------------------------------

describe('isValidIPv4', () => {
  it('returns true for a valid address', () => {
    expect(isValidIPv4('192.168.0.1')).toBe(true);
  });

  it('returns false for an invalid address', () => {
    expect(isValidIPv4('256.0.0.1')).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(isValidIPv4('')).toBe(false);
  });

  it('returns false for "1.2.3"', () => {
    expect(isValidIPv4('1.2.3')).toBe(false);
  });

  it('returns false for "1.2.3.04" (leading zero)', () => {
    expect(isValidIPv4('1.2.3.04')).toBe(false);
  });
});
