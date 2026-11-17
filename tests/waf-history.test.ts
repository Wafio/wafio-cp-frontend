import { expect, test } from 'bun:test';
import { configChanges } from '../src/lib/waf-history';

test('history diff reports changed, added and removed settings with values', () => {
 expect(configChanges({thresholds:{block:150},disabled:true},{thresholds:{block:180},mode:2})).toEqual([
  {path:'disabled',before:true,after:undefined},
  {path:'mode',before:undefined,after:2},
  {path:'thresholds.block',before:150,after:180},
 ]);
});
test('identical redacted previews are not proof that hidden config is unchanged', () => {
 expect(configChanges({challenge:'[redacted]'},{challenge:'[redacted]'})).toEqual([]);
});
