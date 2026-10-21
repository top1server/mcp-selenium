import { gridEndpoint, resolveGridUrl } from './url.js';

const GRID_GRAPHQL_QUERY = `{
  grid { uri totalSlots nodeCount maxSession sessionCount sessionQueueSize version }
  nodesInfo { nodes {
    id uri status maxSession slotCount sessionCount stereotypes version
    osInfo { arch name version }
    sessions { id capabilities startTime sessionDurationMillis slot { id stereotype lastStarted } }
  } }
}`;

function optionalNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

async function fetchJson(url, { method = 'GET', body, timeoutMs = 5000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            method,
            headers: body ? { 'content-type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal
        });
        const text = await response.text();
        let data;
        try {
            data = text ? JSON.parse(text) : null;
        } catch {
            throw new Error(`Grid endpoint returned non-JSON data (HTTP ${response.status})`);
        }
        return { response, data };
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error(`Grid request timed out after ${timeoutMs} ms`);
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

function statusNodesToSummary(nodes = []) {
    return nodes.map((node) => {
        const sessions = Array.isArray(node.sessions) ? node.sessions : [];
        const stereotypes = Array.isArray(node.stereotypes) ? node.stereotypes : [];
        const reportedSlots = Array.isArray(node.slots) ? node.slots.length : null;
        const stereotypeSlots = stereotypes.reduce((sum, item) => sum + (Number(item.count) || 0), 0);
        const maxSessions = optionalNumber(node.maxSessions ?? node.maxSessionCount ?? node.maxSession);
        const sessionCount = optionalNumber(node.sessionCount ?? sessions.length) ?? 0;

        return {
            id: node.id ?? null,
            uri: node.uri ?? null,
            status: node.status ?? node.availability ?? null,
            version: node.version ?? null,
            max_sessions: maxSessions,
            slot_count: reportedSlots ?? (stereotypeSlots || null),
            session_count: sessionCount,
            available_capacity: maxSessions === null ? null : Math.max(0, maxSessions - sessionCount),
            stereotypes: stereotypes.map((item) => ({
                capabilities: item.capabilities ?? null,
                count: optionalNumber(item.count) ?? 0
            })),
            sessions: sessions.map((session) => ({
                id: session.id ?? null,
                browser: session.capabilities?.browserName ?? null,
                browser_version: session.capabilities?.browserVersion ?? null,
                started_at: session.startTime ?? null
            }))
        };
    });
}

function graphqlNodesToSummary(nodes = []) {
    return nodes.map((node) => {
        const sessions = Array.isArray(node.sessions) ? node.sessions : [];
        const maxSessions = optionalNumber(node.maxSession);
        const sessionCount = optionalNumber(node.sessionCount ?? sessions.length) ?? 0;
        return {
            id: node.id ?? null,
            uri: node.uri ?? null,
            status: node.status ?? null,
            version: node.version ?? null,
            os_info: node.osInfo ?? null,
            max_sessions: maxSessions,
            slot_count: optionalNumber(node.slotCount),
            session_count: sessionCount,
            available_capacity: maxSessions === null ? null : Math.max(0, maxSessions - sessionCount),
            stereotypes: node.stereotypes ?? [],
            sessions: sessions.map((session) => ({
                id: session.id ?? null,
                browser: session.capabilities?.browserName ?? null,
                browser_version: session.capabilities?.browserVersion ?? null,
                started_at: session.startTime ?? null,
                duration_ms: session.sessionDurationMillis ?? null,
                slot: session.slot ?? null
            }))
        };
    });
}

/** Read Grid readiness and enrich node/slot details using Grid's optional GraphQL API. */
export async function inspectGrid(value, { timeoutMs = 5000 } = {}) {
    const gridUrl = resolveGridUrl(value);
    const statusUrl = gridEndpoint(gridUrl, 'status');
    const { response, data } = await fetchJson(statusUrl, { timeoutMs });
    const status = data?.value ?? data;
    if (!response.ok) {
        throw new Error(`Grid status endpoint returned HTTP ${response.status}`);
    }
    if (!status || typeof status !== 'object') {
        throw new Error('Grid status endpoint returned an unexpected response');
    }

    let nodes = statusNodesToSummary(Array.isArray(status.nodes) ? status.nodes : []);
    let gridDetails = null;
    let graphqlAvailable = false;
    try {
        const result = await fetchJson(gridEndpoint(gridUrl, 'graphql'), {
            method: 'POST',
            body: { query: GRID_GRAPHQL_QUERY },
            timeoutMs
        });
        const graph = result.data?.data;
        if (result.response.ok && graph && !result.data?.errors) {
            graphqlAvailable = true;
            gridDetails = graph.grid ?? null;
            if (Array.isArray(graph.nodesInfo?.nodes)) {
                nodes = graphqlNodesToSummary(graph.nodesInfo.nodes);
            }
        }
    } catch {
        // GraphQL is an optional Grid endpoint; /status remains authoritative for readiness.
    }

    const activeSessions = optionalNumber(gridDetails?.sessionCount)
        ?? nodes.reduce((sum, node) => sum + node.session_count, 0);
    const maxSessions = optionalNumber(gridDetails?.maxSession)
        ?? nodes.reduce((sum, node) => sum + (node.max_sessions ?? 0), 0);
    const slotCount = optionalNumber(gridDetails?.totalSlots)
        ?? nodes.reduce((sum, node) => sum + (node.slot_count ?? 0), 0);
    const availableCapacity = Math.max(0, maxSessions - activeSessions);

    return {
        grid_url: gridUrl,
        status_url: statusUrl,
        http_status: response.status,
        ready: typeof status.ready === 'boolean' ? status.ready : null,
        message: status.message ?? null,
        grid: gridDetails ? {
            uri: gridDetails.uri ?? null,
            version: gridDetails.version ?? null,
            node_count: optionalNumber(gridDetails.nodeCount) ?? nodes.length,
            total_slots: optionalNumber(gridDetails.totalSlots) ?? slotCount,
            max_sessions: optionalNumber(gridDetails.maxSession) ?? maxSessions,
            active_sessions: optionalNumber(gridDetails.sessionCount) ?? activeSessions,
            available_capacity: availableCapacity,
            queue_size: optionalNumber(gridDetails.sessionQueueSize) ?? 0
        } : {
            node_count: nodes.length,
            total_slots: slotCount,
            max_sessions: maxSessions || null,
            active_sessions: activeSessions,
            available_capacity: maxSessions ? availableCapacity : null
        },
        graphql_available: graphqlAvailable,
        nodes
    };
}
