# Testing Strategy

## Overview

Three testing tiers cover the full integration lifecycle:

1. **Unit Testing** — Script Include logic in isolation using mocked data
2. **Mock API Integration Testing** — Full pipeline against the Node.js mock server
3. **Production Smoke Testing** — Controlled initial run against real vCenter

---

## Tier 1: Unit Testing (No vCenter Required)

### Test Scripts for ServiceNow Background Script

Run these in: **System Definition > Scripts - Background**

#### Test 1: VCenterUtils

```javascript
// Test VCenterUtils field mappers
var utils = new x_ftl_vcenter_etl.VCenterUtils();

// Power state mapping
gs.info('POWERED_ON → ' + utils.mapPowerState('POWERED_ON'));   // expect: 1
gs.info('POWERED_OFF → ' + utils.mapPowerState('POWERED_OFF')); // expect: 2
gs.info('SUSPENDED → '   + utils.mapPowerState('SUSPENDED'));   // expect: 2

// Unit conversion
gs.info('1GB bytes → ' + utils.bytesToGB(1073741824));  // expect: 1
gs.info('2048 MB → GB: ' + utils.mbToGB(2048));        // expect: 2

// Run ID format
gs.info('Run ID: ' + utils.generateRunId());

// JSON helpers
var obj = {a: 1, b: 'test'};
var str = utils.toJSON(obj);
gs.info('JSON: ' + str);
gs.info('Parsed a: ' + utils.parseJSON(str).a); // expect: 1

// Nested get
var nested = {x: {y: {z: 'deep'}}};
gs.info('Nested: ' + utils.get(nested, 'x.y.z')); // expect: deep
gs.info('Missing: ' + utils.get(nested, 'x.y.q')); // expect: null
```

#### Test 2: VCenterConfig

```javascript
var cfg = new x_ftl_vcenter_etl.VCenterConfig();

// Validate required properties (will list missing ones)
var missing = cfg.validate();
if (missing.length > 0) {
    gs.info('Missing properties: ' + missing.join(', '));
} else {
    gs.info('All required properties are set');
}

gs.info('Discovery source: ' + cfg.discoverySource()); // expect: vCenterETL
gs.info('Page size: ' + cfg.pageSize());               // expect: 200
gs.info('Batch size: ' + cfg.batchSize());             // expect: 50
gs.info('Max retries: ' + cfg.maxRetries());           // expect: 3
```

#### Test 3: VCenterLogger

```javascript
var runId  = '20240101-000000-9999';
var logger = new x_ftl_vcenter_etl.VCenterLogger('TestSuite', runId);

logger.debug('Debug message — only visible if log_level=DEBUG');
logger.info('Info message');
logger.warn('Warning message');
logger.error('Error message');

// Check log table
var log = new GlideRecord('x_ftl_vcenter_etl_log');
log.addQuery('run_id', runId);
log.query();
var count = 0;
while (log.next()) {
    count++;
    gs.info('[' + log.getValue('level') + '] ' + log.getValue('message'));
}
gs.info('Total log entries: ' + count); // expect: 3 (or 4 with DEBUG level)
```

#### Test 4: VCenterStagingLoader (with mock data)

```javascript
var runId   = new x_ftl_vcenter_etl.VCenterUtils().generateRunId();
var loader  = new x_ftl_vcenter_etl.VCenterStagingLoader(runId);

// Mock VM data (matches virtual_machines.json format)
var mockVMs = [
    {
        vm: 'vm-test-001',
        name: 'TEST-VM-01',
        power_state: 'POWERED_ON',
        guest_OS: 'RHEL_8_64',
        hardware_version: 'vmx-19',
        identity: {
            name: 'test-vm-01.corp.example.com',
            bios_uuid: '42378462-TEST-0001',
            instance_uuid: '50237abc-TEST-0001'
        },
        placement: {
            host: 'host-test-01',
            cluster: 'cluster-test-01',
            datacenter: 'dc-test-01'
        },
        cpu: { count: 2, cores_per_socket: 2 },
        memory: { size_MiB: 4096 },
        disks: [{ key: 2000, label: 'Hard disk 1' }],
        nics: []
    }
];

var result = loader.bulkLoad('vm', mockVMs);
gs.info('Staging result: ' + JSON.stringify(result));
// expect: { inserted: 1, updated: 0, skipped: 0, errors: 0 }

// Verify staging record was created
var stg = new GlideRecord('x_ftl_vcenter_etl_vm_stg');
stg.addQuery('moref', 'vm-test-001');
stg.setLimit(1);
stg.query();
if (stg.next()) {
    gs.info('Staging record found: name=' + stg.getValue('name'));
    gs.info('Instance UUID: ' + stg.getValue('instance_uuid'));
} else {
    gs.error('Staging record NOT found — test failed');
}

// Cleanup
var del = new GlideRecord('x_ftl_vcenter_etl_vm_stg');
del.addQuery('run_id', runId);
del.deleteMultiple();
gs.info('Cleanup complete');
```

#### Test 5: VCenterIREPayloadBuilder

```javascript
// Simulate a staging row and verify payload structure
var builder = new x_ftl_vcenter_etl.VCenterIREPayloadBuilder('test-run');

// Create a mock staging GlideRecord using a real staging row
var stg = new GlideRecord('x_ftl_vcenter_etl_vm_stg');
stg.initialize();
stg.setValue('moref',         'vm-mock-001');
stg.setValue('name',          'MOCK-VM-01');
stg.setValue('instance_uuid', 'uuid-inst-001');
stg.setValue('bios_uuid',     'uuid-bios-001');
stg.setValue('power_state',   'POWERED_ON');
stg.setValue('cpu_count',     '4');
stg.setValue('memory_size_gb','8');

var payload = builder.buildVMPayload(stg);
gs.info('Payload className: ' + payload.className);
// expect: cmdb_ci_vmware_instance

gs.info('Payload values.correlation_id: ' + payload.values.correlation_id);
// expect: vm-mock-001

gs.info('Payload identifiers count: ' + payload.identifiers.length);
// expect: 3

gs.info('discovery_source: ' + payload.values.discovery_source);
// expect: vCenterETL

gs.info('Payload structure OK: ' + JSON.stringify(payload.values));
```

#### Test 6: VCenterRelationshipBuilder

```javascript
// Test relationship type lookup
var relBuilder = new x_ftl_vcenter_etl.VCenterRelationshipBuilder('test-run');

var relTypeId = relBuilder._getRelTypeId('Contains::Contained by');
gs.info('Contains::Contained by type ID: ' + relTypeId);

var relTypeId2 = relBuilder._getRelTypeId('Hosts::Hosted by');
gs.info('Hosts::Hosted by type ID: ' + relTypeId2);

var relTypeId3 = relBuilder._getRelTypeId('Uses::Used by');
gs.info('Uses::Used by type ID: ' + relTypeId3);

// All should be non-empty strings
gs.info('Relationship types: ' +
    [relTypeId, relTypeId2, relTypeId3].every(Boolean) ? 'OK' : 'MISSING TYPES');
```

---

## Tier 2: Mock API Integration Testing

### Setup

1. Start the mock server:
   ```bash
   cd mock/server
   npm install
   node mock_vcenter_api.js 8080
   ```

2. Configure sys_properties to point to mock server:
   ```
   x_ftl_vcenter_etl.vcenter_host     = <mock-server-ip>:8080
   x_ftl_vcenter_etl.connection_alias = x_ftl_vcenter_etl.vcenter_conn_mock
   ```

3. Create a test Connection Alias pointing to `http://<mock-server-ip>:8080`
   with any credential (mock server accepts all).

### Integration Test Script

```javascript
// Full ETL pipeline test with mock server
// Run in Background Scripts

gs.info('=== vCenter ETL Integration Test START ===');

var orchestrator = new x_ftl_vcenter_etl.VCenterETLOrchestrator();
var summary      = orchestrator.run();

gs.info('Run ID:   ' + summary.runId);
gs.info('Status:   ' + summary.status);
gs.info('Duration: ' + summary.duration);
gs.info('Phases:   ' + JSON.stringify(summary.phases, null, 2));

// Verify CMDB was populated
var checks = [
    { table: 'cmdb_ci_vcenter',         expected: 1  },
    { table: 'cmdb_ci_datacenter',      expected: 2  },
    { table: 'cmdb_ci_cluster',         expected: 3  },
    { table: 'cmdb_ci_esx_server',      expected: 4  },
    { table: 'cmdb_ci_vmware_instance', expected: 4  },
    { table: 'cmdb_ci_datastore',       expected: 4  },
    { table: 'cmdb_ci_dvs_switch',      expected: 2  }
];

for (var i = 0; i < checks.length; i++) {
    var gr = new GlideRecord(checks[i].table);
    gr.addQuery('discovery_source', 'vCenterETL');
    gr.query();
    var count = gr.getRowCount();
    var status = count >= checks[i].expected ? '✓' : '✗';
    gs.info(status + ' ' + checks[i].table + ': ' + count +
        ' (expected >= ' + checks[i].expected + ')');
}

// Verify relationships
var rels = new GlideRecord('cmdb_rel_ci');
rels.addQuery('parent.discovery_source', 'vCenterETL');
rels.query();
gs.info('Total relationships: ' + rels.getRowCount());

gs.info('=== Integration Test COMPLETE ===');
```

### Verifying Specific Relationships

```javascript
// Check Host → VM relationships
var hostVMRels = new GlideRecord('cmdb_rel_ci');
hostVMRels.addQuery('type.name', 'Hosts::Hosted by');
hostVMRels.addQuery('parent.discovery_source', 'vCenterETL');
hostVMRels.query();
gs.info('Host→VM relationships: ' + hostVMRels.getRowCount()); // expect: 4

// Check Cluster → Host relationships
var clusterHostRels = new GlideRecord('cmdb_rel_ci');
clusterHostRels.addQuery('type.name', 'Contains::Contained by');
clusterHostRels.addQuery('parent.sys_class_name', 'cmdb_ci_cluster');
clusterHostRels.query();
gs.info('Cluster→Host relationships: ' + clusterHostRels.getRowCount());
```

---

## Tier 3: Production Smoke Testing

### Pre-Production Checklist

- [ ] MID Server is Up and validated
- [ ] Connection & Credential Alias is configured
- [ ] All required sys_properties are set (validate with `VCenterConfig.validate()`)
- [ ] vCenter service account has read-only API access
- [ ] CMDB backup taken (or PDI is being used)
- [ ] Log level set to DEBUG for first run
- [ ] Notification email configured

### First Run (Limited Scope)

Modify `VCenterAPIClient.getVMs()` to limit initial pull:
```javascript
getVMs: function() {
    // Limit to 50 VMs for first test run
    return this._getPaginated('/api/vcenter/vm', {'filter.limit': 50});
}
```

### Validation Steps

After first production run:

1. Check run record:
   ```
   x_ftl_vcenter_etl_run → Status = success, Duration reasonable
   ```

2. Spot-check CIs in CMDB:
   - Search `cmdb_ci_esx_server` where `discovery_source=vCenterETL`
   - Compare name/IP against known vCenter inventory

3. Verify relationships:
   - Open a Host CI → Related Items → Hosted VMs should appear
   - Open a Cluster CI → Related Items → Hosts should appear

4. Check log for errors:
   ```
   x_ftl_vcenter_etl_log → filter by level=ERROR
   ```

5. Increase to full pull by removing the limit, re-run.

---

## Automated Test Recommendations

### ATF (Automated Test Framework) Tests

Create ATF test suites in ServiceNow for:

1. **Script Include Unit Tests**
   - Test each `VCenterUtils` method with boundary values
   - Test retry handler with simulated failures

2. **Staging Load Tests**
   - Insert mock staging data → verify correct field mapping
   - Test upsert behaviour (second load same MoRef → update, not insert)

3. **Transform Tests**
   - Load staging row → run transform → verify CMDB CI values

4. **Relationship Tests**
   - Create staging rows for parent + child → run relationship builder
   - Verify `cmdb_rel_ci` record created with correct type

5. **Staleness Tests**
   - Insert a CI with old `sys_updated_on`
   - Run staleness manager
   - Verify `install_status=7`

### CI Regression Tests (after each deployment)

```javascript
// Smoke test — run after every Update Set deployment
var expected = [
    'VCenterAPIClient', 'VCenterETLOrchestrator', 'VCenterStagingLoader',
    'VCenterTransformEngine', 'VCenterIREPayloadBuilder', 'VCenterRelationshipBuilder',
    'VCenterStalenessManager', 'VCenterLogger', 'VCenterRetryHandler',
    'VCenterConfig', 'VCenterUtils'
];

for (var i = 0; i < expected.length; i++) {
    var si = new GlideRecord('sys_script_include');
    si.addQuery('name', expected[i]);
    si.addQuery('sys_scope.scope', 'x_ftl_vcenter_etl');
    si.setLimit(1);
    si.query();
    var status = si.next() ? '✓' : '✗ MISSING';
    gs.info(status + ' Script Include: ' + expected[i]);
}
```

---

## Test Data Management

### Reset Staging Tables Between Test Runs

```javascript
// CAUTION: Deletes all staging data — use in PDI only
var tables = [
    'x_ftl_vcenter_etl_vcenter_stg',
    'x_ftl_vcenter_etl_datacenter_stg',
    'x_ftl_vcenter_etl_cluster_stg',
    'x_ftl_vcenter_etl_host_stg',
    'x_ftl_vcenter_etl_vm_stg',
    'x_ftl_vcenter_etl_datastore_stg',
    'x_ftl_vcenter_etl_ds_cluster_stg',
    'x_ftl_vcenter_etl_dvs_stg'
];
for (var i = 0; i < tables.length; i++) {
    var gr = new GlideRecord(tables[i]);
    gr.deleteAll();
    gs.info('Cleared: ' + tables[i]);
}
```

### Reset ETL-Managed CMDB CIs

```javascript
// CAUTION: Removes all vCenterETL CIs from CMDB — PDI only
var cmdbTables = [
    'cmdb_ci_vcenter', 'cmdb_ci_datacenter', 'cmdb_ci_cluster',
    'cmdb_ci_esx_server', 'cmdb_ci_vmware_instance',
    'cmdb_ci_datastore', 'cmdb_ci_storage_pool', 'cmdb_ci_dvs_switch'
];
for (var i = 0; i < cmdbTables.length; i++) {
    var gr = new GlideRecord(cmdbTables[i]);
    gr.addQuery('discovery_source', 'vCenterETL');
    gr.deleteMultiple();
    gs.info('Cleared vCenterETL CIs from: ' + cmdbTables[i]);
}
```
