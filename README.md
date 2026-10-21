# MCP Selenium Server

A Model Context Protocol (MCP) server for Selenium WebDriver — browser automation for AI agents.

[![Watch the video](https://img.youtube.com/vi/mRV0N8hcgYA/sddefault.jpg)](https://youtu.be/mRV0N8hcgYA)

<a href="https://glama.ai/mcp/servers/@angiejones/mcp-selenium">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@angiejones/mcp-selenium/badge" alt="Selenium MCP server" />
</a>

## Setup

<details open>
<summary><strong>Goose (Desktop)</strong></summary>

Paste into your browser address bar:
```
goose://extension?cmd=npx&arg=-y&arg=%40angiejones%2Fmcp-selenium%40latest&id=selenium-mcp&name=Selenium%20MCP&description=automates%20browser%20interactions
```
</details>

<details>
<summary><strong>Goose (CLI)</strong></summary>

```bash
goose session --with-extension "npx -y @angiejones/mcp-selenium@latest"
```
</details>

<details>
<summary><strong>Claude Code</strong></summary>

```bash
claude mcp add selenium -- npx -y @angiejones/mcp-selenium@latest
```
</details>

<details>
<summary><strong>Cursor / Windsurf / other MCP clients</strong></summary>

```json
{
  "mcpServers": {
    "selenium": {
      "command": "npx",
      "args": ["-y", "@angiejones/mcp-selenium@latest"]
    }
  }
}
```
</details>

## Example Usage

Tell the AI agent of your choice:

> Open Chrome, go to github.com/angiejones, and take a screenshot.

The agent will call Selenium's APIs to `start_browser`, `navigate`, and `take_screenshot`. No manual scripting or explicit directions needed.

## Supported Browsers

Chrome, Firefox, Edge, Internet Explorer (Windows, best-effort), Edge IE mode (Windows), and Safari.

Internet Explorer and Edge IE mode use Selenium's Internet Explorer Driver and require IEDriverServer 4.0.0.0 or newer on `PATH`. Edge IE mode also requires Microsoft Edge. Selenium ended official support for standalone IE in June 2022, so this MCP exposes it as best-effort compatibility only. The IE driver also requires matching Protected Mode settings for all security zones and 100% browser zoom; see Selenium's [IE driver requirements](https://www.selenium.dev/documentation/ie_driver_server/).

> **Safari note:** Requires macOS. Run `sudo safaridriver --enable` once and enable
> "Allow Remote Automation" in Safari → Settings → Developer. No headless mode.

---

<details>
<summary><strong>Tools</strong></summary>

### list_browser_drivers
Lists browser and driver executables found on the machine running the MCP server, including drivers in Selenium Manager's cache (`~/.cache/selenium` by default, or `SE_CACHE_PATH` when set). It does not inspect remote Selenium Grid nodes. `available` means the browser is installed locally and supported by this MCP server; Chrome, Firefox, and Edge may still work without a local driver because Selenium Manager can resolve one at startup. IE and Edge IE mode are available only on Windows when the required browser and IEDriverServer are detected.

No parameters.

### check_grid_status
Checks whether a Selenium Grid is reachable and ready. It reports Grid version, node details, slot counts, active sessions, available session capacity, and queue size when those details are exposed by the Grid. The `/graphql` endpoint is queried for richer details when available; `/status` remains the readiness source.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| grid_url | string | No | Grid base URL. Defaults to `SELENIUM_GRID_URL`. Accepts a root URL such as `http://127.0.0.1:4444`, a reverse-proxy base path, `/wd/hub`, or a pasted `/status` URL. |
| timeout_ms | number | No | Timeout per status request in milliseconds (default: 5000; range: 1000–30000). |

### start_browser
Launches a local browser session or requests a remote session from Selenium Grid. Set `SELENIUM_GRID_URL` to use Grid by default, or pass `grid_url` on a call. If the argument and environment variable are both absent, the browser starts locally.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| browser | string | Yes | `chrome`, `firefox`, `edge`, `ie`, `edge_ie_mode`, or `safari` |
| options | object | No | `{ headless: boolean, arguments: string[] }` |
| grid_url | string | No | Selenium Grid base URL; defaults to `SELENIUM_GRID_URL`. |
| browser_version | string | No | Requested `browserVersion` for Grid node matching. |
| platform_name | string | No | Requested `platformName` for Grid node matching. |
| capabilities | object | No | Additional WebDriver capabilities, including vendor capabilities such as `se:name`. `browserName`, `browserVersion`, `platformName`, and `webSocketUrl` are controlled by this tool. |

For `browser: "ie"` or `browser: "edge_ie_mode"`, run the MCP server on Windows and put IEDriverServer 4.0.0.0 or newer on `PATH`. Edge IE mode also requires Edge. Neither mode supports headless mode, custom browser arguments, or WebDriver BiDi diagnostics. When using Grid, configure the Windows node with the requested IE browser mode and IEDriver; `list_browser_drivers` only inventories the MCP host and does not inspect Grid nodes. Standalone IE is best-effort because Selenium ended its official support in June 2022.

Example Grid configuration:

```sh
export SELENIUM_GRID_URL=http://127.0.0.1:4444
```

Then call `check_grid_status` or `start_browser` with `browser: "chrome"`. Grid sessions run on a Grid node; screenshots and browser commands continue to go through the returned MCP session.

### navigate
Navigates to a URL.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| url | string | Yes | URL to navigate to |

### interact
Performs a mouse action on an element.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| action | string | Yes | `click`, `doubleclick`, `rightclick`, or `hover` |
| by | string | Yes | Locator strategy: `id`, `css`, `xpath`, `name`, `tag`, `class` |
| value | string | Yes | Value for the locator strategy |
| timeout | number | No | Max wait in ms (default: 10000) |

### send_keys
Types text into an element. Clears the field first.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| by | string | Yes | Locator strategy |
| value | string | Yes | Locator value |
| text | string | Yes | Text to enter |
| timeout | number | No | Max wait in ms (default: 10000) |

### get_element_text
Gets the text content of an element.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| by | string | Yes | Locator strategy |
| value | string | Yes | Locator value |
| timeout | number | No | Max wait in ms (default: 10000) |

### get_element_attribute
Gets an attribute value from an element.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| by | string | Yes | Locator strategy |
| value | string | Yes | Locator value |
| attribute | string | Yes | Attribute name (e.g., `href`, `value`, `class`) |
| timeout | number | No | Max wait in ms (default: 10000) |

### press_key
Presses a keyboard key.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| key | string | Yes | Key to press (e.g., `Enter`, `Tab`, `a`) |

### upload_file
Uploads a file via a file input element.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| by | string | Yes | Locator strategy |
| value | string | Yes | Locator value |
| filePath | string | Yes | Absolute path to the file |
| timeout | number | No | Max wait in ms (default: 10000) |

### take_screenshot
Captures a screenshot of the current page.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| outputPath | string | No | Save path. If omitted, returns base64 image data. |

### close_session
Closes the current browser session. If another session remains, it becomes active. No parameters.

### session
Lists browser sessions, switches the active session, or closes a specific session. Browser tools operate on the active session. For remote sessions, the list includes the Grid URL and the WebDriver session ID assigned by Grid.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| action | string | Yes | `list`, `switch`, or `close` |
| session_id | string | No | Required for `switch` and `close`; ignored for `list` |

### execute_script
Executes JavaScript in the browser. Use for advanced interactions not covered by other tools (e.g., drag and drop, scrolling, reading computed styles, DOM manipulation).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| script | string | Yes | JavaScript code to execute |
| args | array | No | Arguments accessible via `arguments[0]`, etc. |

### window
Manages browser windows and tabs.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| action | string | Yes | `list`, `switch`, `switch_latest`, or `close` |
| handle | string | No | Window handle (required for `switch`) |

### frame
Switches focus to a frame or back to the main page.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| action | string | Yes | `switch` or `default` |
| by | string | No | Locator strategy (for `switch`) |
| value | string | No | Locator value (for `switch`) |
| index | number | No | Frame index, 0-based (for `switch`) |
| timeout | number | No | Max wait in ms (default: 10000) |

### alert
Handles browser alert, confirm, or prompt dialogs.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| action | string | Yes | `accept`, `dismiss`, `get_text`, or `send_text` |
| text | string | No | Text to send (required for `send_text`) |
| timeout | number | No | Max wait in ms (default: 5000) |

### add_cookie
Adds a cookie. Browser must be on a page from the cookie's domain.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| name | string | Yes | Cookie name |
| value | string | Yes | Cookie value |
| domain | string | No | Cookie domain |
| path | string | No | Cookie path |
| secure | boolean | No | Secure flag |
| httpOnly | boolean | No | HTTP-only flag |
| expiry | number | No | Unix timestamp |

### get_cookies
Gets cookies. Returns all or a specific one by name.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| name | string | No | Cookie name. Omit for all cookies. |

### delete_cookie
Deletes cookies. Deletes all or a specific one by name.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| name | string | No | Cookie name. Omit to delete all. |

### diagnostics
Gets browser diagnostics captured via WebDriver BiDi (auto-enabled when supported).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| type | string | Yes | `console`, `errors`, or `network` |
| clear | boolean | No | Clear buffer after returning (default: false) |

</details>

<details>
<summary><strong>Resources</strong></summary>

MCP resources provide read-only data that clients can access without calling a tool.

### browser-status://current
Returns the current browser session status (active session ID or "no active session").

| Property | Value |
|----------|-------|
| MIME type | `text/plain` |
| Requires browser | No |

### accessibility://current
Returns an accessibility tree snapshot of the current page — a compact, structured JSON representation of interactive elements and text content. Much smaller than full HTML. Useful for understanding page layout and finding elements to interact with.

| Property | Value |
|----------|-------|
| MIME type | `application/json` |
| Requires browser | Yes |

</details>

---

<details>
<summary><strong>Development</strong></summary>

### Setup

```bash
git clone https://github.com/angiejones/mcp-selenium.git
cd mcp-selenium
npm install
```

### Run Tests

```bash
npm test
```

Requires Chrome + chromedriver on PATH. Tests run headless.

### Install via Smithery

```bash
npx -y @smithery/cli install @angiejones/mcp-selenium --client claude
```

### Install globally

```bash
npm install -g @angiejones/mcp-selenium
mcp-selenium
```

</details>

## License

MIT
