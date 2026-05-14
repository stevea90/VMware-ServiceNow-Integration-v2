/**
 * Unit Tests: VCenterStagingLoader
 *
 * Tests staging table upsert behaviour with mock data.
 * Cleans up all test records after completion.
 *
 * Run in ServiceNow Background Scripts.
 */

(function testVCenterStagingLoader() {

    var utils   = new x_ftl_vcenter_etl.VCenterUtils();
    var runId   = 'TEST-' + utils.generateRunId();
    var loader  = new x_ftl_vcenter_etl.VCenterStagingLoader(runId);
    var passed  = 0;
    var failed  = 0;

    function assert(label, expected, actual) {
        if (String(expected) === String(actual)) {
            passed++;
            gs.info('  ✓ ' + label);
        } else {
            failed++;
            gs.error('  ✗ ' + label + ' | expected=' + expected + ' actual=' + actual);
        }
    }

    gs.info('=== VCenterStagingLoader Unit Tests (RunID: ' + runId + ') ===');

    // ── Test 1: Load a VM ────────────────────────────────────────────────────
    var mockVM = {
        vm: 'vm-unit-test-001',
        name: 'UNIT-TEST-VM-01',
        power_state: 'POWERED_ON',
        guest_OS: 'RHEL_8_64',
        hardware_version: 'vmx-19',
        identity: {
            name: 'unit-test-vm-01.corp.example.com',
            bios_uuid: 'unit-bios-uuid-001',
            instance_uuid: 'unit-inst-uuid-001'
        },
        placement: {
            host: 'host-unit-01',
            cluster: 'cluster-unit-01',
            datacenter: 'dc-unit-01'
        },
        cpu: { count: 4, cores_per_socket: 2 },
        memory: { size_MiB: 8192 },
        disks: [{ key: 2000 }, { key: 2001 }],
        nics: [{ key: 4000 }]
    };

    var result1 = loader.loadVM(mockVM);
    assert('loadVM returns inserted', 'inserted', result1);

    // Verify fields in staging
    var stg1 = new GlideRecord('x_ftl_vcenter_etl_vm_stg');
    stg1.addQuery('moref',  'vm-unit-test-001');
    stg1.addQuery('run_id', runId);
    stg1.setLimit(1);
    stg1.query();

    if (stg1.next()) {
        assert('VM name staged',          'UNIT-TEST-VM-01',           stg1.getValue('name'));
        assert('VM instance_uuid staged', 'unit-inst-uuid-001',        stg1.getValue('instance_uuid'));
        assert('VM bios_uuid staged',     'unit-bios-uuid-001',        stg1.getValue('bios_uuid'));
        assert('VM host_ref staged',      'host-unit-01',              stg1.getValue('host_ref'));
        assert('VM cpu_count staged',     '4',                         stg1.getValue('cpu_count'));
        assert('VM memory_size_gb',       '8',                         stg1.getValue('memory_size_gb'));
        assert('VM num_disks',            '2',                         stg1.getValue('num_disks'));
        assert('VM num_nics',             '1',                         stg1.getValue('num_nics'));
        assert('VM stg_state',            'ready',                     stg1.getValue('stg_state'));
        assert('VM run_id',               runId,                       stg1.getValue('run_id'));
    } else {
        failed++;
        gs.error('  ✗ VM staging record NOT found');
    }

    // ── Test 2: Upsert (same MoRef, different name) ──────────────────────────
    var mockVM2 = Object.assign({}, mockVM, { name: 'UNIT-TEST-VM-01-RENAMED' });
    var result2 = loader.loadVM(mockVM2);
    assert('loadVM upsert returns updated', 'updated', result2);

    var stg2 = new GlideRecord('x_ftl_vcenter_etl_vm_stg');
    stg2.addQuery('moref', 'vm-unit-test-001');
    stg2.setLimit(1);
    stg2.query();
    if (stg2.next()) {
        assert('VM name updated after upsert', 'UNIT-TEST-VM-01-RENAMED', stg2.getValue('name'));
    }

    // ── Test 3: Load a Host ──────────────────────────────────────────────────
    var mockHost = {
        host: 'host-unit-test-001',
        name: 'unit-test-host-01.corp.example.com',
        cluster: 'cluster-unit-01',
        datacenter: 'dc-unit-01',
        power_state: 'POWERED_ON',
        connection_state: 'CONNECTED',
        cpu_count: 2,
        cpu_cores: 24,
        memory_size_MiB: 786432,
        model: 'ProLiant DL380 Gen10',
        vendor: 'HPE',
        bios_uuid: 'unit-host-bios-uuid-001',
        os_type: 'VMware ESXi'
    };

    var result3 = loader.loadHost(mockHost);
    assert('loadHost returns inserted', 'inserted', result3);

    var stg3 = new GlideRecord('x_ftl_vcenter_etl_host_stg');
    stg3.addQuery('moref',  'host-unit-test-001');
    stg3.addQuery('run_id', runId);
    stg3.setLimit(1);
    stg3.query();

    if (stg3.next()) {
        assert('Host name staged',      'unit-test-host-01.corp.example.com', stg3.getValue('name'));
        assert('Host bios_uuid staged', 'unit-host-bios-uuid-001',            stg3.getValue('bios_uuid'));
        assert('Host vendor staged',    'HPE',                                 stg3.getValue('vendor'));
        assert('Host cpu_count staged', '2',                                   stg3.getValue('cpu_count'));
    } else {
        failed++;
        gs.error('  ✗ Host staging record NOT found');
    }

    // ── Test 4: Skip record with no MoRef ────────────────────────────────────
    var mockBad = { name: 'NO-MOREF-VM' }; // no vm or moref field
    var result4 = loader.loadVM(mockBad);
    assert('loadVM no moref → skipped', 'skipped', result4);

    // ── Test 5: bulkLoad stats ───────────────────────────────────────────────
    var mockDCs = [
        { datacenter: 'dc-bulk-01', name: 'DC-BULK-01' },
        { datacenter: 'dc-bulk-02', name: 'DC-BULK-02' },
        { datacenter: 'dc-bulk-03', name: 'DC-BULK-03' }
    ];
    var bulkResult = loader.bulkLoad('datacenter', mockDCs);
    assert('bulkLoad inserted 3', '3', bulkResult.inserted);
    assert('bulkLoad 0 errors',   '0', bulkResult.errors);

    // ── Cleanup ──────────────────────────────────────────────────────────────
    var cleanTables = [
        'x_ftl_vcenter_etl_vm_stg',
        'x_ftl_vcenter_etl_host_stg',
        'x_ftl_vcenter_etl_datacenter_stg'
    ];
    for (var i = 0; i < cleanTables.length; i++) {
        var del = new GlideRecord(cleanTables[i]);
        del.addQuery('run_id', runId);
        del.deleteMultiple();
    }
    // Also clean log records
    var logDel = new GlideRecord('x_ftl_vcenter_etl_log');
    logDel.addQuery('run_id', runId);
    logDel.deleteMultiple();

    gs.info('=== Results: ' + passed + ' passed, ' + failed + ' failed ===');

})();
