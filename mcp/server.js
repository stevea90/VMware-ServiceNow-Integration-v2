/**
 * ServiceNow MCP Server
 * Exposes ServiceNow Table REST API as MCP tools so Claude Code can
 * query and modify the PDI directly without manual deploy runs.
 *
 * Credentials: reads from ../deploy/.env  (same file as deploy.js)
 * Start:       node server.js
 */
import { Server }               from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Credentials ───────────────────────────────────────────────────────────────
function loadEnv() {
    const candidates = [
        path.join(__dirname, '.env'),
        path.join(__dirname, '..', 'deploy', '.env')
    ];
    for (const p of candidates) {
        if (!fs.existsSync(p)) continue;
        for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
            const t = line.trim();
            if (!t || t.startsWith('#')) continue;
            const i = t.indexOf('=');
            if (i < 0) continue;
            const k = t.substring(0, i).trim();
            const v = t.substring(i + 1).trim().replace(/^["']|["']$/g, '');
            if (!process.env[k]) process.env[k] = v;
        }
        break;
    }
}
loadEnv();

const BASE = (process.env.SNC_INSTANCE || '').replace(/\/$/, '');
const AUTH = 'Basic ' + Buffer.from(
    `${process.env.SNC_USERNAME}:${process.env.SNC_PASSWORD}`
).toString('base64');

const HEADERS = {
    Authorization:  AUTH,
    'Content-Type': 'application/json',
    Accept:         'application/json'
};

// ── HTTP helper ───────────────────────────────────────────────────────────────
async function snFetch(method, urlPath, body = null) {
    if (!BASE) throw new Error('SNC_INSTANCE not set — check deploy/.env');
    const res  = await fetch(`${BASE}${urlPath}`, {
        method,
        headers: HEADERS,
        ...(body !== null && { body: JSON.stringify(body) })
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { _raw: text }; }
    return { status: res.status, ok: res.ok, body: json };
}

// ── Tool definitions ──────────────────────────────────────────────────────────
const TOOLS = [
    {
        name: 'sn_query',
        description:
            'Query multiple records from a ServiceNow table. Returns up to `limit` records.',
        inputSchema: {
            type: 'object',
            properties: {
                table:  { type: 'string',  description: 'Table name, e.g. sys_db_object' },
                query:  { type: 'string',  description: 'Encoded query, e.g. name=my_table^active=true' },
                fields: { type: 'string',  description: 'Comma-separated field names to return' },
                limit:  { type: 'integer', description: 'Max records to return (default 20, max 500)' }
            },
            required: ['table']
        }
    },
    {
        name: 'sn_get',
        description:
            'Get a single ServiceNow record by sys_id, or the first record matching a query.',
        inputSchema: {
            type: 'object',
            properties: {
                table:  { type: 'string', description: 'Table name' },
                sys_id: { type: 'string', description: 'Record sys_id (if known)' },
                query:  { type: 'string', description: 'Encoded query (used if sys_id omitted)' },
                fields: { type: 'string', description: 'Comma-separated field names' }
            },
            required: ['table']
        }
    },
    {
        name: 'sn_create',
        description:
            'Create a new record in a ServiceNow table via POST. ' +
            'Set display_values=true to pass reference fields by display value (name) instead of sys_id.',
        inputSchema: {
            type: 'object',
            properties: {
                table:          { type: 'string',  description: 'Table name' },
                payload:        { type: 'object',  description: 'Field/value pairs to set' },
                display_values: { type: 'boolean', description: 'Use sysparm_input_display_value=true' }
            },
            required: ['table', 'payload']
        }
    },
    {
        name: 'sn_update',
        description: 'Update an existing ServiceNow record by sys_id via PATCH.',
        inputSchema: {
            type: 'object',
            properties: {
                table:   { type: 'string', description: 'Table name' },
                sys_id:  { type: 'string', description: 'Record sys_id' },
                payload: { type: 'object', description: 'Fields to update' }
            },
            required: ['table', 'sys_id', 'payload']
        }
    },
    {
        name: 'sn_delete',
        description: 'Delete a ServiceNow record by sys_id.',
        inputSchema: {
            type: 'object',
            properties: {
                table:  { type: 'string', description: 'Table name' },
                sys_id: { type: 'string', description: 'Record sys_id' }
            },
            required: ['table', 'sys_id']
        }
    },
    {
        name: 'sn_validate',
        description: 'Test connectivity and credentials. Returns instance info.',
        inputSchema: { type: 'object', properties: {} }
    }
];

// ── Server ────────────────────────────────────────────────────────────────────
const server = new Server(
    { name: 'servicenow', version: '1.0.0' },
    { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: a } = req.params;

    try {
        let result;

        if (name === 'sn_query') {
            const limit = Math.min(a.limit || 20, 500);
            let qs = `sysparm_limit=${limit}`;
            if (a.query)  qs += `&sysparm_query=${encodeURIComponent(a.query)}`;
            if (a.fields) qs += `&sysparm_fields=${encodeURIComponent(a.fields)}`;
            result = await snFetch('GET', `/api/now/table/${a.table}?${qs}`);

        } else if (name === 'sn_get') {
            if (a.sys_id) {
                const qs = a.fields ? `?sysparm_fields=${encodeURIComponent(a.fields)}` : '';
                result = await snFetch('GET', `/api/now/table/${a.table}/${a.sys_id}${qs}`);
            } else {
                let qs = 'sysparm_limit=1';
                if (a.query)  qs += `&sysparm_query=${encodeURIComponent(a.query)}`;
                if (a.fields) qs += `&sysparm_fields=${encodeURIComponent(a.fields)}`;
                result = await snFetch('GET', `/api/now/table/${a.table}?${qs}`);
            }

        } else if (name === 'sn_create') {
            const qs = a.display_values ? '?sysparm_input_display_value=true' : '';
            result = await snFetch('POST', `/api/now/table/${a.table}${qs}`, a.payload);

        } else if (name === 'sn_update') {
            result = await snFetch('PATCH', `/api/now/table/${a.table}/${a.sys_id}`, a.payload);

        } else if (name === 'sn_delete') {
            result = await snFetch('DELETE', `/api/now/table/${a.table}/${a.sys_id}`);

        } else if (name === 'sn_validate') {
            result = await snFetch('GET', '/api/now/table/sys_properties?sysparm_limit=1&sysparm_fields=sys_id');
            if (result.ok) {
                result.body = { message: `Connected to ${BASE} successfully`, instance: BASE };
            }

        } else {
            return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
        }

        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };

    } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
});

const transport = new StdioServerTransport();
await server.connect(transport);
