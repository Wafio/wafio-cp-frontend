export function conditionValue(field: string, op: string, value: unknown): string | number | boolean | (string | number | boolean)[] {
  const scalar = (item: unknown): string | number | boolean => {
    if (field === 'is_container') {
      if (item === true || item === 'true') return true;
      if (item === false || item === 'false') return false;
      throw new Error('Is Container must be true or false');
    }
    if (['severity', 'port', 'uid', 'gid', 'flags', 'detail', 'addr_family'].includes(field)) {
      const number = typeof item === 'number' ? item : Number(String(item).trim());
      if (String(item).trim() === '' || !Number.isSafeInteger(number) || number < 0 || (field === 'severity' && number > 4) || (field === 'port' && number > 65535)) throw new Error(`Invalid ${field} value`);
      return number;
    }
    return String(item);
  };
  if (op === 'in' || op === 'not_in') {
    const values = Array.isArray(value) ? value : String(value).split(',').map(item => item.trim()).filter(Boolean);
    if (!values.length) throw new Error('Enter at least one list value');
    return values.map(scalar);
  }
  return scalar(value);
}
