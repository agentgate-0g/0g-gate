import { describe, expect, it } from 'vitest';
import {
  X402_VERSION, X402_SCHEME, X402_ASSET_OG, toCaip2Network,
  encodeXPayment, decodeXPayment, encodeXPaymentResponse, decodeXPaymentResponse,
} from '../src/x402';
import { AgentGateError } from '../src/index';

const ROUTER = '0x' + '11'.repeat(20);
const TX = '0x' + 'ab'.repeat(32);
const PAYER = '0x' + '22'.repeat(20);

describe('x402 on 0G', () => {
  it('toCaip2Network builds eip155 identifiers', () => {
    expect(toCaip2Network(16602)).toBe('eip155:16602');
    expect(toCaip2Network(1)).toBe('eip155:1');
  });

  it('the constants describe the native OG rail', () => {
    expect(X402_VERSION).toBe(1);
    expect(X402_SCHEME).toBe('exact-settled');
    expect(X402_ASSET_OG).toBe('OG');
  });

  it('round-trips an X-PAYMENT payload', () => {
    const payload = {
      x402Version: X402_VERSION,
      scheme: X402_SCHEME,
      network: '0g-galileo',
      payload: { transaction: TX, nonce: '12345', from: ROUTER },
    };
    expect(decodeXPayment(encodeXPayment(payload))).toEqual(payload);
  });

  it('omits payload.from when absent', () => {
    const payload = {
      x402Version: X402_VERSION,
      scheme: X402_SCHEME,
      network: '0g-galileo',
      payload: { transaction: TX, nonce: '7' },
    };
    const decoded = decodeXPayment(encodeXPayment(payload));
    expect(decoded.payload.from).toBeUndefined();
  });

  it('rejects a payment whose transaction is not a 0x 32-byte hash', () => {
    for (const bad of ['ab'.repeat(32), '0xzz', '0x1234', '']) {
      const header = encodeXPayment({
        x402Version: X402_VERSION, scheme: X402_SCHEME, network: '0g-galileo',
        payload: { transaction: bad, nonce: '1' },
      });
      expect(() => decodeXPayment(header)).toThrow(/transaction/);
    }
  });

  it('rejects a non-numeric nonce', () => {
    const header = encodeXPayment({
      x402Version: X402_VERSION, scheme: X402_SCHEME, network: '0g-galileo',
      payload: { transaction: TX, nonce: 'abc' },
    });
    expect(() => decodeXPayment(header)).toThrow(/nonce/);
  });

  it('rejects a nonce that exceeds the uint256 range', () => {
    // 78 digits, same digit count as 2^256-1, but numerically larger.
    const tooLarge = '9'.repeat(78);
    const header = encodeXPayment({
      x402Version: X402_VERSION, scheme: X402_SCHEME, network: '0g-galileo',
      payload: { transaction: TX, nonce: tooLarge },
    });
    expect(() => decodeXPayment(header)).toThrow(/uint256/);
  });

  it('accepts a nonce exactly at the uint256 max', () => {
    const uint256Max = (2n ** 256n - 1n).toString();
    const payload = {
      x402Version: X402_VERSION, scheme: X402_SCHEME, network: '0g-galileo',
      payload: { transaction: TX, nonce: uint256Max },
    };
    expect(decodeXPayment(encodeXPayment(payload))).toEqual(payload);
  });

  it('rejects wrong x402Version or scheme', () => {
    const okPayload = { transaction: TX, nonce: '1' };
    expect(() => decodeXPayment(encodeXPayment({
      x402Version: 2, scheme: X402_SCHEME, network: '0g-galileo', payload: okPayload,
    }))).toThrow(/x402Version/);
    expect(() => decodeXPayment(encodeXPayment({
      x402Version: X402_VERSION, scheme: 'upto', network: '0g-galileo', payload: okPayload,
    }))).toThrow(/scheme/);
  });

  it('rejects a missing or empty network', () => {
    const header = Buffer.from(JSON.stringify({
      x402Version: X402_VERSION, scheme: X402_SCHEME, network: '',
      payload: { transaction: TX, nonce: '1' },
    }), 'utf8').toString('base64');
    expect(() => decodeXPayment(header)).toThrow(/network/);
  });
});

describe('decodeXPayment is defensive against untrusted input', () => {
  it('rejects non-base64 / non-JSON header text', () => {
    expect(() => decodeXPayment('@@@not-base64@@@')).toThrow(AgentGateError);
    expect(() => decodeXPayment(Buffer.from('not json', 'utf8').toString('base64'))).toThrow(AgentGateError);
  });

  it('rejects valid JSON that is not an object', () => {
    for (const notObject of ['[]', '"a string"', '42', 'null', 'true']) {
      const header = Buffer.from(notObject, 'utf8').toString('base64');
      expect(() => decodeXPayment(header)).toThrow(AgentGateError);
    }
  });

  it('rejects a payload that is missing or not an object', () => {
    const missingPayload = Buffer.from(JSON.stringify({
      x402Version: X402_VERSION, scheme: X402_SCHEME, network: '0g-galileo',
    }), 'utf8').toString('base64');
    expect(() => decodeXPayment(missingPayload)).toThrow(/payload/);

    const arrayPayload = Buffer.from(JSON.stringify({
      x402Version: X402_VERSION, scheme: X402_SCHEME, network: '0g-galileo', payload: [],
    }), 'utf8').toString('base64');
    expect(() => decodeXPayment(arrayPayload)).toThrow(/payload/);
  });
});

describe('settlement response codec', () => {
  it('round-trips a settlement response', () => {
    const s = { success: true, transaction: TX, network: '0g-galileo', payer: PAYER };
    expect(decodeXPaymentResponse(encodeXPaymentResponse(s))).toEqual(s);
  });

  it('rejects non-base64 / non-JSON', () => {
    expect(() => decodeXPaymentResponse('!!!not-valid-base64!!!')).toThrow(AgentGateError);
    expect(() => decodeXPaymentResponse(Buffer.from('not json', 'utf8').toString('base64'))).toThrow(AgentGateError);
  });

  it('rejects when success is not boolean', () => {
    const bad = Buffer.from(JSON.stringify({ success: 'yes', transaction: TX, network: '0g-galileo' }), 'utf8').toString('base64');
    expect(() => decodeXPaymentResponse(bad)).toThrow(AgentGateError);
  });

  it('rejects when transaction or network are missing or empty', () => {
    const noTx = Buffer.from(JSON.stringify({ success: true, network: '0g-galileo' }), 'utf8').toString('base64');
    expect(() => decodeXPaymentResponse(noTx)).toThrow(AgentGateError);
    const emptyNet = Buffer.from(JSON.stringify({ success: true, transaction: TX, network: '' }), 'utf8').toString('base64');
    expect(() => decodeXPaymentResponse(emptyNet)).toThrow(AgentGateError);
  });
});
