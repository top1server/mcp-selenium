const GRID_URL_ENV = 'SELENIUM_GRID_URL';

/** Resolve a Grid base URL from the tool argument or environment. */
export function resolveGridUrl(value, { required = true } = {}) {
    const raw = typeof value === 'string' && value.trim()
        ? value.trim()
        : process.env[GRID_URL_ENV]?.trim();

    if (!raw) {
        if (required) {
            throw new Error(`grid_url is required, or set ${GRID_URL_ENV}`);
        }
        return null;
    }

    let url;
    try {
        url = new URL(raw);
    } catch {
        throw new Error('Grid URL must be an absolute HTTP or HTTPS URL');
    }

    if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('Grid URL must use HTTP or HTTPS');
    }
    if (url.username || url.password) {
        throw new Error('Grid URL must not contain username or password credentials');
    }
    if (url.search || url.hash) {
        throw new Error('Grid URL must not contain a query string or fragment');
    }

    // Accept the common pasted status URL while retaining reverse-proxy paths
    // such as /selenium or the legacy /wd/hub base path.
    url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/status$/i, '');
    return url.toString().replace(/\/$/, '');
}

export function gridEndpoint(gridUrl, endpoint) {
    return `${gridUrl}/${endpoint.replace(/^\/+/, '')}`;
}

export function displayGridUrl(gridUrl) {
    const url = new URL(gridUrl);
    return `${url.origin}${url.pathname.replace(/\/$/, '')}`;
}

export { GRID_URL_ENV };
