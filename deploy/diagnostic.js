#!/usr/bin/env node
/**
 * ServiceNow Deployment Diagnostic
 * Run this to see exactly why table creation is failing.
 * Usage: node diagnostic.js
 */
'use strict';
const fs   = require('fs');
const path = require('path');

function loadEnv() {
    const p = path.join(__dirname, '.env');
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const i = t.indexOf('=');
        if (i < 0) continue;
        const k = t.substring(0, i).trim();
        const v = t.substring(i + 1).trim().replace(/^["']|["']$/g, '');
        if (!process.env[k]) process.env[k] = v;
    }
}
loadEnv();

const BASE = (process.env.SNC_INSTANCE || '').replace(/\/$/, '');
const AUTH = 'Basic ' + Buffer.from(`${process.env.SNC_USERNAME}:${process.env.SNC_PASSWORD}`).toString('base64');
const H    = { Authorization: AUTH, 'Content-Type': 'application/json', Accept: 'application/json' };

async function req(method, path, body) {
    const res  = await fetch(`${BASE}${path}`, { method, headers: H, ...(body && { body: JSON.stringify(body) }) });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { _raw: text }; }
    return { status: res.status, body: json };
}

async function main() {
    console.log('=== ServiceNow Deployment Diagnostic ===');
    console.log('Instance:', BASE);
    console.log('');

    // 1. Connectivity
    console.log('--- 1. Connectivity ---');
    const conn = await req('GET', '/api/now/table/sys_user?sysparm_limit=1&sysparm_fields=user_name');
    console.log('HTTP:', conn.status, conn.status === 200 ? 'OK' : 'FAILED');
    if (conn.status !== 200) { console.log(JSON.stringify(conn.body, null, 2)); process.exit(1); }
    console.log('');

    // 2. Check scoped app in sys_scope
    console.log('--- 2. Scoped App (sys_scope) ---');
    const scope = await req('GET', '/api/now/table/sys_scope?sysparm_query=scope%3Dx_ftl_vcenter_etl&sysparm_fields=sys_id,name,scope,active,vendor');
    console.log('HTTP:', scope.status);
    console.log(JSON.stringify(scope.body?.result, null, 2));
    const scopeSysId = scope.body?.result?.[0]?.sys_id;
    console.log('scopeSysId:', scopeSysId || 'NOT FOUND');
    console.log('');

    // 3. Check scoped app in sys_app
    console.log('--- 3. Scoped App (sys_app) ---');
    const app = await req('GET', '/api/now/table/sys_app?sysparm_query=scope%3Dx_ftl_vcenter_etl&sysparm_fields=sys_id,name,scope,active');
    console.log('HTTP:', app.status);
    console.log(JSON.stringify(app.body?.result, null, 2));
    const appSysId = app.body?.result?.[0]?.sys_id;
    console.log('appSysId:', appSysId || 'NOT FOUND - this is likely the root cause');
    console.log('');

    // 4. Check if staging_base already exists
    console.log('--- 4. Existing Tables ---');
    const tbl = await req('GET', '/api/now/table/sys_db_object?sysparm_query=nameLIKEx_ftl_vcenter_etl&sysparm_fields=name,sys_id,sys_scope&sysparm_limit=20');
    console.log('HTTP:', tbl.status);
    const existing = tbl.body?.result || [];
    console.log('Existing x_ftl_vcenter_etl tables:', existing.length);
    existing.forEach(t => console.log(' -', t.name, '| scope:', t.sys_scope?.value || t.sys_scope));
    console.log('');

    // 5. Try creating a table WITHOUT sys_scope
    console.log('--- 5. Table Create (no sys_scope) ---');
    const t1 = await req('POST', '/api/now/table/sys_db_object', {
        name:  'x_ftl_vcenter_etl_diag_1',
        label: 'Diag Test 1 - no scope'
    });
    console.log('HTTP:', t1.status);
    console.log(JSON.stringify(t1.body?.error || t1.body?.result?.sys_id || t1.body, null, 2));
    const t1SysId = t1.body?.result?.sys_id;
    console.log('');

    // 6. Try creating a table WITH sys_scope (from sys_scope table)
    if (scopeSysId) {
        console.log('--- 6. Table Create (sys_scope from sys_scope) ---');
        const t2 = await req('POST', '/api/now/table/sys_db_object', {
            name:      'x_ftl_vcenter_etl_diag_2',
            label:     'Diag Test 2 - scope from sys_scope',
            sys_scope: scopeSysId
        });
        console.log('HTTP:', t2.status);
        console.log(JSON.stringify(t2.body?.error || t2.body?.result?.sys_id || t2.body, null, 2));
        console.log('');
    }

    // 7. Try creating a table WITH sys_scope (from sys_app table, if different)
    if (appSysId && appSysId !== scopeSysId) {
        console.log('--- 7. Table Create (sys_scope from sys_app) ---');
        const t3 = await req('POST', '/api/now/table/sys_db_object', {
            name:      'x_ftl_vcenter_etl_diag_3',
            label:     'Diag Test 3 - scope from sys_app',
            sys_scope: appSysId
        });
        console.log('HTTP:', t3.status);
        console.log(JSON.stringify(t3.body?.error || t3.body?.result?.sys_id || t3.body, null, 2));
        console.log('');
    }

    // 8. Try creating table with display values (scope by name)
    console.log('--- 8. Table Create (display values, scope by name) ---');
    const t4 = await req('POST', '/api/now/table/sys_db_object?sysparm_input_display_value=true', {
        name:      'x_ftl_vcenter_etl_diag_4',
        label:     'Diag Test 4 - display value',
        sys_scope: 'vCenter CMDB ETL (FT1)'
    });
    console.log('HTTP:', t4.status);
    console.log(JSON.stringify(t4.body?.error || t4.body?.result?.sys_id || t4.body, null, 2));
    console.log('');

    // 9. Cleanup any test tables that were created
    console.log('--- 9. Cleanup ---');
    for (const testName of ['x_ftl_vcenter_etl_diag_1','x_ftl_vcenter_etl_diag_2','x_ftl_vcenter_etl_diag_3','x_ftl_vcenter_etl_diag_4']) {
        const find = await req('GET', `/api/now/table/sys_db_object?sysparm_query=name%3D${testName}&sysparm_fields=sys_id`);
        const id = find.body?.result?.[0]?.sys_id;
        if (id) {
            const del = await req('DELETE', `/api/now/table/sys_db_object/${id}`);
            console.log(`Deleted ${testName}: HTTP ${del.status}`);
        }
    }

    console.log('');
    console.log('=== Diagnostic Complete ===');
    console.log('Please send a screenshot of this output.');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
