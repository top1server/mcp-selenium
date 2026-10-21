#!/usr/bin/env node

import { readFileSync } from 'fs';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import pkg from 'selenium-webdriver';
const { Builder, By, Key, until, Actions, error } = pkg;
import { Options as ChromeOptions } from 'selenium-webdriver/chrome.js';
import { Options as FirefoxOptions } from 'selenium-webdriver/firefox.js';
import { Options as EdgeOptions } from 'selenium-webdriver/edge.js';
import { Options as InternetExplorerOptions, ServiceBuilder as InternetExplorerServiceBuilder } from 'selenium-webdriver/ie.js';
import { Options as SafariOptions } from 'selenium-webdriver/safari.js';
import { discoverBrowserDrivers } from './browser-discovery.js';
import { displayGridUrl, resolveGridUrl } from './grid/url.js';
import { inspectGrid } from './grid/status.js';

// Create an MCP server
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { version } = require('../../package.json');

const server = new McpServer(
    { name: "MCP Selenium", version },
    { instructions: "To understand the current page state, read the accessibility://current resource. It provides a structured accessibility tree that's faster and more reliable for finding element locators." }
);

// BiDi imports — loaded dynamically to avoid hard failures if not available
let LogInspector, Network;
try {
    LogInspector = (await import('selenium-webdriver/bidi/logInspector.js')).default;
    const networkModule = await import('selenium-webdriver/bidi/network.js');
    Network = networkModule.Network;
} catch (_) {
    // BiDi modules not available in this selenium-webdriver version
    LogInspector = null;
    Network = null;
}

// Server state
const state = {
    drivers: new Map(),
    currentSession: null,
    sessionInfo: new Map(),
    bidi: new Map()
};

// Helper functions
const getDriver = () => {
    const driver = state.drivers.get(state.currentSession);
    if (!driver) {
        throw new Error('No active browser session');
    }
    return driver;
};

function activateMostRecentSession() {
    const sessionIds = [...state.drivers.keys()];
    state.currentSession = sessionIds.length > 0 ? sessionIds[sessionIds.length - 1] : null;
}

async function closeDriverSession(sessionId) {
    const driver = state.drivers.get(sessionId);
    if (!driver) {
        throw new Error(`Unknown browser session: ${sessionId}`);
    }

    try {
        await driver.quit();
    } finally {
        state.drivers.delete(sessionId);
        state.sessionInfo.delete(sessionId);
        state.bidi.delete(sessionId);
        if (state.currentSession === sessionId) {
            activateMostRecentSession();
        }
    }
}

const getLocator = (by, value) => {
    switch (by.toLowerCase()) {
        case 'id': return By.id(value);
        case 'css': return By.css(value);
        case 'xpath': return By.xpath(value);
        case 'name': return By.name(value);
        case 'tag': return By.tagName(value);
        case 'class': return By.className(value);
        default: throw new Error(`Unsupported locator strategy: ${by}`);
    }
};

// BiDi helpers
const newBidiState = () => ({
    available: false,
    consoleLogs: [],
    pageErrors: [],
    networkLogs: []
});

async function setupBidi(driver, sessionId) {
    const bidi = newBidiState();

    const logInspector = await LogInspector(driver);
    await logInspector.onConsoleEntry((entry) => {
        try {
            bidi.consoleLogs.push({
                level: entry.level, text: entry.text, timestamp: entry.timestamp,
                type: entry.type, method: entry.method, args: entry.args
            });
        } catch (_) { /* ignore malformed entry */ }
    });
    await logInspector.onJavascriptLog((entry) => {
        try {
            bidi.pageErrors.push({
                level: entry.level, text: entry.text, timestamp: entry.timestamp,
                type: entry.type, stackTrace: entry.stackTrace
            });
        } catch (_) { /* ignore malformed entry */ }
    });

    const network = await Network(driver);
    await network.responseCompleted((event) => {
        try {
            bidi.networkLogs.push({
                type: 'response', url: event.request?.url, status: event.response?.status,
                method: event.request?.method, mimeType: event.response?.mimeType, timestamp: Date.now()
            });
        } catch (_) { /* ignore malformed event */ }
    });
    await network.fetchError((event) => {
        try {
            bidi.networkLogs.push({
                type: 'error', url: event.request?.url, method: event.request?.method,
                errorText: event.errorText, timestamp: Date.now()
            });
        } catch (_) { /* ignore malformed event */ }
    });

    bidi.available = true;
    state.bidi.set(sessionId, bidi);
}

// Browser-side script loaded from file and executed via WebDriver's executeScript.
const accessibilitySnapshotScript = readFileSync(
    new URL('./accessibility-snapshot.js', import.meta.url), 'utf-8'
);

// Common schemas
const browserOptionsSchema = z.object({
    headless: z.boolean().optional().describe("Run browser in headless mode"),
    arguments: z.array(z.string()).optional().describe("Additional browser arguments")
}).optional();
const browserCapabilitiesSchema = z.record(z.string(), z.unknown()).optional()
    .describe("Additional WebDriver capabilities for browser or Selenium Grid node selection");

const locatorSchema = {
    by: z.enum(["id", "css", "xpath", "name", "tag", "class"]).describe("Locator strategy to find element"),
    value: z.string().describe("Value for the locator strategy"),
    timeout: z.number().optional().describe("Maximum time to wait for element in milliseconds")
};

// Browser Management Tools
server.registerTool(
    "list_browser_drivers",
    {
        description: "Lists browser and driver executables found on the machine running this MCP server. It does not inspect remote Selenium Grid nodes.",
        inputSchema: {}
    },
    async () => {
        try {
            const result = {
                platform: process.platform,
                browsers: discoverBrowserDrivers(),
            };
            return {
                content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
            };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error listing browser drivers: ${e.message}` }],
                isError: true
            };
        }
    }
);

server.registerTool(
    "check_grid_status",
    {
        description: "Checks Selenium Grid readiness and reports node, slot, session, capacity, and queue details. Uses grid_url or SELENIUM_GRID_URL. Grid GraphQL details are included when available.",
        inputSchema: {
            grid_url: z.string().optional().describe("Selenium Grid base URL, such as http://127.0.0.1:4444; defaults to SELENIUM_GRID_URL"),
            timeout_ms: z.number().int().min(1000).max(30000).optional().describe("Timeout for each Grid status request in milliseconds (default 5000)")
        }
    },
    async ({ grid_url, timeout_ms }) => {
        try {
            const result = await inspectGrid(grid_url, { timeoutMs: timeout_ms ?? 5000 });
            return {
                content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
            };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error checking Selenium Grid: ${e.message}` }],
                isError: true
            };
        }
    }
);

server.registerTool(
    "start_browser",
    {
        description: "launches browser",
        inputSchema: {
            browser: z.enum(["chrome", "firefox", "edge", "ie", "edge_ie_mode", "safari"]).describe("Browser to launch (chrome, firefox, edge, ie, edge_ie_mode, or safari)"),
            options: browserOptionsSchema,
            grid_url: z.string().optional().describe("Selenium Grid URL for remote execution; defaults to SELENIUM_GRID_URL. Omit to start a local browser."),
            browser_version: z.string().optional().describe("Requested browserVersion capability for Selenium Grid node matching"),
            platform_name: z.string().optional().describe("Requested platformName capability for Selenium Grid node matching"),
            capabilities: browserCapabilitiesSchema
        }
    },
    async ({ browser, options = {}, grid_url, browser_version, platform_name, capabilities = {} }) => {
        let remoteGridUrl = null;
        try {
            let builder = new Builder();
            let driver;
            let warnings = [];
            remoteGridUrl = resolveGridUrl(grid_url, { required: false });

            if (remoteGridUrl) {
                builder = builder.usingServer(remoteGridUrl);
            }

            // Enable BiDi websocket if the modules are available
            if (LogInspector && Network && !['ie', 'edge_ie_mode'].includes(browser)) {
                // 'ignore' prevents BiDi from auto-dismissing alert/confirm/prompt dialogs,
                // allowing the alert tool's accept, dismiss, and get_text actions to work as expected.
                builder = builder.withCapabilities({ 'webSocketUrl': true, 'unhandledPromptBehavior': 'ignore' });
            }

            const applyRequestedCapabilities = (browserOptions) => {
                if (browser_version) browserOptions.setBrowserVersion(browser_version);
                if (platform_name) browserOptions.setCapability('platformName', platform_name);
                const protectedCapabilities = new Set(['browserName', 'browserVersion', 'platformName', 'webSocketUrl']);
                for (const [name, value] of Object.entries(capabilities)) {
                    if (protectedCapabilities.has(name)) {
                        throw new Error(`Capability ${name} is controlled by start_browser parameters`);
                    }
                    browserOptions.setCapability(name, value);
                }
                return browserOptions;
            };

            switch (browser) {
                case 'chrome': {
                    const chromeOptions = applyRequestedCapabilities(new ChromeOptions());
                    if (options.headless) {
                        chromeOptions.addArguments('--headless=new');
                    }
                    if (options.arguments) {
                        options.arguments.forEach(arg => chromeOptions.addArguments(arg));
                    }
                    driver = await builder
                        .forBrowser('chrome')
                        .setChromeOptions(chromeOptions)
                        .build();
                    break;
                }
                case 'edge': {
                    const edgeOptions = applyRequestedCapabilities(new EdgeOptions());
                    if (options.headless) {
                        edgeOptions.addArguments('--headless=new');
                    }
                    if (options.arguments) {
                        options.arguments.forEach(arg => edgeOptions.addArguments(arg));
                    }
                    driver = await builder
                        .forBrowser('edge')
                        .setEdgeOptions(edgeOptions)
                        .build();
                    break;
                }
                case 'ie': {
                    if (!remoteGridUrl && process.platform !== 'win32') {
                        throw new Error('Internet Explorer can only run locally on Windows.');
                    }

                    const ieOptions = applyRequestedCapabilities(new InternetExplorerOptions());
                    if (!remoteGridUrl) {
                        const ieBrowser = discoverBrowserDrivers().find((item) => item.browser === 'ie');
                        const iePath = ieBrowser?.browserPaths[0];
                        const ieDriverPath = ieBrowser?.driverPaths[0];
                        if (!iePath) {
                            throw new Error('Internet Explorer was not found in the standard install locations or PATH.');
                        }
                        if (!ieDriverPath) {
                            throw new Error('IEDriverServer.exe was not found. Install IEDriver 4.0.0.0 or newer and add it to PATH.');
                        }
                        builder = builder.setIeService(new InternetExplorerServiceBuilder(ieDriverPath));
                    }

                    if (options.headless) {
                        warnings.push('Internet Explorer does not support headless mode — launching with a visible window.');
                    }
                    if (options.arguments?.length) {
                        warnings.push('Internet Explorer does not support custom browser arguments through this tool — ignoring.');
                    }

                    driver = await builder
                        .forBrowser('ie')
                        .setIeOptions(ieOptions)
                        .build();
                    warnings.push('WebDriver BiDi diagnostics are unavailable for Internet Explorer.');
                    warnings.push('Selenium ended official support for standalone Internet Explorer in June 2022; this launch is best-effort.');
                    break;
                }
                case 'edge_ie_mode': {
                    if (!remoteGridUrl && process.platform !== 'win32') {
                        throw new Error('Edge IE mode can only run locally on Windows.');
                    }

                    const ieOptions = applyRequestedCapabilities(new InternetExplorerOptions());
                    ieOptions.setEdgeChromium(true);

                    if (!remoteGridUrl) {
                        const edgeIeMode = discoverBrowserDrivers().find((item) => item.browser === 'edge_ie_mode');
                        const edgePath = edgeIeMode?.browserPaths[0];
                        const ieDriverPath = edgeIeMode?.driverPaths[0];
                        if (!edgePath) {
                            throw new Error('Microsoft Edge was not found in the standard install locations or PATH.');
                        }
                        if (!ieDriverPath) {
                            throw new Error('IEDriverServer.exe was not found. Install IEDriver 4.0.0.0 or newer and add it to PATH.');
                        }
                        ieOptions.setEdgePath(edgePath);
                        builder = builder.setIeService(new InternetExplorerServiceBuilder(ieDriverPath));
                    }

                    if (options.headless) {
                        warnings.push('Edge IE mode does not support headless mode — launching with a visible window.');
                    }
                    if (options.arguments?.length) {
                        warnings.push('Edge IE mode does not support custom browser arguments — ignoring.');
                    }

                    driver = await builder
                        .forBrowser('ie')
                        .setIeOptions(ieOptions)
                        .build();
                    warnings.push('WebDriver BiDi diagnostics are unavailable in Edge IE mode.');
                    break;
                }
                case 'firefox': {
                    const firefoxOptions = applyRequestedCapabilities(new FirefoxOptions());
                    if (options.headless) {
                        firefoxOptions.addArguments('--headless');
                    }
                    if (options.arguments) {
                        options.arguments.forEach(arg => firefoxOptions.addArguments(arg));
                    }
                    driver = await builder
                        .forBrowser('firefox')
                        .setFirefoxOptions(firefoxOptions)
                        .build();
                    break;
                }
                case 'safari': {
                    const safariOptions = applyRequestedCapabilities(new SafariOptions());
                    if (options.headless) {
                        warnings.push('Safari does not support headless mode — launching with visible window.');
                    }
                    if (options.arguments?.length) {
                        warnings.push('Safari does not support custom arguments — ignoring.');
                    }
                    driver = await builder
                        .forBrowser('safari')
                        .setSafariOptions(safariOptions)
                        .build();
                    break;
                }
                default: {
                    throw new Error(`Unsupported browser: ${browser}`);
                }
            }
            const sessionId = `${browser}_${Date.now()}`;
            let webdriverSessionId = null;
            let actualBrowserVersion = browser_version ?? null;
            let actualPlatformName = platform_name ?? null;
            if (remoteGridUrl) {
                try {
                    const webdriverSession = await driver.getSession();
                    webdriverSessionId = String(webdriverSession.getId());
                    const negotiatedCapabilities = webdriverSession.getCapabilities();
                    actualBrowserVersion = negotiatedCapabilities.getBrowserVersion() ?? actualBrowserVersion;
                    actualPlatformName = negotiatedCapabilities.getPlatform() ?? actualPlatformName;
                } catch (_) {
                    // Retain the live driver even if the remote session ID cannot be queried.
                }
            }
            state.drivers.set(sessionId, driver);
            state.sessionInfo.set(sessionId, {
                browser,
                createdAt: new Date().toISOString(),
                connection: remoteGridUrl ? 'grid' : 'local',
                gridUrl: remoteGridUrl,
                webdriverSessionId,
                browserVersion: actualBrowserVersion,
                platformName: actualPlatformName
            });
            state.currentSession = sessionId;

            // Attempt to enable BiDi for real-time log capture
            if (LogInspector && Network && !['ie', 'edge_ie_mode'].includes(browser)) {
                try {
                    await setupBidi(driver, sessionId);
                } catch (_) {
                    // BiDi not supported by this browser/driver — continue without it
                }
            }

            let message = `Browser started with session_id: ${sessionId}`;
            if (remoteGridUrl) {
                message += `\nConnection: Selenium Grid (${displayGridUrl(remoteGridUrl)})`;
                if (webdriverSessionId) message += `\nWebDriver session ID: ${webdriverSessionId}`;
                if (actualBrowserVersion) message += `\nBrowser version: ${actualBrowserVersion}`;
                if (actualPlatformName) message += `\nPlatform: ${actualPlatformName}`;
            }
            if (state.bidi.get(sessionId)?.available) {
                message += ' (BiDi enabled: console logs, JS errors, and network activity are being captured)';
            }
            if (warnings.length > 0) {
                message += `\nWarnings: ${warnings.join(' ')}`;
            }

            return {
                content: [{ type: 'text', text: message }]
            };
        } catch (e) {
            return {
                content: [{
                    type: 'text',
                    text: remoteGridUrl
                        ? `Error starting remote browser through Selenium Grid at ${displayGridUrl(remoteGridUrl)}: ${e.message}`
                        : `Error starting browser: ${e.message}`
                }],
                isError: true
            };
        }
    }
);

server.registerTool(
    "navigate",
    {
        description: "navigates to a URL",
        inputSchema: {
        url: z.string().describe("URL to navigate to")
    }
    },
    async ({ url }) => {
        try {
            const driver = getDriver();
            await driver.get(url);
            return {
                content: [{ type: 'text', text: `Navigated to ${url}` }]
            };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error navigating: ${e.message}` }],
                isError: true
            };
        }
    }
);

// Element Interaction Tools
server.registerTool(
    "interact",
    {
        description: "performs a mouse action on an element",
        inputSchema: {
        action: z.enum(["click", "doubleclick", "rightclick", "hover"]).describe("Mouse action to perform"),
        ...locatorSchema
    }
    },
    async ({ action, by, value, timeout = 10000 }) => {
        try {
            const driver = getDriver();
            const locator = getLocator(by, value);
            const element = await driver.wait(until.elementLocated(locator), timeout);

            switch (action) {
                case 'click':
                    await element.click();
                    return { content: [{ type: 'text', text: 'Element clicked' }] };
                case 'doubleclick': {
                    const dblActions = driver.actions({ bridge: true });
                    await dblActions.doubleClick(element).perform();
                    return { content: [{ type: 'text', text: 'Double click performed' }] };
                }
                case 'rightclick': {
                    const ctxActions = driver.actions({ bridge: true });
                    await ctxActions.contextClick(element).perform();
                    return { content: [{ type: 'text', text: 'Right click performed' }] };
                }
                case 'hover': {
                    const hoverActions = driver.actions({ bridge: true });
                    await hoverActions.move({ origin: element }).perform();
                    return { content: [{ type: 'text', text: 'Hovered over element' }] };
                }
                default:
                    return { content: [{ type: 'text', text: `Unknown action: ${action}` }], isError: true };
            }
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error performing ${action}: ${e.message}` }],
                isError: true
            };
        }
    }
);

server.registerTool(
    "send_keys",
    {
        description: "sends keys to an element, aka typing. Clears the field first.",
        inputSchema: {
        ...locatorSchema,
        text: z.string().describe("Text to enter into the element")
    }
    },
    async ({ by, value, text, timeout = 10000 }) => {
        try {
            const driver = getDriver();
            const locator = getLocator(by, value);
            const element = await driver.wait(until.elementLocated(locator), timeout);
            await element.clear();
            await element.sendKeys(text);
            return {
                content: [{ type: 'text', text: `Text "${text}" entered into element` }]
            };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error entering text: ${e.message}` }],
                isError: true
            };
        }
    }
);

server.registerTool(
    "get_element_text",
    {
        description: "gets the text content of an element",
        inputSchema: {
        ...locatorSchema
    }
    },
    async ({ by, value, timeout = 10000 }) => {
        try {
            const driver = getDriver();
            const locator = getLocator(by, value);
            const element = await driver.wait(until.elementLocated(locator), timeout);
            const text = await element.getText();
            return {
                content: [{ type: 'text', text }]
            };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error getting element text: ${e.message}` }],
                isError: true
            };
        }
    }
);

server.registerTool(
    "press_key",
    {
        description: "simulates pressing a keyboard key",
        inputSchema: {
        key: z.string().describe("Key to press (e.g., 'Enter', 'Tab', 'a', etc.)")
    }
    },
    async ({ key }) => {
        try {
            const driver = getDriver();
            const resolvedKey = key.length === 1
                ? key
                : Key[key.toUpperCase().replace(/ /g, '_')] ?? null;
            if (resolvedKey === null) {
                return {
                    content: [{ type: 'text', text: `Error pressing key: Unknown key name '${key}'. Use a single character or a named key like 'Enter', 'Tab', 'Escape', etc.` }],
                    isError: true
                };
            }
            const actions = driver.actions({ bridge: true });
            await actions.keyDown(resolvedKey).keyUp(resolvedKey).perform();
            return {
                content: [{ type: 'text', text: `Key '${key}' pressed` }]
            };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error pressing key: ${e.message}` }],
                isError: true
            };
        }
    }
);

server.registerTool(
    "upload_file",
    {
        description: "uploads a file using a file input element",
        inputSchema: {
        ...locatorSchema,
        filePath: z.string().describe("Absolute path to the file to upload")
    }
    },
    async ({ by, value, filePath, timeout = 10000 }) => {
        try {
            const driver = getDriver();
            const locator = getLocator(by, value);
            const element = await driver.wait(until.elementLocated(locator), timeout);
            await element.sendKeys(filePath);
            return {
                content: [{ type: 'text', text: 'File upload initiated' }]
            };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error uploading file: ${e.message}` }],
                isError: true
            };
        }
    }
);

server.registerTool(
    "take_screenshot",
    {
        description: "captures a screenshot of the current page. Prefer using the accessibility://current resource for understanding page content. Use get_element_text, get_element_attribute, or execute_script to verify element state. Only use screenshots when visual layout or styling needs to be verified.",
        inputSchema: {
        outputPath: z.string().optional().describe("Optional path where to save the screenshot. If not provided, returns an image/png content block.")
    }
    },
    async ({ outputPath }) => {
        try {
            const driver = getDriver();
            const screenshot = await driver.takeScreenshot();
            if (outputPath) {
                const fs = await import('fs');
                await fs.promises.writeFile(outputPath, screenshot, 'base64');
                return {
                    content: [{ type: 'text', text: `Screenshot saved to ${outputPath}` }]
                };
            } else {
                return {
                    content: [
                        { type: 'image', data: screenshot, mimeType: 'image/png' }
                    ]
                };
            }
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error taking screenshot: ${e.message}` }],
                isError: true
            };
        }
    }
);

server.registerTool(
    "close_session",
    {
        description: "closes the current browser session",
        inputSchema: {}
    },
    async () => {
        try {
            const sessionId = state.currentSession;
            if (!sessionId) throw new Error('No active browser session');
            await closeDriverSession(sessionId);
            return {
                content: [{
                    type: 'text',
                    text: `Browser session ${sessionId} closed${state.currentSession ? `. Active session: ${state.currentSession}` : ''}`
                }]
            };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error closing session: ${e.message}` }],
                isError: true
            };
        }
    }
);

server.registerTool(
    "session",
    {
        description: "Lists browser sessions, switches the active session, or closes a specific session by session_id.",
        inputSchema: {
            action: z.enum(["list", "switch", "close"]).describe("Session action to perform"),
            session_id: z.string().optional().describe("Session ID; required for switch and close")
        }
    },
    async ({ action, session_id }) => {
        try {
            switch (action) {
                case 'list': {
                    const sessions = [...state.drivers.keys()].map((id) => ({
                        session_id: id,
                        browser: state.sessionInfo.get(id)?.browser ?? null,
                        created_at: state.sessionInfo.get(id)?.createdAt ?? null,
                        connection: state.sessionInfo.get(id)?.connection ?? 'local',
                        grid_url: state.sessionInfo.get(id)?.gridUrl ?? null,
                        webdriver_session_id: state.sessionInfo.get(id)?.webdriverSessionId ?? null,
                        browser_version: state.sessionInfo.get(id)?.browserVersion ?? null,
                        platform_name: state.sessionInfo.get(id)?.platformName ?? null,
                        active: id === state.currentSession,
                    }));
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                current_session_id: state.currentSession,
                                sessions,
                            }, null, 2)
                        }]
                    };
                }
                case 'switch': {
                    if (!session_id) throw new Error('session_id is required for switch action');
                    if (!state.drivers.has(session_id)) {
                        throw new Error(`Unknown browser session: ${session_id}`);
                    }
                    state.currentSession = session_id;
                    return {
                        content: [{ type: 'text', text: `Active browser session: ${session_id}` }]
                    };
                }
                case 'close': {
                    if (!session_id) throw new Error('session_id is required for close action');
                    await closeDriverSession(session_id);
                    return {
                        content: [{
                            type: 'text',
                            text: `Browser session ${session_id} closed${state.currentSession ? `. Active session: ${state.currentSession}` : ''}`
                        }]
                    };
                }
                default:
                    throw new Error(`Unsupported session action: ${action}`);
            }
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error managing session: ${e.message}` }],
                isError: true
            };
        }
    }
);

// Element Utility Tools
server.registerTool(
    "get_element_attribute",
    {
        description: "gets the value of an attribute on an element. Use this to verify element state. Prefer this over screenshots for validation.",
        inputSchema: {
        ...locatorSchema,
        attribute: z.string().describe("Name of the attribute to get (e.g., 'href', 'value', 'class')")
    }
    },
    async ({ by, value, attribute, timeout = 10000 }) => {
        try {
            const driver = getDriver();
            const locator = getLocator(by, value);
            const element = await driver.wait(until.elementLocated(locator), timeout);
            const attrValue = await element.getAttribute(attribute);
            return {
                content: [{ type: 'text', text: attrValue !== null ? attrValue : '' }]
            };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error getting attribute: ${e.message}` }],
                isError: true
            };
        }
    }
);

server.registerTool(
    "execute_script",
    {
        description: "executes JavaScript in the browser and returns the result. Use for advanced interactions not covered by other tools (e.g., drag and drop, scrolling, reading computed styles, manipulating the DOM directly). Also useful for batch-reading multiple element values/states in a single call instead of multiple get_element_attribute calls.",
        inputSchema: {
        script: z.string().describe("JavaScript code to execute in the browser"),
        args: z.array(z.any()).optional().describe("Optional arguments to pass to the script (accessible via arguments[0], arguments[1], etc.)")
    }
    },
    async ({ script, args = [] }) => {
        try {
            const driver = getDriver();
            const result = await driver.executeScript(script, ...args);
            const text = result === undefined || result === null
                ? 'Script executed (no return value)'
                : typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result);
            return {
                content: [{ type: 'text', text }]
            };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error executing script: ${e.message}` }],
                isError: true
            };
        }
    }
);

// Window/Tab Management
server.registerTool(
    "window",
    {
        description: "manages browser windows and tabs",
        inputSchema: {
        action: z.enum(["list", "switch", "switch_latest", "close"]).describe("Window action to perform"),
        handle: z.string().optional().describe("Window handle (required for switch)")
    }
    },
    async ({ action, handle }) => {
        try {
            const driver = getDriver();
            switch (action) {
                case 'list': {
                    const handles = await driver.getAllWindowHandles();
                    const current = await driver.getWindowHandle();
                    return { content: [{ type: 'text', text: JSON.stringify({ current, all: handles }, null, 2) }] };
                }
                case 'switch': {
                    if (!handle) throw new Error('handle is required for switch action');
                    await driver.switchTo().window(handle);
                    return { content: [{ type: 'text', text: `Switched to window: ${handle}` }] };
                }
                case 'switch_latest': {
                    const handles = await driver.getAllWindowHandles();
                    if (handles.length === 0) throw new Error('No windows available');
                    const latest = handles[handles.length - 1];
                    await driver.switchTo().window(latest);
                    return { content: [{ type: 'text', text: `Switched to latest window: ${latest}` }] };
                }
                case 'close': {
                    await driver.close();
                    let handles = [];
                    try { handles = await driver.getAllWindowHandles(); } catch (_) { /* session gone */ }
                    if (handles.length > 0) {
                        await driver.switchTo().window(handles[0]);
                        return { content: [{ type: 'text', text: `Window closed. Switched to: ${handles[0]}` }] };
                    }
                    const sessionId = state.currentSession;
                    try {
                        await closeDriverSession(sessionId);
                    } catch (_) { /* the window may already have ended the session */ }
                    return {
                        content: [{
                            type: 'text',
                            text: `Last window closed. Session ${sessionId} ended.${state.currentSession ? ` Active session: ${state.currentSession}` : ''}`
                        }]
                    };
                }
                default:
                    return { content: [{ type: 'text', text: `Unknown action: ${action}` }], isError: true };
            }
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error in window ${action}: ${e.message}` }],
                isError: true
            };
        }
    }
);

// Frame Management
server.registerTool(
    "frame",
    {
        description: "switches focus to a frame or back to the main page",
        inputSchema: {
        action: z.enum(["switch", "default"]).describe("Frame action to perform"),
        by: z.enum(["id", "css", "xpath", "name", "tag", "class"]).optional().describe("Locator strategy for frame element"),
        value: z.string().optional().describe("Value for the locator strategy"),
        index: z.number().optional().describe("Frame index (0-based)"),
        timeout: z.number().optional().describe("Max wait in ms")
    }
    },
    async ({ action, by, value, index, timeout = 10000 }) => {
        try {
            const driver = getDriver();
            if (action === 'default') {
                await driver.switchTo().defaultContent();
                return { content: [{ type: 'text', text: 'Switched to default content' }] };
            }
            // action === 'switch'
            if (index !== undefined) {
                await driver.switchTo().frame(index);
            } else if (by && value) {
                const locator = getLocator(by, value);
                const element = await driver.wait(until.elementLocated(locator), timeout);
                await driver.switchTo().frame(element);
            } else {
                throw new Error('Provide either by/value to locate frame, or index to switch by position');
            }
            return { content: [{ type: 'text', text: 'Switched to frame' }] };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error in frame ${action}: ${e.message}` }],
                isError: true
            };
        }
    }
);

// Alert/Dialog Handling
server.registerTool(
    "alert",
    {
        description: "handles a browser alert, confirm, or prompt dialog",
        inputSchema: {
        action: z.enum(["accept", "dismiss", "get_text", "send_text"]).describe("Action to perform on the alert"),
        text: z.string().optional().describe("Text to send (required for send_text)"),
        timeout: z.number().optional().describe("Max wait in ms")
    }
    },
    async ({ action, text, timeout = 5000 }) => {
        try {
            const driver = getDriver();
            await driver.wait(until.alertIsPresent(), timeout);
            const alertObj = await driver.switchTo().alert();
            switch (action) {
                case 'accept':
                    await alertObj.accept();
                    return { content: [{ type: 'text', text: 'Alert accepted' }] };
                case 'dismiss':
                    await alertObj.dismiss();
                    return { content: [{ type: 'text', text: 'Alert dismissed' }] };
                case 'get_text': {
                    const alertText = await alertObj.getText();
                    return { content: [{ type: 'text', text: alertText }] };
                }
                case 'send_text': {
                    if (text === undefined) throw new Error('text is required for send_text action');
                    await alertObj.sendKeys(text);
                    await alertObj.accept();
                    return { content: [{ type: 'text', text: `Text "${text}" sent to prompt and accepted` }] };
                }
                default:
                    return { content: [{ type: 'text', text: `Unknown action: ${action}` }], isError: true };
            }
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error in alert ${action}: ${e.message}` }],
                isError: true
            };
        }
    }
);


// Cookie Management Tools
server.registerTool(
    "add_cookie",
    {
        description: "adds a cookie to the current browser session. The browser must be on a page from the cookie's domain before setting it.",
        inputSchema: {
        name: z.string().describe("Name of the cookie"),
        value: z.string().describe("Value of the cookie"),
        domain: z.string().optional().describe("Domain the cookie is visible to"),
        path: z.string().optional().describe("Path the cookie is visible to"),
        secure: z.boolean().optional().describe("Whether the cookie is a secure cookie"),
        httpOnly: z.boolean().optional().describe("Whether the cookie is HTTP only"),
        expiry: z.number().optional().describe("Expiry date of the cookie as a Unix timestamp (seconds since epoch)")
    }
    },
    async ({ name, value, domain, path, secure, httpOnly, expiry }) => {
        try {
            const driver = getDriver();
            const cookie = { name, value };
            if (domain !== undefined) cookie.domain = domain;
            if (path !== undefined) cookie.path = path;
            if (secure !== undefined) cookie.secure = secure;
            if (httpOnly !== undefined) cookie.httpOnly = httpOnly;
            if (expiry !== undefined) cookie.expiry = expiry;
            await driver.manage().addCookie(cookie);
            return {
                content: [{ type: 'text', text: `Cookie "${name}" added` }]
            };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error adding cookie: ${e.message}` }],
                isError: true
            };
        }
    }
);

server.registerTool(
    "get_cookies",
    {
        description: "retrieves cookies from the current browser session. Returns all cookies or a specific cookie by name.",
        inputSchema: {
        name: z.string().optional().describe("Name of a specific cookie to retrieve. If omitted, all cookies are returned.")
    }
    },
    async ({ name }) => {
        try {
            const driver = getDriver();
            if (name) {
                try {
                    const cookie = await driver.manage().getCookie(name);
                    if (!cookie) {
                        return {
                            content: [{ type: 'text', text: `Cookie "${name}" not found` }],
                            isError: true
                        };
                    }
                    return {
                        content: [{ type: 'text', text: JSON.stringify(cookie, null, 2) }]
                    };
                } catch (cookieError) {
                    if (cookieError instanceof error.NoSuchCookieError) {
                        return {
                            content: [{ type: 'text', text: `Cookie "${name}" not found` }],
                            isError: true
                        };
                    }
                    throw cookieError;
                }
            } else {
                const cookies = await driver.manage().getCookies();
                return {
                    content: [{ type: 'text', text: JSON.stringify(cookies, null, 2) }]
                };
            }
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error getting cookies: ${e.message}` }],
                isError: true
            };
        }
    }
);

server.registerTool(
    "delete_cookie",
    {
        description: "deletes cookies from the current browser session. Can delete a specific cookie by name or all cookies.",
        inputSchema: {
        name: z.string().optional().describe("Name of the cookie to delete. If omitted, all cookies are deleted.")
    }
    },
    async ({ name }) => {
        try {
            const driver = getDriver();
            if (name) {
                await driver.manage().deleteCookie(name);
                return {
                    content: [{ type: 'text', text: `Cookie "${name}" deleted` }]
                };
            } else {
                await driver.manage().deleteAllCookies();
                return {
                    content: [{ type: 'text', text: 'All cookies deleted' }]
                };
            }
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error deleting cookie: ${e.message}` }],
                isError: true
            };
        }
    }
);

// BiDi Diagnostic Tools
const diagnosticTypes = {
    console:  { logKey: 'consoleLogs', emptyMessage: 'No console logs captured' },
    errors:   { logKey: 'pageErrors',  emptyMessage: 'No page errors captured' },
    network:  { logKey: 'networkLogs', emptyMessage: 'No network activity captured' }
};

server.registerTool(
    "diagnostics",
    {
        description: "retrieves browser diagnostics (console logs, JS errors, or network activity) captured via WebDriver BiDi",
        inputSchema: {
        type: z.enum(["console", "errors", "network"]).describe("Type of diagnostic data to retrieve"),
        clear: z.boolean().optional().describe("Clear after returning (default: false)")
    }
    },
    async ({ type, clear = false }) => {
        try {
            getDriver();
            const bidi = state.bidi.get(state.currentSession);
            if (!bidi?.available) {
                return { content: [{ type: 'text', text: 'Diagnostics not available (BiDi not supported by this browser/driver)' }] };
            }
            const { logKey, emptyMessage } = diagnosticTypes[type];
            const logs = bidi[logKey];
            const result = logs.length === 0 ? emptyMessage : JSON.stringify(logs, null, 2);
            if (clear) bidi[logKey] = [];
            return { content: [{ type: 'text', text: result }] };
        } catch (e) {
            return {
                content: [{ type: 'text', text: `Error getting diagnostics: ${e.message}` }],
                isError: true
            };
        }
    }
);

// Resources
server.registerResource(
    "browser-status",
    "browser-status://current",
    {
        description: "Current browser session status",
        mimeType: "text/plain"
    },
    async (uri) => ({
        contents: [{
            uri: uri.href,
            mimeType: "text/plain",
            text: state.currentSession
                ? `Active browser session: ${state.currentSession}`
                : "No active browser session"
        }]
    })
);

server.registerResource(
    "accessibility-snapshot",
    "accessibility://current",
    {
        description: "Accessibility tree snapshot of the current page. A compact, structured representation of interactive elements and text content, much smaller than full HTML. Useful for understanding page layout and finding elements to interact with.",
        mimeType: "application/json"
    },
    async (uri) => {
        try {
            const driver = state.drivers.get(state.currentSession);
            //-32002 is not in the SDK but is noted in the MCP specification: 
            // https://modelcontextprotocol.io/specification/2025-11-25/server/resources#error-handling
            if (!driver) throw new McpError(-32002, "No active browser session. Start a browser first.");
            const tree = await driver.executeScript(accessibilitySnapshotScript) || {};
            return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(tree, null, 2) }] };
        } catch (e) {
            if (e instanceof McpError) throw e;
            throw new McpError(ErrorCode.InternalError, `Failed to capture accessibility snapshot: ${e.message}`);
        }
    }
);

// Cleanup handler
async function cleanup() {
    for (const [sessionId, driver] of state.drivers) {
        try {
            await driver.quit();
        } catch (e) {
            console.error(`Error closing browser session ${sessionId}:`, e);
        }
    }
    state.drivers.clear();
    state.sessionInfo.clear();
    state.bidi.clear();
    state.currentSession = null;
    process.exit(0);
}

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);
