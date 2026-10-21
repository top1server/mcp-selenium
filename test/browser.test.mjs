/**
 * Browser management tests — start_browser, close_session, take_screenshot,
 * multi-session handling.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { McpClient, getResponseText, fixture } from './mcp-client.mjs';

describe('Browser Management', () => {
  let client;

  before(async () => {
    client = new McpClient();
    await client.start();
  });

  after(async () => {
    try {
      const result = await client.callTool('session', { action: 'list' });
      const { sessions = [] } = JSON.parse(getResponseText(result));
      for (const session of sessions) {
        await client.callTool('session', { action: 'close', session_id: session.session_id });
      }
    } catch { /* ignore cleanup errors */ }
    await client.stop();
  });

  describe('start_browser', () => {
    after(async () => {
      try { await client.callTool('close_session'); } catch { /* ignore */ }
    });

    it('should start a headless Chrome session', async () => {
      const result = await client.callTool('start_browser', {
        browser: 'chrome',
        options: { headless: true, arguments: ['--no-sandbox', '--disable-dev-shm-usage'] },
      });
      const text = getResponseText(result);
      assert.ok(text.includes('Browser started'), `Expected "Browser started", got: ${text}`);
      assert.ok(text.includes('session_id:'), `Expected session_id in response, got: ${text}`);
    });
  });

  describe('close_session', () => {
    it('should close an active session', async () => {
      await client.callTool('start_browser', {
        browser: 'chrome',
        options: { headless: true, arguments: ['--no-sandbox'] },
      });

      const result = await client.callTool('close_session');
      const text = getResponseText(result);
      assert.ok(text.includes('closed'), `Expected "closed" in response, got: ${text}`);
    });

    it('should error when no active session exists', async () => {
      const result = await client.callTool('close_session');
      assert.strictEqual(result.isError, true, 'Expected isError: true on error response');
      const text = getResponseText(result);
      assert.ok(
        text.includes('Error') || text.includes('No active'),
        `Expected error message, got: ${text}`
      );
    });
  });

  describe('take_screenshot', () => {
    before(async () => {
      await client.callTool('start_browser', {
        browser: 'chrome',
        options: { headless: true, arguments: ['--no-sandbox'] },
      });
      await client.callTool('navigate', { url: fixture('locators.html') });
    });

    after(async () => {
      try { await client.callTool('close_session'); } catch { /* ignore */ }
    });

    it('should capture a screenshot and return base64 image content', async () => {
      const result = await client.callTool('take_screenshot');
      assert.ok(result?.content?.length >= 1, 'Should return at least 1 content entry');
      const imageContent = result.content.find(c => c.type === 'image');
      assert.ok(imageContent, 'Should contain an image content entry');
      assert.strictEqual(imageContent.mimeType, 'image/png', 'Image mimeType should be image/png');
      assert.ok(imageContent.data.length > 100, `Expected base64 data, got ${imageContent.data.length} chars`);
    });
  });

  describe('multi-session', () => {
    it('should list, switch, and close sessions by ID', async () => {
      // Start first session
      const first = await client.callTool('start_browser', {
        browser: 'chrome',
        options: { headless: true, arguments: ['--no-sandbox'] },
      });
      const firstText = getResponseText(first);
      const firstId = firstText.match(/session_id: (\S+)/)?.[1];
      assert.ok(firstId, `Expected session_id, got: ${firstText}`);

      // Navigate in first session
      await client.callTool('navigate', { url: fixture('locators.html') });

      // Start second session — this should become the active one
      const second = await client.callTool('start_browser', {
        browser: 'chrome',
        options: { headless: true, arguments: ['--no-sandbox'] },
      });
      const secondText = getResponseText(second);
      const secondId = secondText.match(/session_id: (\S+)/)?.[1];
      assert.ok(secondId, `Expected session_id, got: ${secondText}`);
      assert.notEqual(firstId, secondId, 'Second session should have a different ID');

      // Navigate in second session to a different page
      await client.callTool('navigate', { url: fixture('interactions.html') });

      const listResult = await client.callTool('session', { action: 'list' });
      const listed = JSON.parse(getResponseText(listResult));
      assert.equal(listed.current_session_id, secondId);
      assert.deepEqual(
        listed.sessions.map((session) => session.session_id),
        [firstId, secondId]
      );
      assert.equal(listed.sessions.find((session) => session.session_id === firstId).active, false);
      assert.equal(listed.sessions.find((session) => session.session_id === secondId).active, true);

      // Switch to the first session and verify that its page state was preserved.
      const switchFirst = await client.callTool('session', { action: 'switch', session_id: firstId });
      assert.ok(getResponseText(switchFirst).includes(firstId));
      const firstPageText = await client.callTool('get_element_text', { by: 'id', value: 'title' });
      assert.equal(getResponseText(firstPageText), 'Heading One');

      // Switch back to the second session and verify its page state.
      await client.callTool('session', { action: 'switch', session_id: secondId });
      const secondPageText = await client.callTool('get_element_text', { by: 'id', value: 'text-content' });
      assert.equal(getResponseText(secondPageText), 'This is some text content');

      // Closing the active session should select the most recently opened remaining session.
      const closeSecond = await client.callTool('session', { action: 'close', session_id: secondId });
      assert.ok(getResponseText(closeSecond).includes(firstId));
      const afterClose = JSON.parse(getResponseText(
        await client.callTool('session', { action: 'list' })
      ));
      assert.equal(afterClose.current_session_id, firstId);
      assert.deepEqual(afterClose.sessions.map((session) => session.session_id), [firstId]);

      // The old close_session tool continues to close the active session.
      const closeFirst = await client.callTool('close_session');
      assert.ok(getResponseText(closeFirst).includes(firstId));
      const emptyList = JSON.parse(getResponseText(
        await client.callTool('session', { action: 'list' })
      ));
      assert.equal(emptyList.current_session_id, null);
      assert.deepEqual(emptyList.sessions, []);
    });
  });
});
