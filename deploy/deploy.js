#!/usr/bin/env node
/**
 * vCenter CMDB ETL — Automated ServiceNow PDI Deployment
 * ─────────────────────────────────────────────────────────
 * Creates every integration artifact via the ServiceNow REST API:
 *   ✓ Scoped application  (x_ftl_vcenter_etl)
 *   ✓ 10 custom tables    (staging base + 8 object types + log/run)
 *   ✓ All table fields
 *   ✓ 11 Script Includes
 *   ✓ 15 system properties
 *   ✓ 1 scheduled job     (disabled — enable after first successful test)
 *   ✓ 1 business rule
 *   ✓ CMDB custom fields  (u_bios_uuid, u_instance_uuid, u_dvs_uuid, etc.)
 *
 * Usage:
 *   node deploy.js                                          ← reads .env, prompts for missing
 *   node deploy.js --instance https://dev12345.service-now.com --user admin --pass MyPass
 *   node deploy.js --check                                  ← dry-run, show what WOULD be created
 *
 * Requires Node.js ≥ 18  (uses built-in fetch)
 */
'use strict';

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');

const ROOT   = path.resolve(__dirname, '..');
const SI_DIR = path.join(ROOT, 'servicenow', 'script_includes');
const JOB_DIR = path.join(ROOT, 'servicenow', 'scheduled_jobs');
const BR_DIR  = path.join(ROOT, 'servicenow', 'business_rules');

// ─── Colours ──────────────────────────────────────────────────────────────────
const C = {
    reset:  '\x1b[0m',
    green:  '\x1b[32m',
    red:    '\x1b[31m',
    yellow: '\x1b[33m',
    cyan:   '\x1b[36m',
    bold:   '\x1b[1m',
    dim:    '\x1b[2m'
};
const ok    = (s) => console.log(`${C.green}  ✓${C.reset} ${s}`);
const fail  = (s) => console.log(`${C.red}  ✗${C.reset} ${s}`);
const skip  = (s) => console.log(`${C.yellow}  ─${C.reset} ${s} ${C.dim}(already exists)${C.reset}`);
const info  = (s) => console.log(`${C.cyan}${s}${C.reset}`);
const head  = (s) => console.log(`\n${C.bold}${C.cyan}── ${s} ${'─'.repeat(Math.max(0,50-s.length))}${C.reset}`);
const dry   = (s) => console.log(`${C.dim}  [dry-run] ${s}${C.reset}`);

// ─── .env loader (no dotenv dependency) ──────────────────────────────────────
function loadDotEnv() {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx < 0) continue;
        const key = trimmed.substring(0, idx).trim();
        const val = trimmed.substring(idx + 1).trim().replace(/^["']|["']$/g, '');
        if (!process.env[key]) process.env[key] = val;
    }
}

// ─── CLI args parser ──────────────────────────────────────────────────────────
function parseArgs() {
    const args = process.argv.slice(2);
    const out  = { check: false };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--instance') out.instance = args[++i];
        else if (args[i] === '--user')     out.username = args[++i];
        else if (args[i] === '--pass')     out.password = args[++i];
        else if (args[i] === '--check')    out.check    = true;
    }
    return out;
}

// ─── Prompt helper ───────────────────────────────────────────────────────────
async function prompt(question, hidden = false) {
    const rl = readline.createInterface({
        input:  process.stdin,
        output: process.stdout
    });
    return new Promise((resolve) => {
        if (hidden) {
            // Hide password input
            process.stdout.write(question);
            process.stdin.setRawMode(true);
            let input = '';
            process.stdin.on('data', function handler(char) {
                char = char.toString();
                if (char === '\n' || char === '\r' || char === '') {
                    process.stdin.setRawMode(false);
                    process.stdin.removeListener('data', handler);
                    process.stdout.write('\n');
                    rl.close();
                    resolve(input);
                } else if (char === '') {
                    process.exit();
                } else if (char === '') {
                    input = input.slice(0, -1);
                } else {
                    input += char;
                }
            });
        } else {
            rl.question(question, (answer) => { rl.close(); resolve(answer); });
        }
    });
}

// ─── ServiceNow REST Client ───────────────────────────────────────────────────
class SNClient {
    constructor(instance, username, password) {
        this.base     = instance.replace(/\/$/, '');
        this.authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
        this.headers  = {
            'Authorization': this.authHeader,
            'Content-Type':  'application/json',
            'Accept':        'application/json'
        };
    }

    async get(table, query = '', fields = '') {
        let qs = `sysparm_limit=1`;
        if (query)  qs += `&sysparm_query=${encodeURIComponent(query)}`;
        if (fields) qs += `&sysparm_fields=${fields}`;
        const res = await fetch(`${this.base}/api/now/table/${table}?${qs}`, {
            headers: this.headers
        });
        if (!res.ok) throw new Error(`GET ${table}: HTTP ${res.status}`);
        const body = await res.json();
        return body.result?.[0] || null;
    }

    async getAll(table, query = '', fields = '') {
        let qs = `sysparm_limit=500`;
        if (query)  qs += `&sysparm_query=${encodeURIComponent(query)}`;
        if (fields) qs += `&sysparm_fields=${fields}`;
        const res = await fetch(`${this.base}/api/now/table/${table}?${qs}`, {
            headers: this.headers
        });
        if (!res.ok) throw new Error(`GET ${table}: HTTP ${res.status}`);
        const body = await res.json();
        return body.result || [];
    }

    async post(table, payload, displayValue = false) {
        const qs  = displayValue ? '?sysparm_input_display_value=true' : '';
        const res = await fetch(`${this.base}/api/now/table/${table}${qs}`, {
            method:  'POST',
            headers: this.headers,
            body:    JSON.stringify(payload)
        });
        const body = await res.json();
        if (!res.ok) {
            const parts = [body?.error?.message, body?.error?.detail].filter(Boolean);
            const msg   = parts.length ? parts.join(' — ') : `HTTP ${res.status}`;
            throw new Error(`POST ${table}: ${msg}`);
        }
        return body.result;
    }

    async patch(table, sysId, payload) {
        const res = await fetch(`${this.base}/api/now/table/${table}/${sysId}`, {
            method:  'PATCH',
            headers: this.headers,
            body:    JSON.stringify(payload)
        });
        if (!res.ok) throw new Error(`PATCH ${table}/${sysId}: HTTP ${res.status}`);
        return (await res.json()).result;
    }

    async delete(table, sysId) {
        const res = await fetch(`${this.base}/api/now/table/${table}/${sysId}`, {
            method: 'DELETE', headers: this.headers
        });
        if (res.status !== 204 && !res.ok) throw new Error(`DELETE ${table}/${sysId}: HTTP ${res.status}`);
    }

    /** Test credentials and connectivity */
    async validate() {
        const res = await fetch(`${this.base}/api/now/table/sys_properties?sysparm_limit=1`, {
            headers: this.headers
        });
        if (res.status === 401) throw new Error('Authentication failed — check username/password');
        if (res.status === 403) throw new Error('Forbidden — ensure admin role is assigned');
        if (!res.ok)            throw new Error(`Connectivity error: HTTP ${res.status}`);
    }
}

// ─── Artifact Definitions ─────────────────────────────────────────────────────

const SCOPE_NAME = 'x_ftl_vcenter_etl';

const APP_DEF = {
    scope:             SCOPE_NAME,
    name:              'vCenter CMDB ETL (FT1)',
    short_description: 'VMware vCenter → ServiceNow CMDB via IH ETL',
    version:           '1.0.0',
    vendor:            'Integration Architecture Team',
    vendor_prefix:     'x_ftl'
};

// Base staging table fields (shared by all staging tables)
const BASE_FIELDS = [
    { element: 'moref',       column_label: 'MoRef',        internal_type: 'string',          max_length: 255 },
    { element: 'run_id',      column_label: 'Run ID',        internal_type: 'string',          max_length: 50  },
    { element: 'stg_state',   column_label: 'State',         internal_type: 'string',          max_length: 20, default_value: 'ready' },
    { element: 'raw_payload', column_label: 'Raw Payload',   internal_type: 'string',          max_length: 8000 },
    { element: 'last_seen',   column_label: 'Last Seen',     internal_type: 'glide_date_time', max_length: 40  },
    { element: 'error_msg',   column_label: 'Error Message', internal_type: 'string',          max_length: 1000 }
];

const TABLES = [
    // ── Staging base ────────────────────────────────────────────────────────
    {
        name:  'x_ftl_vcenter_etl_staging_base',
        label: 'vCenter ETL Staging Base',
        fields: BASE_FIELDS
    },
    // ── Object staging tables (standalone — PDI REST API blocks super_class) ─
    {
        name:   'x_ftl_vcenter_etl_vcenter_stg',
        label:  'vCenter Instance Staging',
        fields: [
            ...BASE_FIELDS,
            { element: 'name',          column_label: 'Name',          internal_type: 'string', max_length: 255 },
            { element: 'vcenter_fqdn',  column_label: 'vCenter FQDN',  internal_type: 'string', max_length: 255 },
            { element: 'version',       column_label: 'Version',        internal_type: 'string', max_length: 50  },
            { element: 'build',         column_label: 'Build',          internal_type: 'string', max_length: 50  },
            { element: 'instance_uuid', column_label: 'Instance UUID',  internal_type: 'string', max_length: 100 },
            { element: 'api_version',   column_label: 'API Version',    internal_type: 'string', max_length: 20  }
        ]
    },
    {
        name:   'x_ftl_vcenter_etl_datacenter_stg',
        label:  'Datacenter Staging',
        fields: [
            ...BASE_FIELDS,
            { element: 'name',        column_label: 'Name',          internal_type: 'string', max_length: 255 },
            { element: 'vcenter_ref', column_label: 'vCenter MoRef', internal_type: 'string', max_length: 255 }
        ]
    },
    {
        name:   'x_ftl_vcenter_etl_cluster_stg',
        label:  'Cluster Staging',
        fields: [
            ...BASE_FIELDS,
            { element: 'name',           column_label: 'Name',            internal_type: 'string', max_length: 255 },
            { element: 'datacenter_ref', column_label: 'Datacenter MoRef',internal_type: 'string', max_length: 255 },
            { element: 'ha_enabled',     column_label: 'HA Enabled',      internal_type: 'string', max_length: 10  },
            { element: 'drs_enabled',    column_label: 'DRS Enabled',     internal_type: 'string', max_length: 10  },
            { element: 'num_hosts',      column_label: 'Number of Hosts', internal_type: 'string', max_length: 10  }
        ]
    },
    {
        name:   'x_ftl_vcenter_etl_host_stg',
        label:  'ESXi Host Staging',
        fields: [
            ...BASE_FIELDS,
            { element: 'name',             column_label: 'Name (FQDN)',       internal_type: 'string', max_length: 255 },
            { element: 'cluster_ref',      column_label: 'Cluster MoRef',     internal_type: 'string', max_length: 255 },
            { element: 'datacenter_ref',   column_label: 'Datacenter MoRef',  internal_type: 'string', max_length: 255 },
            { element: 'power_state',      column_label: 'Power State',        internal_type: 'string', max_length: 30  },
            { element: 'connection_state', column_label: 'Connection State',   internal_type: 'string', max_length: 30  },
            { element: 'cpu_count',        column_label: 'CPU Count',          internal_type: 'string', max_length: 10  },
            { element: 'cpu_cores',        column_label: 'CPU Cores',          internal_type: 'string', max_length: 10  },
            { element: 'memory_size_gb',   column_label: 'Memory (GB)',        internal_type: 'string', max_length: 20  },
            { element: 'model',            column_label: 'Model',              internal_type: 'string', max_length: 255 },
            { element: 'vendor',           column_label: 'Vendor',             internal_type: 'string', max_length: 100 },
            { element: 'bios_uuid',        column_label: 'BIOS UUID',          internal_type: 'string', max_length: 100 },
            { element: 'os_type',          column_label: 'OS Type',            internal_type: 'string', max_length: 100 }
        ]
    },
    {
        name:   'x_ftl_vcenter_etl_vm_stg',
        label:  'Virtual Machine Staging',
        fields: [
            ...BASE_FIELDS,
            { element: 'name',                 column_label: 'Name',               internal_type: 'string', max_length: 255  },
            { element: 'instance_uuid',        column_label: 'Instance UUID',       internal_type: 'string', max_length: 100  },
            { element: 'bios_uuid',            column_label: 'BIOS UUID',           internal_type: 'string', max_length: 100  },
            { element: 'host_ref',             column_label: 'Host MoRef',          internal_type: 'string', max_length: 255  },
            { element: 'cluster_ref',          column_label: 'Cluster MoRef',       internal_type: 'string', max_length: 255  },
            { element: 'datacenter_ref',       column_label: 'Datacenter MoRef',    internal_type: 'string', max_length: 255  },
            { element: 'resource_pool_ref',    column_label: 'Resource Pool MoRef', internal_type: 'string', max_length: 255  },
            { element: 'power_state',          column_label: 'Power State',          internal_type: 'string', max_length: 30   },
            { element: 'cpu_count',            column_label: 'vCPU Count',           internal_type: 'string', max_length: 10   },
            { element: 'cpu_cores_per_socket', column_label: 'Cores per Socket',     internal_type: 'string', max_length: 10   },
            { element: 'memory_size_gb',       column_label: 'Memory (GB)',           internal_type: 'string', max_length: 20   },
            { element: 'guest_os',             column_label: 'Guest OS',             internal_type: 'string', max_length: 255  },
            { element: 'guest_hostname',       column_label: 'Guest Hostname',        internal_type: 'string', max_length: 255  },
            { element: 'num_disks',            column_label: 'Number of Disks',       internal_type: 'string', max_length: 10   },
            { element: 'num_nics',             column_label: 'Number of NICs',        internal_type: 'string', max_length: 10   },
            { element: 'hardware_version',     column_label: 'Hardware Version',      internal_type: 'string', max_length: 30   },
            { element: 'datastore_refs',       column_label: 'Datastore MoRefs',      internal_type: 'string', max_length: 2000 }
        ]
    },
    {
        name:   'x_ftl_vcenter_etl_datastore_stg',
        label:  'Datastore Staging',
        fields: [
            ...BASE_FIELDS,
            { element: 'name',           column_label: 'Name',            internal_type: 'string', max_length: 255 },
            { element: 'type',           column_label: 'Type',            internal_type: 'string', max_length: 30  },
            { element: 'capacity_gb',    column_label: 'Capacity (GB)',   internal_type: 'string', max_length: 20  },
            { element: 'free_space_gb',  column_label: 'Free Space (GB)', internal_type: 'string', max_length: 20  },
            { element: 'accessible',     column_label: 'Accessible',      internal_type: 'string', max_length: 10  },
            { element: 'datacenter_ref', column_label: 'Datacenter MoRef',internal_type: 'string', max_length: 255 },
            { element: 'host_ref',       column_label: 'Host MoRef',      internal_type: 'string', max_length: 255 },
            { element: 'cluster_ref',    column_label: 'Cluster MoRef',   internal_type: 'string', max_length: 255 }
        ]
    },
    {
        name:   'x_ftl_vcenter_etl_ds_cluster_stg',
        label:  'Datastore Cluster Staging',
        fields: [
            ...BASE_FIELDS,
            { element: 'name',           column_label: 'Name',            internal_type: 'string', max_length: 255 },
            { element: 'sdrs_enabled',   column_label: 'SDRS Enabled',    internal_type: 'string', max_length: 10  },
            { element: 'capacity_gb',    column_label: 'Capacity (GB)',   internal_type: 'string', max_length: 20  },
            { element: 'free_space_gb',  column_label: 'Free Space (GB)', internal_type: 'string', max_length: 20  },
            { element: 'datacenter_ref', column_label: 'Datacenter MoRef',internal_type: 'string', max_length: 255 }
        ]
    },
    {
        name:   'x_ftl_vcenter_etl_dvs_stg',
        label:  'Distributed vSwitch Staging',
        fields: [
            ...BASE_FIELDS,
            { element: 'name',           column_label: 'Name',            internal_type: 'string', max_length: 255  },
            { element: 'type',           column_label: 'Type',            internal_type: 'string', max_length: 50   },
            { element: 'dvs_uuid',       column_label: 'DVS UUID',        internal_type: 'string', max_length: 100  },
            { element: 'datacenter_ref', column_label: 'Datacenter MoRef',internal_type: 'string', max_length: 255  },
            { element: 'num_ports',      column_label: 'Number of Ports', internal_type: 'string', max_length: 10   },
            { element: 'uplink_count',   column_label: 'Uplink Count',    internal_type: 'string', max_length: 10   },
            { element: 'host_refs',      column_label: 'Host MoRefs',     internal_type: 'string', max_length: 2000 }
        ]
    },
    // ── Log and Run tables (standalone) ─────────────────────────────────────
    {
        name:  'x_ftl_vcenter_etl_log',
        label: 'vCenter ETL Log',
        fields: [
            { element: 'level',   column_label: 'Level',   internal_type: 'string', max_length: 10   },
            { element: 'source',  column_label: 'Source',  internal_type: 'string', max_length: 100  },
            { element: 'run_id',  column_label: 'Run ID',  internal_type: 'string', max_length: 50   },
            { element: 'message', column_label: 'Message', internal_type: 'string', max_length: 1000 },
            { element: 'detail',  column_label: 'Detail',  internal_type: 'string', max_length: 4000 }
        ]
    },
    {
        name:  'x_ftl_vcenter_etl_run',
        label: 'vCenter ETL Run',
        fields: [
            { element: 'run_id',        column_label: 'Run ID',        internal_type: 'string',          max_length: 50  },
            { element: 'status',        column_label: 'Status',        internal_type: 'string',          max_length: 20  },
            { element: 'started_at',    column_label: 'Started At',    internal_type: 'glide_date_time', max_length: 40  },
            { element: 'ended_at',      column_label: 'Ended At',      internal_type: 'glide_date_time', max_length: 40  },
            { element: 'vcenter',       column_label: 'vCenter',       internal_type: 'string',          max_length: 255 },
            { element: 'current_phase', column_label: 'Current Phase', internal_type: 'string',          max_length: 50  },
            { element: 'stats_json',    column_label: 'Stats JSON',    internal_type: 'string',          max_length: 4000 }
        ]
    }
];

// Custom fields to add to existing CMDB tables
const CMDB_FIELD_EXTENSIONS = [
    // cmdb_ci_esx_server
    { table: 'cmdb_ci_esx_server', element: 'u_bios_uuid',  column_label: 'BIOS UUID', internal_type: 'string', max_length: 100 },
    { table: 'cmdb_ci_esx_server', element: 'u_moref',      column_label: 'vCenter MoRef', internal_type: 'string', max_length: 255 },
    // cmdb_ci_vmware_instance
    { table: 'cmdb_ci_vmware_instance', element: 'u_instance_uuid',     column_label: 'Instance UUID',    internal_type: 'string',  max_length: 100 },
    { table: 'cmdb_ci_vmware_instance', element: 'u_bios_uuid',          column_label: 'BIOS UUID',         internal_type: 'string',  max_length: 100 },
    { table: 'cmdb_ci_vmware_instance', element: 'u_moref',              column_label: 'vCenter MoRef',     internal_type: 'string',  max_length: 255 },
    { table: 'cmdb_ci_vmware_instance', element: 'u_cores_per_socket',   column_label: 'Cores per Socket',  internal_type: 'integer', max_length: 40  },
    // cmdb_ci_vcenter
    { table: 'cmdb_ci_vcenter', element: 'u_instance_uuid', column_label: 'Instance UUID', internal_type: 'string', max_length: 100 },
    { table: 'cmdb_ci_vcenter', element: 'u_build',         column_label: 'Build Number',  internal_type: 'string', max_length: 50  },
    // cmdb_ci_cluster
    { table: 'cmdb_ci_cluster', element: 'u_ha_enabled',  column_label: 'HA Enabled',  internal_type: 'string', max_length: 10  },
    { table: 'cmdb_ci_cluster', element: 'u_drs_enabled', column_label: 'DRS Enabled', internal_type: 'string', max_length: 10  },
    { table: 'cmdb_ci_cluster', element: 'u_moref',       column_label: 'vCenter MoRef', internal_type: 'string', max_length: 255 },
    // cmdb_ci_dvs_switch
    { table: 'cmdb_ci_dvs_switch', element: 'u_dvs_uuid',     column_label: 'DVS UUID',       internal_type: 'string',  max_length: 100 },
    { table: 'cmdb_ci_dvs_switch', element: 'u_num_ports',    column_label: 'Number of Ports', internal_type: 'integer', max_length: 40  },
    { table: 'cmdb_ci_dvs_switch', element: 'u_uplink_count', column_label: 'Uplink Count',    internal_type: 'integer', max_length: 40  },
    { table: 'cmdb_ci_dvs_switch', element: 'u_moref',        column_label: 'vCenter MoRef',   internal_type: 'string',  max_length: 255 },
    // cmdb_ci_datastore
    { table: 'cmdb_ci_datastore', element: 'u_type',          column_label: 'Datastore Type', internal_type: 'string',  max_length: 30  },
    { table: 'cmdb_ci_datastore', element: 'u_free_space_gb', column_label: 'Free Space (GB)',internal_type: 'decimal', max_length: 40  },
    { table: 'cmdb_ci_datastore', element: 'u_accessible',    column_label: 'Accessible',      internal_type: 'string',  max_length: 10  },
    { table: 'cmdb_ci_datastore', element: 'u_moref',         column_label: 'vCenter MoRef',  internal_type: 'string',  max_length: 255 }
];

// Script Include definitions — name maps to file in SI_DIR
const SCRIPT_INCLUDES = [
    { name: 'VCenterLogger',            file: 'VCenterLogger.script.js' },
    { name: 'VCenterRetryHandler',      file: 'VCenterRetryHandler.script.js' },
    { name: 'VCenterUtils',             file: 'VCenterUtils.script.js' },
    { name: 'VCenterConfig',            file: 'VCenterConfig.script.js' },
    { name: 'VCenterAPIClient',         file: 'VCenterAPIClient.script.js' },
    { name: 'VCenterStagingLoader',     file: 'VCenterStagingLoader.script.js' },
    { name: 'VCenterIREPayloadBuilder', file: 'VCenterIREPayloadBuilder.script.js' },
    { name: 'VCenterRelationshipBuilder', file: 'VCenterRelationshipBuilder.script.js' },
    { name: 'VCenterStalenessManager',  file: 'VCenterStalenessManager.script.js' },
    { name: 'VCenterTransformEngine',   file: 'VCenterTransformEngine.script.js' },
    { name: 'VCenterETLOrchestrator',   file: 'VCenterETLOrchestrator.script.js' }
];

const PROPERTIES = [
    { name: 'x_ftl_vcenter_etl.connection_alias', value: 'x_ftl_vcenter_etl.vcenter_conn', description: 'Connection & Credential Alias name' },
    { name: 'x_ftl_vcenter_etl.mid_server',        value: '',                                description: 'MID Server name for FT1 domain' },
    { name: 'x_ftl_vcenter_etl.vcenter_host',      value: '',                                description: 'vCenter FQDN or IP address' },
    { name: 'x_ftl_vcenter_etl.discovery_source',  value: 'vCenterETL',                      description: 'Discovery source label for CI writes' },
    { name: 'x_ftl_vcenter_etl.log_level',         value: 'DEBUG',                           description: 'Log level: DEBUG|INFO|WARN|ERROR' },
    { name: 'x_ftl_vcenter_etl.page_size',         value: '200',                             description: 'API pagination page size' },
    { name: 'x_ftl_vcenter_etl.max_retries',       value: '3',                               description: 'HTTP retry limit' },
    { name: 'x_ftl_vcenter_etl.timeout_ms',        value: '30000',                           description: 'HTTP timeout in milliseconds' },
    { name: 'x_ftl_vcenter_etl.staleness_days',    value: '7',                               description: 'Days before unseen CI is retired' },
    { name: 'x_ftl_vcenter_etl.batch_size',        value: '50',                              description: 'IRE batch size' },
    { name: 'x_ftl_vcenter_etl.incremental',       value: 'false',                           description: 'Enable incremental sync' },
    { name: 'x_ftl_vcenter_etl.notify_email',      value: '',                                description: 'Failure notification email' },
    { name: 'x_ftl_vcenter_etl.create_incident_on_failure', value: 'false',                 description: 'Auto-create incident on ETL failure' },
    { name: 'x_ftl_vcenter_etl.incident_group',    value: '',                                description: 'Assignment group sys_id for failure incidents' },
    { name: 'x_ftl_vcenter_etl.retirement_approver', value: '',                              description: 'User sys_id for CI retirement approvals' }
];

// ─── Deployer ──────────────────────────────────────────────────────────────────
class Deployer {
    constructor(client, dryRun = false) {
        this.snc    = client;
        this.dryRun = dryRun;
        this.scopeSysId     = null; // sys_id of the scoped app record
        this.tableSysIds    = {};   // intended name → sys_id
        this.tableActualNames = {}; // intended name → actual stored name (PDI may prefix it)
        this.counts = { created: 0, skipped: 0, failed: 0, warned: 0 };
    }

    // ── Main entry point ────────────────────────────────────────────────────

    async run() {
        const start = Date.now();

        // 1. Scoped application
        head('Scoped Application');
        await this.ensureApp();

        // 2. Remove any tables from previous failed runs that got auto-prefixed
        //    by ServiceNow (e.g. x_63815_vcenter_0_x_ftl_vcenter_etl_*) so the
        //    idempotency check in ensureTable() finds the right name next time.
        await this.cleanupMisnamedTables();

        // 3. Tables
        head('Custom Tables & Fields');
        await this.ensureTables();

        // 3. CMDB extensions
        head('CMDB Custom Field Extensions');
        await this.ensureCMDBFields();

        // 4. Script Includes
        head('Script Includes');
        await this.cleanupDuplicateScriptIncludes();
        await this.ensureScriptIncludes();

        // 5. Properties
        head('System Properties');
        await this.ensureProperties();

        // 6. Scheduled job
        head('Scheduled Job');
        await this.ensureScheduledJob();

        // 7. Business rule
        head('Business Rule');
        await this.ensureBusinessRule();

        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        this.printSummary(elapsed);
    }

    // ── Scoped Application ──────────────────────────────────────────────────

    async ensureApp() {
        const existing = await this.snc.get('sys_scope', `scope=${SCOPE_NAME}`, 'sys_id,name,scope');
        if (existing) {
            this.scopeSysId = existing.sys_id;
            skip(`Scoped app '${SCOPE_NAME}' (sys_id: ${existing.sys_id})`);
            this.counts.skipped++;
            return;
        }

        if (this.dryRun) { dry(`CREATE sys_scope: ${SCOPE_NAME}`); return; }

        try {
            const result = await this.snc.post('sys_scope', APP_DEF);
            this.scopeSysId = result.sys_id;
            ok(`Created scoped app '${SCOPE_NAME}' (sys_id: ${this.scopeSysId})`);
            this.counts.created++;
        } catch (e) {
            fail(`Scoped app: ${e.message}`);
            this.counts.failed++;
        }
    }

    // ── Cleanup misnamed tables from prior failed runs ───────────────────────

    async cleanupMisnamedTables() {
        const expectedNames = new Set(TABLES.map(t => t.name));
        const rows = await this.snc.getAll('sys_db_object', 'nameLIKEvcenter_etl', 'sys_id,name');
        // Keep a row if its name IS an expected name OR ends with one (covers the
        // PDI-prefixed variant x_63815_vcenter_0_x_ftl_vcenter_etl_* which we now
        // handle via ENDSWITH lookups rather than deleting and re-creating).
        const wrongOnes = rows.filter(r =>
            !expectedNames.has(r.name) &&
            !TABLES.some(t => r.name.endsWith(t.name))
        );
        if (wrongOnes.length === 0) return;

        head('Cleanup: Removing misnamed tables from prior run');
        for (const row of wrongOnes) {
            if (this.dryRun) { dry(`Would delete misnamed table: ${row.name}`); continue; }
            try {
                await this.snc.delete('sys_db_object', row.sys_id);
                ok(`Deleted: ${row.name}`);
            } catch (e) {
                fail(`Could not delete ${row.name}: ${e.message}`);
            }
        }
    }

    // ── Tables & Fields ──────────────────────────────────────────────────────

    async ensureTables() {
        for (const tbl of TABLES) {
            await this.ensureTable(tbl);
        }
        for (const tbl of TABLES) {
            for (const field of tbl.fields) {
                await this.ensureField(tbl.name, field);
            }
        }
    }

    async ensureTable(tbl) {
        // PDI always stores tables with an auto-prefix (e.g. x_63815_vcenter_0_).
        // Use ENDSWITH so we find the table on re-runs even if the stored name
        // differs from the intended name.
        const existing = await this.snc.get('sys_db_object',
            `nameENDSWITH${tbl.name}`, 'sys_id,name');
        if (existing) {
            this.tableSysIds[tbl.name]     = existing.sys_id;
            this.tableActualNames[tbl.name] = existing.name;
            skip(`Table: ${tbl.name}`);
            this.counts.skipped++;
            return;
        }

        if (this.dryRun) { dry(`CREATE table: ${tbl.name}`); return; }

        try {
            const result = await this.snc.post('sys_db_object', { name: tbl.name, label: tbl.label });
            this.tableSysIds[tbl.name] = result.sys_id;
            // Re-fetch by sys_id to get the actual stored name (PDI may have
            // prepended its developer scope prefix).
            const actual = await this.snc.get('sys_db_object',
                `sys_id=${result.sys_id}`, 'sys_id,name');
            this.tableActualNames[tbl.name] = actual?.name || tbl.name;
            ok(`Table: ${tbl.name}`);
            this.counts.created++;
        } catch (e) {
            fail(`Table ${tbl.name}: ${e.message}`);
            this.counts.failed++;
        }
    }

    async ensureField(tableName, field) {
        // Always use the actual stored name so the sys_dictionary query matches
        // what ServiceNow really has (the PDI-prefixed variant).
        const actualName = this.tableActualNames[tableName] || tableName;

        const existing = await this.snc.get('sys_dictionary',
            `name=${actualName}^element=${field.element}`, 'sys_id');
        if (existing) {
            this.counts.skipped++;
            return; // silent skip for fields — too noisy otherwise
        }

        if (this.dryRun) { dry(`  field: ${tableName}.${field.element}`); return; }

        const payload = {
            name:         actualName,   // actual stored table name, not the intended one
            element:      field.element,
            column_label: field.column_label,
            max_length:   String(field.max_length || 255),
            active:       'true',
            ...(field.default_value !== undefined && { default_value: field.default_value })
        };

        try {
            // Look up internal_type sys_id from sys_glide_object
            const typeRecord = await this.snc.get('sys_glide_object',
                `name=${field.internal_type}`, 'sys_id');
            if (typeRecord) payload.internal_type = typeRecord.sys_id;
            else            payload.internal_type = field.internal_type; // fallback

            await this.snc.post('sys_dictionary', payload);
            ok(`  + field: ${tableName}.${field.element} (${field.internal_type})`);
            this.counts.created++;
        } catch (e) {
            fail(`  field ${tableName}.${field.element}: ${e.message}`);
            this.counts.failed++;
        }
    }

    // ── CMDB Custom Fields ───────────────────────────────────────────────────

    async ensureCMDBFields() {
        for (const ext of CMDB_FIELD_EXTENSIONS) {
            const existing = await this.snc.get('sys_dictionary',
                `name=${ext.table}^element=${ext.element}`, 'sys_id');
            if (existing) {
                this.counts.skipped++;
                continue;
            }

            if (this.dryRun) {
                dry(`CMDB field: ${ext.table}.${ext.element}`);
                continue;
            }

            const payload = {
                name:         ext.table,
                element:      ext.element,
                column_label: ext.column_label,
                max_length:   String(ext.max_length || 255),
                active:       'true'
            };

            try {
                const typeRecord = await this.snc.get('sys_glide_object',
                    `name=${ext.internal_type}`, 'sys_id');
                if (typeRecord) payload.internal_type = typeRecord.sys_id;
                else            payload.internal_type = ext.internal_type;

                await this.snc.post('sys_dictionary', payload);
                ok(`${ext.table}.${ext.element}`);
                this.counts.created++;
            } catch (e) {
                // CMDB tables (cmdb_ci_*) are often ACL-protected in PDIs and cannot
                // be extended via REST.  Treat as a warning so it doesn't mask real
                // failures — these fields can be added manually in Studio if needed.
                console.log(`${C.yellow}  ⚠${C.reset} ${ext.table}.${ext.element}: ${e.message}`);
                this.counts.warned++;
            }
        }
    }

    // ── Script Includes ──────────────────────────────────────────────────────

    async cleanupDuplicateScriptIncludes() {
        for (const si of SCRIPT_INCLUDES) {
            const rows = await this.snc.getAll('sys_script_include',
                `name=${si.name}`, 'sys_id,name,sys_updated_on');
            if (rows.length <= 1) continue;

            // Keep the most-recently-updated record, delete the rest
            rows.sort((a, b) => (b.sys_updated_on > a.sys_updated_on ? 1 : -1));
            head(`Dedup Script Includes: ${si.name} (${rows.length} copies → 1)`);
            for (let i = 1; i < rows.length; i++) {
                if (this.dryRun) { dry(`Would delete duplicate SI sys_id: ${rows[i].sys_id}`); continue; }
                try {
                    await this.snc.delete('sys_script_include', rows[i].sys_id);
                    ok(`  Deleted duplicate (${rows[i].sys_id})`);
                } catch (e) {
                    fail(`  Could not delete duplicate (${rows[i].sys_id}): ${e.message}`);
                }
            }
        }
    }

    async ensureScriptIncludes() {
        for (const si of SCRIPT_INCLUDES) {
            const apiName = `${SCOPE_NAME}.${si.name}`;

            // Check by name only — the scope join filter was unreliable and
            // caused a new copy to be created on every run.
            const existing = await this.snc.get('sys_script_include',
                `name=${si.name}`, 'sys_id,name');

            if (existing) {
                skip(`Script Include: ${si.name}`);
                this.counts.skipped++;
                continue;
            }

            const filePath = path.join(SI_DIR, si.file);
            if (!fs.existsSync(filePath)) {
                fail(`Script Include ${si.name}: file not found at ${filePath}`);
                this.counts.failed++;
                continue;
            }

            if (this.dryRun) { dry(`Script Include: ${si.name}`); continue; }

            const script = fs.readFileSync(filePath, 'utf-8');
            const payload = {
                name:             si.name,
                api_name:         apiName,
                script:           script,
                client_callable:  'false',
                active:           'true',
                ...(this.scopeSysId && { sys_scope: this.scopeSysId })
            };

            try {
                await this.snc.post('sys_script_include', payload);
                ok(`Script Include: ${si.name}`);
                this.counts.created++;
            } catch (e) {
                fail(`Script Include ${si.name}: ${e.message}`);
                this.counts.failed++;
            }
        }
    }

    // ── System Properties ────────────────────────────────────────────────────

    async ensureProperties() {
        for (const prop of PROPERTIES) {
            const existing = await this.snc.get('sys_properties', `name=${prop.name}`, 'sys_id,value');

            if (existing) {
                skip(`Property: ${prop.name} = "${existing.value || '(blank)'}"`);
                this.counts.skipped++;
                continue;
            }

            if (this.dryRun) { dry(`Property: ${prop.name} = "${prop.value}"`); continue; }

            try {
                await this.snc.post('sys_properties', {
                    name:        prop.name,
                    value:       prop.value,
                    description: prop.description,
                    type:        'string',
                    ...(this.scopeSysId && { sys_scope: this.scopeSysId })
                });
                ok(`Property: ${prop.name} = "${prop.value || '(blank)'}"`);
                this.counts.created++;
            } catch (e) {
                fail(`Property ${prop.name}: ${e.message}`);
                this.counts.failed++;
            }
        }
    }

    // ── Scheduled Job ────────────────────────────────────────────────────────

    async ensureScheduledJob() {
        const jobName = 'vCenter CMDB Daily Import';

        const existing = await this.snc.get('sysauto_script',
            `name=${jobName}`, 'sys_id,active');

        if (existing) {
            skip(`Scheduled job: ${jobName}`);
            this.counts.skipped++;
            return;
        }

        const filePath = path.join(JOB_DIR, 'VCenterDailyImportJob.js');
        if (!fs.existsSync(filePath)) {
            fail(`Scheduled job: file not found at ${filePath}`);
            this.counts.failed++;
            return;
        }

        if (this.dryRun) { dry(`Scheduled job: ${jobName}`); return; }

        const script = fs.readFileSync(filePath, 'utf-8');
        try {
            await this.snc.post('sysauto_script', {
                name:              jobName,
                script:            script,
                run_type:          'daily',
                run_time:          '00:00:00',
                active:            'false',   // deliberately disabled — enable after testing
                run_as:            '',
                ...(this.scopeSysId && { sys_scope: this.scopeSysId })
            });
            ok(`Scheduled job: ${jobName} (created INACTIVE — enable after first successful test)`);
            this.counts.created++;
        } catch (e) {
            fail(`Scheduled job: ${e.message}`);
            this.counts.failed++;
        }
    }

    // ── Business Rule ────────────────────────────────────────────────────────

    async ensureBusinessRule() {
        const brName = 'vCenter ETL - CI Retirement Cascade';

        const existing = await this.snc.get('sys_script',
            `name=${brName}`, 'sys_id');

        if (existing) {
            skip(`Business rule: ${brName}`);
            this.counts.skipped++;
            return;
        }

        const filePath = path.join(BR_DIR, 'vcenter_staleness_br.js');
        if (!fs.existsSync(filePath)) {
            fail(`Business rule: file not found at ${filePath}`);
            this.counts.failed++;
            return;
        }

        if (this.dryRun) { dry(`Business rule: ${brName}`); return; }

        const script = fs.readFileSync(filePath, 'utf-8');
        try {
            await this.snc.post('sys_script', {
                name:       brName,
                collection: 'cmdb_ci',
                script:     script,
                action_insert:  'false',
                action_update:  'true',
                action_delete:  'false',
                action_query:   'false',
                when:       'before',
                active:     'true',
                condition:  "current.discovery_source == 'vCenterETL' && current.install_status.changesTo('7')",
                ...(this.scopeSysId && { sys_scope: this.scopeSysId })
            });
            ok(`Business rule: ${brName}`);
            this.counts.created++;
        } catch (e) {
            fail(`Business rule: ${e.message}`);
            this.counts.failed++;
        }
    }

    // ── Summary ──────────────────────────────────────────────────────────────

    printSummary(elapsed) {
        console.log('');
        info('═'.repeat(55));
        info(`  Deployment ${this.dryRun ? '(DRY RUN) ' : ''}complete in ${elapsed}s`);
        info('═'.repeat(55));
        console.log(`  ${C.green}Created:${C.reset}  ${this.counts.created}`);
        console.log(`  ${C.yellow}Skipped:${C.reset}  ${this.counts.skipped}  (already existed)`);
        if (this.counts.warned > 0)
            console.log(`  ${C.yellow}Warned:${C.reset}   ${this.counts.warned}  (CMDB extensions — PDI ACL restriction, add manually if needed)`);
        console.log(`  ${C.red}Failed:${C.reset}   ${this.counts.failed}`);
        info('═'.repeat(55));

        if (this.counts.failed === 0) {
            console.log(`\n${C.bold}${C.green}  ✓ Deployment succeeded!${C.reset}\n`);
            if (this.counts.warned > 0) {
                console.log(`  ${C.yellow}Note:${C.reset} ${this.counts.warned} CMDB field extension(s) could not be created via REST.`);
                console.log('  To add them manually: System Definition → Dictionary → New');
                console.log('  Tables: cmdb_ci_esx_server, cmdb_ci_vmware_instance, cmdb_ci_vcenter,');
                console.log('          cmdb_ci_cluster, cmdb_ci_dvs_switch, cmdb_ci_datastore\n');
            }
            console.log('  Next steps:');
            console.log('  1. Configure Connection & Credential Alias in ServiceNow:');
            console.log('     Connections & Credentials → Aliases → x_ftl_vcenter_etl.vcenter_conn');
            console.log('  2. Update sys_properties with your vCenter host + MID Server name.');
            console.log('  3. Run the pipeline from Background Scripts:');
            console.log(`     var o = new x_ftl_vcenter_etl.VCenterETLOrchestrator();`);
            console.log(`     gs.info(JSON.stringify(o.run()));`);
            console.log('  4. After a successful test, enable the scheduled job.');
        } else {
            console.log(`\n${C.bold}${C.red}  ✗ Deployment completed with ${this.counts.failed} failure(s).${C.reset}`);
            console.log('    Review the errors above, fix the issue, and re-run.');
            console.log('    The script is idempotent — it will skip already-created items.');
        }
        console.log('');
    }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    console.log('');
    info('╔══════════════════════════════════════════════════════╗');
    info('║  vCenter CMDB ETL — ServiceNow PDI Deployer v1.0.0  ║');
    info('╚══════════════════════════════════════════════════════╝');
    console.log('');

    loadDotEnv();
    const args = parseArgs();

    // Resolve credentials
    const instance = args.instance || process.env.SNC_INSTANCE ||
        await prompt('ServiceNow instance URL (e.g. https://dev12345.service-now.com): ');
    const username = args.username || process.env.SNC_USERNAME ||
        await prompt('Username: ');
    const password = args.password || process.env.SNC_PASSWORD ||
        await prompt('Password: ', true);

    if (!instance || !username || !password) {
        console.error(`${C.red}Error: instance URL, username and password are all required.${C.reset}`);
        process.exit(1);
    }

    const instanceUrl = instance.startsWith('http') ? instance : `https://${instance}`;
    const client      = new SNClient(instanceUrl, username, password);

    // Validate credentials
    console.log('');
    info(`Connecting to: ${instanceUrl}`);
    try {
        await client.validate();
        ok('Connection and credentials validated');
    } catch (e) {
        fail(e.message);
        process.exit(1);
    }

    if (args.check) {
        console.log('');
        info('DRY RUN — no changes will be made');
    }

    // Run deployment
    const deployer = new Deployer(client, args.check);
    await deployer.run();
}

main().catch((err) => {
    console.error(`\n${C.red}Fatal error: ${err.message}${C.reset}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
});
