import {expect,test} from 'bun:test';
import {parseSIEMDelivery} from '../src/lib/siem-delivery';
test('missing and malformed SIEM counters remain unavailable',()=>{
 expect(parseSIEMDelivery(undefined)).toBeNull();
 expect(parseSIEMDelivery({accepted:0})).toBeNull();
 expect(parseSIEMDelivery({accepted:0,delivered:0,failed:0,dropped:-1,retried:0,queued:0,in_flight:0})).toBeNull();
});
test('zero counters are available without implying delivery',()=>{
 const value={accepted:0,delivered:0,failed:0,dropped:0,retried:0,queued:0,in_flight:0};
 expect(parseSIEMDelivery(value)).toEqual(value);
});
