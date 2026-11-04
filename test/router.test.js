import test from 'node:test';
import assert from 'node:assert/strict';
import { NexusRouter } from '../src/router.js';

function makeRouter() {
  const router = new NexusRouter();

  router.registerConnector('git', {
    tools: [
      {
        name: 'commit',
        description: 'Record changes to the repository',
        handler: async () => ({ ok: true })
      }
    ]
  });

  router.registerConnector('memory', {
    tools: [
      {
        name: 'store',
        description: 'Save key-value context in memory',
        handler: async () => ({ saved: true })
      }
    ]
  });

  return router;
}

test('discoverTools returns all tools when no intent is given', () => {
  const router = makeRouter();
  assert.equal(router.discoverTools().length, 2);
});

test('discoverTools filters tools by keyword', () => {
  const router = makeRouter();
  const result = router.discoverTools('repository commit');
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'git.commit');
});

test('tools/call runs the tool handler', async () => {
  const router = makeRouter();
  const response = await router.dispatchRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'git.commit', arguments: {} }
  });
  assert.equal(response.result.content[0].text, '{"ok":true}');
});

test('tools/call returns an error for an unknown tool', async () => {
  const router = makeRouter();
  const response = await router.dispatchRequest({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'nope.nothing', arguments: {} }
  });
  assert.equal(response.error.code, -32601);
});
