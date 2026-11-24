import { CheatCodeEntry, CheatPatchRule } from './types';

function parseHex(token: string): number {
  const clean = token.trim().replace(/^0x/i, '');
  if (!/^[0-9a-f]+$/i.test(clean)) {
    throw new Error(`Invalid hex value "${token.trim()}".`);
  }
  return parseInt(clean, 16);
}

export function parseCheatCode(rawCode: string): CheatPatchRule[] {
  const tokens = rawCode
    .split(/[\r\n;,]+/)
    .map((line) => line.replace(/(\/\/|#).*$/, '').trim())
    .filter(Boolean);

  if (tokens.length === 0) {
    throw new Error('Enter at least one cheat code line (for example E010:63).');
  }

  const rules: CheatPatchRule[] = [];

  for (const token of tokens) {
    const romPrefixed = /^rom@/i.test(token);
    const body = romPrefixed ? token.slice(4).trim() : token;

    // Normalize separators ":", "=", or whitespace into parts
    const parts = body
      .split(/[:=\s]+/)
      .map((p) => p.trim())
      .filter(Boolean);

    if (parts.length < 2 || parts.length > 3) {
      throw new Error(
        `Invalid format "${token}". Use ADDR:VAL (e.g. E012:63) or ADDR:VAL:CMP.`
      );
    }

    const addrRaw = parts[0].replace(/^0x/i, '');
    const addr = parseHex(addrRaw);
    const valRaw = parts[1].replace(/^0x/i, '');
    const val = parseHex(valRaw);

    if (romPrefixed || addrRaw.length >= 5) {
      if (addr < 0 || addr > 0x1fffff) {
        throw new Error(`ROM offset "${parts[0]}" out of range (00000–1FFFFF).`);
      }
      if (val < 0 || val > 0xff || valRaw.length > 2) {
        throw new Error(`ROM patch value "${parts[1]}" must be a single byte (00–FF).`);
      }
      rules.push({
        kind: 'rom-patch',
        address: addr,
        value: val & 0xff,
      });
      continue;
    }

    if (addr < 0 || addr > 0xffff) {
      throw new Error(`Address "${parts[0]}" must be in 0000–FFFF.`);
    }

    if (parts.length === 3) {
      const cmpRaw = parts[2].replace(/^0x/i, '');
      const cmp = parseHex(cmpRaw);
      if (val < 0 || val > 0xff || cmp < 0 || cmp > 0xff) {
        throw new Error(`Conditional cheat "${token}" requires 8-bit VAL and CMP (00–FF).`);
      }
      rules.push({
        kind: 'ram-conditional',
        address: addr & 0xffff,
        value: val & 0xff,
        compare: cmp & 0xff,
      });
      continue;
    }

    // Support 8-bit (2 hex chars) or 16-bit (4 hex chars) RAM writes
    if (valRaw.length <= 2) {
      if (val < 0 || val > 0xff) {
        throw new Error(`Byte value "${parts[1]}" out of range (00–FF).`);
      }
      rules.push({
        kind: 'ram-freeze',
        address: addr & 0xffff,
        value: val & 0xff,
      });
    } else if (valRaw.length <= 4) {
      rules.push({
        kind: 'ram-freeze',
        address: addr & 0xffff,
        value: (val >> 8) & 0xff,
      });
      rules.push({
        kind: 'ram-freeze',
        address: (addr + 1) & 0xffff,
        value: val & 0xff,
      });
    } else {
      throw new Error(`Value "${parts[1]}" is too long; use 2 or 4 hex digits.`);
    }
  }

  return rules;
}

export function validateCheatCode(rawCode: string): {
  valid: boolean;
  rules: CheatPatchRule[];
  error?: string;
} {
  try {
    const rules = parseCheatCode(rawCode);
    return { valid: true, rules };
  } catch (err) {
    return {
      valid: false,
      rules: [],
      error: err instanceof Error ? err.message : 'Invalid cheat code syntax.',
    };
  }
}

export function compileEnabledCheats(entries: CheatCodeEntry[]): {
  ramRules: CheatPatchRule[];
  romPatches: CheatPatchRule[];
} {
  const ramRules: CheatPatchRule[] = [];
  const romPatches: CheatPatchRule[] = [];

  for (const entry of entries) {
    if (!entry.enabled) continue;
    try {
      const parsed = parseCheatCode(entry.code);
      for (const rule of parsed) {
        if (rule.kind === 'rom-patch') {
          romPatches.push(rule);
        } else {
          ramRules.push(rule);
        }
      }
    } catch {
      // Skip malformed legacy entries safely
    }
  }

  return { ramRules, romPatches };
}
