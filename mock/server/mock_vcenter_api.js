/**
 * Mock vCenter REST API Server
 * ─────────────────────────────────────────────────────────────────────────────
 * Purpose: Provides a local HTTP server that simulates the VMware vCenter
 *          REST API (v7/v8) for development and testing without real vCenter.
 *
 * Usage:
 *   node mock_vcenter_api.js [port]     (default port: 8443)
 *
 * Endpoints served:
 *   POST   /api/session                 → 201 + session token
 *   DELETE /api/session                 → 204
 *   GET    /api/vcenter/system/version  → vCenter info
 *   GET    /api/vcenter/datacenter      → Datacenter list
 *   GET    /api/vcenter/cluster         → Cluster list
 *   GET    /api/vcenter/host            → Host list
 *   GET    /api/vcenter/vm              → VM list
 *   GET    /api/vcenter/vm/:id          → VM detail
 *   GET    /api/vcenter/datastore       → Datastore list
 *   GET    /api/vcenter/network         → Network / DVS list
 *
 * The server validates session tokens on protected endpoints.
 * Use in conjunction with the ServiceNow MID Server HTTP proxy or direct
 * local development.
 *
 * Prerequisites:
 *   npm install express
 *
 * To use with ServiceNow PDI:
 *   1. Start this server on your local machine or a VM reachable by MID Server.
 *   2. Configure x_ftl_vcenter_etl.vcenter_host = <this_server_ip>:8443
 *   3. Configure the Connection Alias base URL = http://<this_server_ip>:8443
 *   4. Set x_ftl_vcenter_etl.connection_alias credential to any username/password.
 */

'use strict';

const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const express = require('express');

const app     = express();
const PORT    = parseInt(process.argv[2]) || 8443;
const PAYLOAD_DIR = path.join(__dirname, '../payloads');

app.use(express.json());

// ── Session store ─────────────────────────────────────────────────────────────
const VALID_TOKEN = 'mock-session-token-ft1-vcenter-etl-2024';
let activeSessions = new Set();

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadPayload(filename) {
    try {
        return JSON.parse(fs.readFileSync(path.join(PAYLOAD_DIR, filename), 'utf-8'));
    } catch (e) {
        console.error('Failed to load payload: ' + filename, e.message);
        return [];
    }
}

function requireAuth(req, res, next) {
    const token = req.headers['vmware-api-session-id'];
    if (!token || !activeSessions.has(token)) {
        return res.status(401).json({ type: 'com.vmware.vapi.std.errors.unauthenticated',
            value: { messages: [{ default_message: 'Unauthenticated' }] } });
    }
    next();
}

function paginate(items, req) {
    const offset = parseInt(req.query['filter.offset'] || 0);
    const limit  = parseInt(req.query['filter.limit']  || items.length);
    return items.slice(offset, offset + limit);
}

// ── Authentication ────────────────────────────────────────────────────────────

app.post('/api/session', (req, res) => {
    const auth = req.headers['authorization'] || '';
    // Accept any Basic auth credentials for mock purposes
    if (!auth.startsWith('Basic ')) {
        return res.status(401).json({ error: 'Missing Basic auth' });
    }
    activeSessions.add(VALID_TOKEN);
    console.log('[AUTH] Session created');
    res.status(201).json(VALID_TOKEN);
});

app.delete('/api/session', (req, res) => {
    const token = req.headers['vmware-api-session-id'];
    if (token) activeSessions.delete(token);
    console.log('[AUTH] Session deleted');
    res.status(204).send();
});

// ── System Version ────────────────────────────────────────────────────────────

app.get('/api/vcenter/system/version', requireAuth, (req, res) => {
    const data = loadPayload('vcenter_system_version.json');
    console.log('[GET] /api/vcenter/system/version');
    res.status(200).json(data);
});

// ── Datacenters ───────────────────────────────────────────────────────────────

app.get('/api/vcenter/datacenter', requireAuth, (req, res) => {
    const items = loadPayload('datacenters.json');
    const page  = paginate(items, req);
    console.log('[GET] /api/vcenter/datacenter → ' + page.length + ' items');
    res.status(200).json(page);
});

// ── Clusters ──────────────────────────────────────────────────────────────────

app.get('/api/vcenter/cluster', requireAuth, (req, res) => {
    let items = loadPayload('clusters.json');
    const dcFilter = req.query['filter.datacenters'];
    if (dcFilter) {
        items = items.filter(c => c.datacenter === dcFilter);
    }
    const page = paginate(items, req);
    console.log('[GET] /api/vcenter/cluster → ' + page.length + ' items');
    res.status(200).json(page);
});

// ── Hosts ─────────────────────────────────────────────────────────────────────

app.get('/api/vcenter/host', requireAuth, (req, res) => {
    let items = loadPayload('hosts.json');
    const clusterFilter = req.query['filter.clusters'];
    const dcFilter      = req.query['filter.datacenters'];
    if (clusterFilter) items = items.filter(h => h.cluster === clusterFilter);
    if (dcFilter)      items = items.filter(h => h.datacenter === dcFilter);
    const page = paginate(items, req);
    console.log('[GET] /api/vcenter/host → ' + page.length + ' items');
    res.status(200).json(page);
});

app.get('/api/vcenter/host/:id', requireAuth, (req, res) => {
    const items = loadPayload('hosts.json');
    const host  = items.find(h => h.host === req.params.id);
    if (!host) return res.status(404).json({ error: 'Host not found' });
    res.status(200).json(host);
});

// ── VMs ───────────────────────────────────────────────────────────────────────

app.get('/api/vcenter/vm', requireAuth, (req, res) => {
    let items = loadPayload('virtual_machines.json');
    const hostFilter    = req.query['filter.hosts'];
    const clusterFilter = req.query['filter.clusters'];
    if (hostFilter)    items = items.filter(v => v.placement && v.placement.host === hostFilter);
    if (clusterFilter) items = items.filter(v => v.placement && v.placement.cluster === clusterFilter);
    const page = paginate(items, req);
    console.log('[GET] /api/vcenter/vm → ' + page.length + ' items');
    res.status(200).json(page);
});

app.get('/api/vcenter/vm/:id', requireAuth, (req, res) => {
    const items = loadPayload('virtual_machines.json');
    const vm    = items.find(v => v.vm === req.params.id);
    if (!vm) return res.status(404).json({ error: 'VM not found' });
    res.status(200).json(vm);
});

// ── Datastores ────────────────────────────────────────────────────────────────

app.get('/api/vcenter/datastore', requireAuth, (req, res) => {
    const items = loadPayload('datastores.json');
    const page  = paginate(items, req);
    console.log('[GET] /api/vcenter/datastore → ' + page.length + ' items');
    res.status(200).json(page);
});

// ── Networks / DVS ────────────────────────────────────────────────────────────

app.get('/api/vcenter/network', requireAuth, (req, res) => {
    const items = loadPayload('distributed_switches.json');
    const page  = paginate(items, req);
    console.log('[GET] /api/vcenter/network → ' + page.length + ' items');
    res.status(200).json(page);
});

// ── Storage Policies (Datastore Clusters) ─────────────────────────────────────

app.get('/api/vcenter/storage/policies', requireAuth, (req, res) => {
    // Return empty array — datastore clusters are optional
    console.log('[GET] /api/vcenter/storage/policies → 0 items');
    res.status(200).json([]);
});

// ── Health Check ──────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', server: 'mock-vcenter-api', port: PORT });
});

// ── 404 Handler ───────────────────────────────────────────────────────────────

app.use((req, res) => {
    console.warn('[404] ' + req.method + ' ' + req.path);
    res.status(404).json({ error: 'Not Found', path: req.path });
});

// ── Start Server ──────────────────────────────────────────────────────────────

const server = http.createServer(app);
server.listen(PORT, '0.0.0.0', () => {
    console.log('Mock vCenter API server listening on http://0.0.0.0:' + PORT);
    console.log('Payload directory: ' + PAYLOAD_DIR);
    console.log('Session token: ' + VALID_TOKEN);
    console.log('\nAvailable endpoints:');
    console.log('  POST   /api/session');
    console.log('  DELETE /api/session');
    console.log('  GET    /api/vcenter/system/version');
    console.log('  GET    /api/vcenter/datacenter');
    console.log('  GET    /api/vcenter/cluster');
    console.log('  GET    /api/vcenter/host');
    console.log('  GET    /api/vcenter/vm');
    console.log('  GET    /api/vcenter/datastore');
    console.log('  GET    /api/vcenter/network');
    console.log('  GET    /health');
});

module.exports = { app, server };
