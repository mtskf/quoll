function isReplacedCodePoint(value: number): boolean {
  return value === 0 || (value >= 0xd800 && value <= 0xdfff) || value > 0x10ffff;
}

export function decodeNumericEntity(raw: string): string | null {
  const match = /^&#(?:([0-9]{1,7})|[xX]([0-9a-fA-F]{1,6}));$/.exec(raw);
  if (!match) {
    return null;
  }
  const value =
    match[1] !== undefined ? Number.parseInt(match[1], 10) : Number.parseInt(match[2], 16);
  return isReplacedCodePoint(value) ? "�" : String.fromCodePoint(value);
}
