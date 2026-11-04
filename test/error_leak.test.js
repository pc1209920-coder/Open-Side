import test from 'node:test';
import assert from 'node:assert/strict';
import { NexusRouter } from '../src/router.js';

test('does not leak error details', async () => {
  const router = new NexusRouter();
  router.registerConnector('test', {
    tools: [
      {
        name: 'fail',
        description: 'Always fails',
        handler: async () => { throw new Error('Secret Database Connection String: mysql://user:password@localhost:3306/db'); }
      }
    ]
  });

  const response = await router.dispatchRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'test.fail', arguments: {} }
  });

  assert.ok(!response.error.message.includes('mysql://'), 'Should not leak sensitive error messages');
});
