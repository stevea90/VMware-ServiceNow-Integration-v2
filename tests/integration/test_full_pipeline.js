/**
 * Integration Test: Full ETL Pipeline
 *
 * Prerequisites:
 *   1. Mock API server running on <mock-server>:8080
 *   2. Connection Alias configured to point to mock server
 *   3. All Script Includes deployed
 *   4. All staging tables created
 *
 * Run in ServiceNow Background Scripts.
 *
 * This test performs a complete ETL run and validates:
 *   - All object types are staged
 *   - All CMDB CIs are created/updated
 *   - All relationships are created
 *   - Run record is complete
 */

(function testFullPipeline() {

    var passed = 0;
    var failed = 0;

    function assert(label, expected, actual) {
        if (String(expected) === String(actual)) {
            passed++;
            gs.info('  ✓ ' + label);
        } else {
            failed++;
            gs.error('  ✗ ' + label + ' | expected=' + expected + ' actual=' + actual);
        }
    }

    function assertGT(label, min, actual) {
        if (parseInt(actual) >= parseInt(min)) {
            passed++;
            gs.info('  ✓ ' + label + ' (' + actual + ' >= ' + min + ')');
        } else {
            failed++;
            gs.error('  ✗ ' + label + ' | actual=' + actual + ' min=' + min);
        }
    }

    gs.info('');
    gs.info('=== vCenter ETL Full Pipeline Integration Test ===');
    gs.info('');

    // ── Step 1: Pre-run validation ────────────────────────────────────────────
    gs.info('-- Step 1: Configuration Validation --');

    var cfg = new x_ftl_vcenter_etl.VCenterConfig();
    var missing = cfg.validate();
    assert('All required properties set', '0', missing.length);

    if (missing.length > 0) {
        gs.error('Cannot proceed — missing: ' + missing.join(', '));
        return;
    }

    // ── Step 2: Run ETL Pipeline ──────────────────────────────────────────────
    gs.info('-- Step 2: ETL Pipeline Execution --');

    var orchestrator = new x_ftl_vcenter_etl.VCenterETLOrchestrator();
    var runId        = orchestrator.runId;
    var summary      = orchestrator.run();

    gs.info('Run ID:   ' + summary.runId);
    gs.info('Status:   ' + summary.status);
    gs.info('Duration: ' + summary.duration);

    assert('Pipeline status = success', 'success', summary.status);
    assert('Run ID is present', 'true', summary.runId.length > 0);

    // ── Step 3: Validate Staging Tables ──────────────────────────────────────
    gs.info('-- Step 3: Staging Table Validation --');

    var stagingChecks = [
        { table: 'x_ftl_vcenter_etl_vcenter_stg',    min: 1 },
        { table: 'x_ftl_vcenter_etl_datacenter_stg', min: 2 },
        { table: 'x_ftl_vcenter_etl_cluster_stg',    min: 3 },
        { table: 'x_ftl_vcenter_etl_host_stg',       min: 4 },
        { table: 'x_ftl_vcenter_etl_vm_stg',         min: 4 },
        { table: 'x_ftl_vcenter_etl_datastore_stg',  min: 4 },
        { table: 'x_ftl_vcenter_etl_dvs_stg',        min: 2 }
    ];

    for (var i = 0; i < stagingChecks.length; i++) {
        var stg = new GlideRecord(stagingChecks[i].table);
        stg.addQuery('run_id', runId);
        stg.query();
        assertGT(stagingChecks[i].table + ' staged count',
            stagingChecks[i].min, stg.getRowCount());

        // Check no error state rows
        var errStg = new GlideRecord(stagingChecks[i].table);
        errStg.addQuery('run_id', runId);
        errStg.addQuery('stg_state', 'error');
        errStg.query();
        assert(stagingChecks[i].table + ' - 0 error rows',
            '0', errStg.getRowCount());
    }

    // ── Step 4: Validate CMDB CIs ────────────────────────────────────────────
    gs.info('-- Step 4: CMDB CI Validation --');

    var cmdbChecks = [
        { table: 'cmdb_ci_vcenter',          min: 1  },
        { table: 'cmdb_ci_datacenter',       min: 2  },
        { table: 'cmdb_ci_cluster',          min: 3  },
        { table: 'cmdb_ci_esx_server',       min: 4  },
        { table: 'cmdb_ci_vmware_instance',  min: 4  },
        { table: 'cmdb_ci_datastore',        min: 4  },
        { table: 'cmdb_ci_dvs_switch',       min: 2  }
    ];

    for (var j = 0; j < cmdbChecks.length; j++) {
        var ci = new GlideRecord(cmdbChecks[j].table);
        ci.addQuery('discovery_source', 'vCenterETL');
        ci.query();
        assertGT(cmdbChecks[j].table + ' CI count',
            cmdbChecks[j].min, ci.getRowCount());
    }

    // Spot-check VM attributes
    var vm = new GlideRecord('cmdb_ci_vmware_instance');
    vm.addQuery('discovery_source', 'vCenterETL');
    vm.addQuery('name', 'WEB-APP-01');
    vm.setLimit(1);
    vm.query();
    if (vm.next()) {
        assert('VM WEB-APP-01 found',           'true', 'true');
        assert('VM operational_status=1',       '1',    vm.getValue('operational_status'));
        assert('VM correlation_id set',         'true', vm.getValue('correlation_id').length > 0);
        assert('VM u_instance_uuid set',        'true', vm.getValue('u_instance_uuid').length > 0);
    } else {
        failed++;
        gs.error('  ✗ VM WEB-APP-01 not found in CMDB');
    }

    // Spot-check ESXi Host attributes
    var host = new GlideRecord('cmdb_ci_esx_server');
    host.addQuery('discovery_source', 'vCenterETL');
    host.addQuery('name', 'esxi-ft1-01.corp.example.com');
    host.setLimit(1);
    host.query();
    if (host.next()) {
        assert('ESXi host found',               'true', 'true');
        assert('Host u_bios_uuid set',          'true', host.getValue('u_bios_uuid').length > 0);
        assert('Host manufacturer = HPE',       'HPE',  host.getValue('manufacturer'));
    } else {
        failed++;
        gs.error('  ✗ ESXi host esxi-ft1-01 not found in CMDB');
    }

    // ── Step 5: Validate Relationships ───────────────────────────────────────
    gs.info('-- Step 5: Relationship Validation --');

    // Host → VM (Hosts::Hosted by)
    var hostVMRels = new GlideRecord('cmdb_rel_ci');
    hostVMRels.addQuery('type.name', 'Hosts::Hosted by');
    hostVMRels.addQuery('parent.discovery_source', 'vCenterETL');
    hostVMRels.query();
    assertGT('Host→VM relationships created', 1, hostVMRels.getRowCount());

    // Cluster → Host (Contains::Contained by)
    var clusterHostRels = new GlideRecord('cmdb_rel_ci');
    clusterHostRels.addQuery('type.name',              'Contains::Contained by');
    clusterHostRels.addQuery('parent.sys_class_name',  'cmdb_ci_cluster');
    clusterHostRels.addQuery('parent.discovery_source','vCenterETL');
    clusterHostRels.query();
    assertGT('Cluster→Host relationships created', 1, clusterHostRels.getRowCount());

    // ── Step 6: Validate Run Record ──────────────────────────────────────────
    gs.info('-- Step 6: Run Record Validation --');

    var run = new GlideRecord('x_ftl_vcenter_etl_run');
    run.addQuery('run_id', runId);
    run.setLimit(1);
    run.query();
    if (run.next()) {
        assert('Run status = success',    'success', run.getValue('status'));
        assert('Run started_at set',      'true',    run.getValue('started_at').length > 0);
        assert('Run ended_at set',        'true',    run.getValue('ended_at').length > 0);
        assert('Run stats_json set',      'true',    run.getValue('stats_json').length > 0);
    } else {
        failed++;
        gs.error('  ✗ Run record not found for run_id: ' + runId);
    }

    // ── Step 7: Validate Log Records ─────────────────────────────────────────
    gs.info('-- Step 7: Log Record Validation --');

    var logs = new GlideRecord('x_ftl_vcenter_etl_log');
    logs.addQuery('run_id', runId);
    logs.query();
    assertGT('Log records written', 5, logs.getRowCount());

    var errorLogs = new GlideRecord('x_ftl_vcenter_etl_log');
    errorLogs.addQuery('run_id', runId);
    errorLogs.addQuery('level',  'ERROR');
    errorLogs.query();
    assert('No error logs in successful run', '0', errorLogs.getRowCount());

    // ── Summary ───────────────────────────────────────────────────────────────
    gs.info('');
    gs.info('=== Integration Test Results: ' + passed + ' passed, ' + failed + ' failed ===');
    if (failed > 0) {
        gs.error('INTEGRATION TEST FAILED — see errors above');
    } else {
        gs.info('ALL INTEGRATION TESTS PASSED');
    }

})();
