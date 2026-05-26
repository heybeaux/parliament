/**
 * IP address validation utilities.
 *
 * IPv4 rules (per RFC 791 / common practice):
 *  - Exactly 4 dot-separated octets
 *  - Each octet is a decimal integer in [0, 255]
 *  - No leading zeros (e.g. "01" is invalid)
 *  - No extra whitespace, signs, or non-numeric characters
 *
 * IPv6 is not supported; IPv6 strings are rejected with a descriptive error.
 */

export type ValidationResult =
  | { valid: true }
  | { valid: false; reason: string };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns true only when the string represents a valid decimal octet with no
 * leading zeros.  A single "0" is allowed; "00", "01", "256", etc. are not.
 */
function isValidOctet(token: string): boolean {
  // Must be non-empty, digits only
  if (token.length === 0 || !/^\d+$/.test(token)) return false;

  // Reject leading zeros ("01", "001", …) but allow bare "0"
  if (token.length > 1 && token[0] === '0') return false;

  const value = Number(token);
  return value >= 0 && value <= 255;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validates a string as an IPv4 address.
 *
 * @param input - The string to validate.
 * @returns A `ValidationResult` — either `{ valid: true }` or
 *          `{ valid: false, reason: string }`.
 *
 * @example
 * validateIPv4('192.168.1.1');   // { valid: true }
 * validateIPv4('256.0.0.1');    // { valid: false, reason: '...' }
 * validateIPv4('01.02.03.04');  // { valid: false, reason: '...' }
 * validateIPv4('1.2.3');        // { valid: false, reason: '...' }
 */
export function validateIPv4(input: string): ValidationResult {
  if (typeof input !== 'string' || input.length === 0) {
    return { valid: false, reason: 'Input must be a non-empty string' };
  }

  // Quick guard: colon means IPv6 territory
  if (input.includes(':')) {
    return {
      valid: false,
      reason: 'IPv6 addresses are not supported; provide an IPv4 address',
    };
  }

  const parts = input.split('.');

  if (parts.length !== 4) {
    return {
      valid: false,
      reason: `Expected exactly 4 octets separated by dots, got ${parts.length}`,
    };
  }

  for (let i = 0; i < parts.length; i++) {
    if (!isValidOctet(parts[i])) {
      return {
        valid: false,
        reason: `Octet ${i + 1} "${parts[i]}" is invalid — must be a decimal integer 0–255 with no leading zeros`,
      };
    }
  }

  return { valid: true };
}

/**
 * Convenience wrapper that returns a plain boolean.
 *
 * @param input - The string to test.
 * @returns `true` if `input` is a valid IPv4 address, `false` otherwise.
 */
export function isValidIPv4(input: string): boolean {
  return validateIPv4(input).valid;
}
