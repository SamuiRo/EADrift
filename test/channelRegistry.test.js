import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseChannelConfig,
  resolveForwardSource,
  normalizeChannelKey,
} from '../src/sources/channelRegistry.js';

test('channel ids in Bot API, MTProto and username forms compare equal', () => {
  assert.equal(normalizeChannelKey('-1001234567890'), '1234567890');
  assert.equal(normalizeChannelKey('1234567890'), '1234567890');
  assert.equal(normalizeChannelKey(-1001234567890), '1234567890');
  assert.equal(normalizeChannelKey('@Whales_Signals'), 'whales_signals');
});

test('parses several named channels with optional parser', () => {
  const { channels, errors } = parseChannelConfig({
    signalChannels: 'ggshot:-1001111, whales:@whales_signals:ggshot',
  });

  assert.deepEqual(errors, []);
  assert.deepEqual(channels.map(c => [c.name, c.key, c.parser]), [
    ['ggshot', '1111', 'ggshot'],
    ['whales', 'whales_signals', 'ggshot'],
  ]);
});

test('falls back to the legacy single-channel variable', () => {
  // Сервер, розгорнутий до v1.7.0, має лише TELEGRAM_SIGNAL_CHANNEL_ID —
  // після оновлення він мусить і далі слухати той самий канал під тим же ім'ям.
  const { channels } = parseChannelConfig({ legacyChannelId: '-1009999', legacyName: 'ggshot' });
  assert.deepEqual(channels.map(c => [c.name, c.key]), [['ggshot', '9999']]);
});

test('SIGNAL_CHANNELS takes precedence over the legacy variable', () => {
  const { channels } = parseChannelConfig({ signalChannels: 'a:-1001', legacyChannelId: '-1002' });
  assert.deepEqual(channels.map(c => c.name), ['a']);
});

test('rejects bad names, unknown parsers and duplicates without dropping valid channels', () => {
  const { channels, errors } = parseChannelConfig({
    signalChannels: 'Bad Name:-1001, ok:-1002, other:-1003:nosuchparser, ok:-1004, dup:-1002, noid',
  });

  assert.deepEqual(channels.map(c => c.name), ['ok']);
  assert.equal(errors.length, 5);
});

const CHANNELS = parseChannelConfig({ signalChannels: 'ggshot:-1001111,whales:@whales_signals' }).channels;

test('a forward from a known channel is credited to that channel', () => {
  const byId = resolveForwardSource({
    forward_origin: { type: 'channel', chat: { id: -1001111, title: 'GG-Shot' } },
  }, CHANNELS);
  assert.equal(byId.source, 'ggshot');
  assert.equal(byId.channel.name, 'ggshot');

  const byUsername = resolveForwardSource({
    forward_origin: { type: 'channel', chat: { id: -1005555, username: 'Whales_Signals' } },
  }, CHANNELS);
  assert.equal(byUsername.source, 'whales');
});

test('a forward from an unknown channel keeps a traceable label', () => {
  const result = resolveForwardSource({
    forward_origin: { type: 'channel', chat: { id: -1007777, title: 'Crypto Inner Circle!' } },
  }, CHANNELS);

  assert.equal(result.source, 'forward:crypto_inner_circle');
  assert.equal(result.channel, null);
});

test('typed and privacy-hidden forwards are labelled honestly', () => {
  assert.equal(resolveForwardSource({ text: 'x' }, CHANNELS).source, 'admin_message');
  assert.equal(resolveForwardSource({ forward_origin: { type: 'hidden_user' } }, CHANNELS).source, 'admin_forward');
});
