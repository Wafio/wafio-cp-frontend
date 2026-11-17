// sse.ts: a 429 STREAM_LIMIT names the ceiling the server reported.
import { describe, expect, test } from 'bun:test';
import { STREAM_LIMIT_ACCOUNT_MESSAGE, STREAM_LIMIT_MESSAGE, streamLimitMessage } from '../src/lib/sse';

describe('stream limit message', () => {
  test('account ceiling', () => {
    expect(streamLimitMessage('too many open host streams for this account; close an existing one and retry')).toBe(
      STREAM_LIMIT_ACCOUNT_MESSAGE,
    );
  });

  test('project ceiling or unknown text falls back to the project wording', () => {
    expect(streamLimitMessage('too many open waf streams for this project; close an existing one and retry')).toBe(STREAM_LIMIT_MESSAGE);
    expect(streamLimitMessage(undefined)).toBe(STREAM_LIMIT_MESSAGE);
    expect(streamLimitMessage('')).toBe(STREAM_LIMIT_MESSAGE);
  });
});
