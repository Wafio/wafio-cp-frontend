import { expect, test } from 'bun:test';
import { conditionValue } from '../src/lib/detection-rule';
test('list editor writes typed arrays', () => {
 expect(conditionValue('comm', 'not_in', 'bash, sh')).toEqual(['bash', 'sh']);
 expect(conditionValue('severity', 'in', '0,4')).toEqual([0,4]);
 expect(conditionValue('is_container', 'eq', 'false')).toBe(false);
});
test('invalid severity and empty exclusions fail', () => {
 expect(() => conditionValue('severity', 'eq', '5')).toThrow();
 expect(() => conditionValue('comm', 'not_in', '')).toThrow();
});
test('preserves numeric operation details and masks', () => {
 expect(conditionValue('detail', 'eq', '0')).toBe(0);
 expect(conditionValue('detail', 'in', '3,2051,524291,526339')).toEqual([3,2051,524291,526339]);
 expect(conditionValue('flags', 'bit_none', '579')).toBe(579);
});
