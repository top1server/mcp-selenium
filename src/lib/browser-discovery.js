import { constants, accessSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve, sep } from 'node:path';

const definitions = [
    {
        browser: 'chrome',
        browserNames: [
            'google-chrome', 'google-chrome-stable', 'chrome', 'chrome.exe',
            'chromium', 'chromium-browser',
        ],
        driverNames: ['chromedriver', 'chromedriver.exe'],
    },
    {
        browser: 'firefox',
        browserNames: ['firefox', 'firefox.exe'],
        driverNames: ['geckodriver', 'geckodriver.exe'],
    },
    {
        browser: 'edge',
        browserNames: [
            'microsoft-edge', 'microsoft-edge-stable', 'msedge', 'msedge.exe',
        ],
        driverNames: ['msedgedriver', 'msedgedriver.exe'],
    },
    {
        browser: 'safari',
        browserNames: ['Safari'],
        driverNames: ['safaridriver'],
    },
    {
        browser: 'ie',
        browserNames: ['iexplore.exe'],
        driverNames: ['IEDriverServer.exe'],
    },
    {
        browser: 'edge_ie_mode',
        browserNames: ['msedge.exe', 'msedge'],
        driverNames: ['IEDriverServer.exe'],
    },
];

const supportedByMcp = new Set(['chrome', 'firefox', 'edge', 'ie', 'edge_ie_mode', 'safari']);

function getSearchDirs() {
    const pathDirs = (process.env.PATH ?? '')
        .split(delimiter)
        .map((directory) => directory.trim().replace(/^"|"$/g, ''))
        .filter(Boolean);

    if (process.platform === 'win32') {
        const programFiles = process.env.ProgramFiles ?? process.env.PROGRAMFILES;
        const programFilesX86 = process.env['ProgramFiles(x86)']
            ?? process.env['PROGRAMFILES(X86)'];
        const localAppData = process.env.LOCALAPPDATA;

        return [
            ...pathDirs,
            ...[programFiles, programFilesX86].filter(Boolean).flatMap((base) => [
                join(base, 'Google', 'Chrome', 'Application'),
                join(base, 'Mozilla Firefox'),
                join(base, 'Microsoft', 'Edge', 'Application'),
                join(base, 'Internet Explorer'),
            ]),
            ...(localAppData ? [
                join(localAppData, 'Google', 'Chrome', 'Application'),
                join(localAppData, 'Mozilla Firefox'),
                join(localAppData, 'Microsoft', 'Edge', 'Application'),
            ] : []),
        ];
    }

    return [
        ...pathDirs,
        '/usr/bin',
        '/usr/local/bin',
        '/snap/bin',
        '/opt/google/chrome',
        '/opt/microsoft/msedge',
        '/snap/firefox/current/usr/lib/firefox',
        '/Applications/Google Chrome.app/Contents/MacOS',
        '/Applications/Firefox.app/Contents/MacOS',
        '/Applications/Microsoft Edge.app/Contents/MacOS',
        '/Applications/Safari.app/Contents/MacOS',
    ];
}

function findExecutables(names, searchDirs) {
    const found = new Map();
    const permission = process.platform === 'win32' ? constants.F_OK : constants.X_OK;

    for (const directory of searchDirs) {
        for (const name of names) {
            if (process.platform !== 'win32' && name.toLowerCase().endsWith('.exe')) {
                continue;
            }

            const candidate = join(directory, name);
            try {
                accessSync(candidate, permission);
                const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
                found.set(key, candidate);
            } catch {
                // Ignore missing files and files without the required permissions.
            }
        }
    }

    return [...found.values()].sort();
}

function getSeleniumCachePath() {
    const configuredPath = process.env.SE_CACHE_PATH?.trim();
    if (!configuredPath) {
        return join(homedir(), '.cache', 'selenium');
    }

    if (configuredPath === '~') {
        return homedir();
    }
    if (configuredPath.startsWith(`~${sep}`)) {
        return join(homedir(), configuredPath.slice(2));
    }

    return resolve(configuredPath);
}

function findCachedExecutables(names, cacheRoot) {
    const found = new Map();
    const expectedNames = new Set(names.map((name) => (
        process.platform === 'win32' ? name.toLowerCase() : name
    )));
    const driverFolders = [...new Set(names.map((name) => name.replace(/\.exe$/i, '')))];
    const permission = process.platform === 'win32' ? constants.F_OK : constants.X_OK;

    function walk(directory, depth = 0) {
        // Selenium Manager stores drivers a few levels below the cache root.
        if (depth > 6) return;

        let entries;
        try {
            entries = readdirSync(directory, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            const candidate = join(directory, entry.name);
            const normalizedName = process.platform === 'win32'
                ? entry.name.toLowerCase()
                : entry.name;

            if (expectedNames.has(normalizedName)) {
                try {
                    accessSync(candidate, permission);
                    const key = process.platform === 'win32'
                        ? candidate.toLowerCase()
                        : candidate;
                    found.set(key, candidate);
                } catch {
                    // Ignore cached files that are not executable.
                }
            }

            if (entry.isDirectory()) {
                walk(candidate, depth + 1);
            }
        }
    }

    for (const driverFolder of driverFolders) {
        walk(join(cacheRoot, driverFolder));
    }

    return [...found.values()].sort();
}

export function discoverBrowserDrivers() {
    const searchDirs = getSearchDirs();
    const seleniumCachePath = getSeleniumCachePath();

    return definitions.map(({ browser, browserNames, driverNames }) => {
        const browserPaths = findExecutables(browserNames, searchDirs);
        const driverPaths = [
            ...new Set([
                ...findExecutables(driverNames, searchDirs),
                ...findCachedExecutables(driverNames, seleniumCachePath),
            ]),
        ].sort();
        const browserFound = browserPaths.length > 0;
        const driverFound = driverPaths.length > 0;
        const platformSupported = !['ie', 'edge_ie_mode'].includes(browser)
            || process.platform === 'win32';
        const mcpSupported = supportedByMcp.has(browser);
        const driverRequired = ['ie', 'edge_ie_mode'].includes(browser);
        const available = mcpSupported && platformSupported && browserFound
            && (!driverRequired || driverFound);
        const notes = [];

        if (!mcpSupported) {
            notes.push('Detected for inventory only; start_browser does not support this browser.');
        }
        if (!platformSupported) {
            notes.push(`Requires Windows; MCP host is ${process.platform}.`);
        }
        if (available && !driverFound && browser !== 'safari' && browser !== 'edge_ie_mode') {
            notes.push('No driver found in PATH, common install directories, or Selenium Manager cache; Selenium Manager may resolve one at startup.');
        }
        if (browser === 'edge_ie_mode' && browserFound && !driverFound && process.platform === 'win32') {
            notes.push('Edge IE mode requires IEDriverServer.exe 4.0.0.0 or newer on PATH.');
        }
        if (browser === 'ie' && browserFound && process.platform === 'win32') {
            notes.push('Standalone IE launch is best-effort; Selenium ended official support in June 2022. IEDriverServer.exe 4.0.0.0 or newer must be on PATH.');
        }

        return {
            browser,
            browserPaths,
            driverPaths,
            browserFound,
            driverFound,
            supportedByMcp: mcpSupported,
            available,
            ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
        };
    });
}
