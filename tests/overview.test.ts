import { expect, test } from 'bun:test';
import { coveragePercent, requestDelta, scopedWAFAgents } from '../src/lib/overview';

test('coverage never treats missing or ineligible agents as protected', () => {
 expect(coveragePercent(0, 0)).toBeNull();
 expect(coveragePercent(0, 2)).toBe(0);
 expect(coveragePercent(2, 2)).toBe(100);
 expect(coveragePercent(3, 2)).toBeNull();
});
test('host scope includes every WAF agent and does not fall back to project traffic', () => {
 const agents = [{id:'a',host_id:'host1'}, {id:'b',host_id:'host1'}, {id:'c',host_id:'host2'}];
 expect(scopedWAFAgents(agents, 'host1').map(a=>a.id)).toEqual(['a','b']);
 expect(scopedWAFAgents(agents, 'missing')).toEqual([]);
});
test('previous-period change handles absent and zero denominators honestly', () => {
 expect(requestDelta(4, 0)).toBe('New activity; previous period had 0 requests');
 expect(requestDelta(0, 0)).toBe('No requests in either period');
 expect(requestDelta(4, null)).toBe('Previous period unavailable');
 expect(requestDelta(15, 10)).toBe('+50.0% requests vs previous period');
});
