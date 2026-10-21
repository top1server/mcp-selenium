/**
 * MCP Server — connection, tool registration, and resource registration tests.
 * No browser needed for these.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpClient } from './mcp-client.mjs';

describe('MCP Server', () => {
  let client;
  let seleniumCacheDir;
  let previousCachePath;

  before(async () => {
    seleniumCacheDir = mkdtempSync(join(tmpdir(), 'mcp-selenium-cache-'));
    previousCachePath = process.env.SE_CACHE_PATH;
    process.env.SE_CACHE_PATH = seleniumCacheDir;

    const driverName = process.platform === 'win32' ? 'chromedriver.exe' : 'chromedriver';
    const cachedDriverPath = join(seleniumCacheDir, 'chromedriver', 'test-platform', 'test-version', driverName);
    mkdirSync(join(cachedDriverPath, '..'), { recursive: true });
    writeFileSync(cachedDriverPath, 'test driver fixture');
    if (process.platform !== 'win32') chmodSync(cachedDriverPath, 0o755);

    client = new McpClient();
    await client.start();
  });

  after(async () => {
    await client?.stop();
    if (previousCachePath === undefined) {
      delete process.env.SE_CACHE_PATH;
    } else {
      process.env.SE_CACHE_PATH = previousCachePath;
    }
    if (seleniumCacheDir) rmSync(seleniumCacheDir, { recursive: true, force: true });
  });

  it('should initialize with correct server info', async () => {
    // start() already initializes, so we just verify the client is usable
    const tools = await client.listTools();
    assert.ok(tools.length > 0, 'Server should have tools registered');
  });

  it('should register all expected tools', async () => {
    const tools = await client.listTools();
    const names = tools.map((t) => t.name);

    const expected = [
      'list_browser_drivers',
      'check_grid_status',
      'session',
      'start_browser',
      'navigate',
      'interact',
      'send_keys',
      'get_element_text',
      'press_key',
      'upload_file',
      'take_screenshot',
      'close_session',
      'get_element_attribute',
      'execute_script',
      'window',
      'frame',
      'alert',
      'add_cookie',
      'get_cookies',
      'delete_cookie',
      'diagnostics',
    ];

    for (const name of expected) {
      assert.ok(names.includes(name), `Missing tool: ${name}`);
    }

    assert.equal(names.length, expected.length, `Expected ${expected.length} tools, got ${names.length}: ${names.join(', ')}`);
  });

  it('should include descriptions for all tools', async () => {
    const tools = await client.listTools();
    for (const tool of tools) {
      assert.ok(
        tool.description && tool.description.length > 0,
        `Tool "${tool.name}" should have a description`
      );
    }
  });

  it('should include input schemas for all tools', async () => {
    const tools = await client.listTools();
    for (const tool of tools) {
      assert.ok(tool.inputSchema, `Tool "${tool.name}" should have an inputSchema`);
      assert.equal(tool.inputSchema.type, 'object', `Tool "${tool.name}" schema should be type object`);
    }
  });

  it('should report locally detected browser and driver executables', async () => {
    const result = await client.callTool('list_browser_drivers');
    assert.equal(result.isError, undefined);

    const data = JSON.parse(result.content[0].text);
    assert.equal(data.platform, process.platform);
    assert.ok(Array.isArray(data.browsers));
    assert.deepEqual(
      data.browsers.map((browser) => browser.browser),
      ['chrome', 'firefox', 'edge', 'safari', 'ie', 'edge_ie_mode']
    );
    const chrome = data.browsers.find((browser) => browser.browser === 'chrome');
    assert.ok(chrome.driverPaths.some((path) => path.includes('test-version')),
      'Should include a ChromeDriver found in the configured Selenium Manager cache');

    for (const browser of data.browsers) {
      assert.equal(browser.browserFound, browser.browserPaths.length > 0);
      assert.equal(browser.driverFound, browser.driverPaths.length > 0);
      assert.equal(typeof browser.available, 'boolean');
      assert.equal(typeof browser.supportedByMcp, 'boolean');
    }
  });

  it('should list an empty session state before any browser is started', async () => {
    const result = await client.callTool('session', { action: 'list' });
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text), {
      current_session_id: null,
      sessions: [],
    });
  });

  it('should register all expected resources', async () => {
    const resources = await client.listResources();
    const uris = resources.map((r) => r.uri);

    const expected = [
      'browser-status://current',
      'accessibility://current',
    ];

    for (const uri of expected) {
      assert.ok(uris.includes(uri), `Missing resource: ${uri}`);
    }

    assert.equal(uris.length, expected.length, `Expected ${expected.length} resources, got ${uris.length}: ${uris.join(', ')}`);
  });
});
