import '../../setup/test-setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PendingPermissions } from '../../../runtime/permission-gateway.js';

describe('PendingPermissions', () => {
  it('waitFor resolves explicit decisions and reports unknown ids', async () => {
    const pp = new PendingPermissions();
    const allowPromise = pp.waitFor('req-1');
    const denyPromise = pp.waitFor('req-2');
    assert.equal(pp.size, 2);

    assert.equal(pp.resolve('req-1', { behavior: 'allow' }), true);
    assert.equal(pp.resolve('req-2', { behavior: 'deny', message: 'Not allowed' }), true);
    assert.equal(pp.resolve('unknown', { behavior: 'allow' }), false);

    const [allowResult, denyResult] = await Promise.all([allowPromise, denyPromise]);
    assert.equal(allowResult.behavior, 'allow');
    assert.equal(denyResult.behavior, 'deny');
    assert.equal(denyResult.message, 'Not allowed');
    assert.equal(pp.size, 0);
  });

  it('denyAll resolves all pending', async () => {
    const pp = new PendingPermissions();
    const p1 = pp.waitFor('req-a');
    const p2 = pp.waitFor('req-b');
    assert.equal(pp.size, 2);

    pp.denyAll();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.behavior, 'deny');
    assert.equal(r2.behavior, 'deny');
    assert.equal(r1.message, 'Bridge shutting down');
    assert.equal(r2.message, 'Bridge shutting down');
    assert.equal(pp.size, 0);
  });

  it('timeout auto-denies after expiry', async () => {
    // Create with short timeout for testing
    const pp = new PendingPermissions();
    // Access private field to set short timeout
    (pp as any).timeoutMs = 50;

    const result = await pp.waitFor('req-timeout');
    assert.equal(result.behavior, 'deny');
    assert.match(result.message!, /timed out/i);
    assert.equal(pp.size, 0);
  });
});
