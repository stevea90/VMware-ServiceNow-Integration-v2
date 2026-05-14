/**
 * Unit Tests: VCenterUtils
 *
 * Run in ServiceNow Background Scripts:
 *   System Definition > Scripts - Background
 *
 * Tests: Power state mapping, unit conversion, JSON helpers,
 *        nested property access, run ID generation.
 */

(function testVCenterUtils() {

    var utils   = new x_ftl_vcenter_etl.VCenterUtils();
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

    gs.info('=== VCenterUtils Unit Tests ===');

    // Power state mapping
    assert('POWERED_ON → 1',  '1', utils.mapPowerState('POWERED_ON'));
    assert('POWERED_OFF → 2', '2', utils.mapPowerState('POWERED_OFF'));
    assert('SUSPENDED → 2',   '2', utils.mapPowerState('SUSPENDED'));
    assert('poweredOn → 1',   '1', utils.mapPowerState('poweredOn'));
    assert('unknown → 2',     '2', utils.mapPowerState('UNKNOWN'));

    // Connection state mapping
    assert('CONNECTED → 1',     '1', utils.mapConnectionState('CONNECTED'));
    assert('DISCONNECTED → 2',  '2', utils.mapConnectionState('DISCONNECTED'));

    // Byte conversion
    assert('1GB bytes → 1',    '1',  utils.bytesToGB(1073741824));
    assert('0 bytes → 0',      '0',  utils.bytesToGB(0));
    assert('1TB bytes → 1024', '1024', utils.bytesToGB(1099511627776));

    // MB to GB
    assert('1024 MB → 1',     '1',  utils.mbToGB(1024));
    assert('2048 MB → 2',     '2',  utils.mbToGB(2048));
    assert('512 MB → 0.5',    '0.5', utils.mbToGB(512));

    // JSON helpers
    var obj = { a: 1, b: 'test', c: null };
    var str = utils.toJSON(obj);
    assert('toJSON returns string',  'true', typeof str === 'string');
    var parsed = utils.parseJSON(str);
    assert('parseJSON.a === 1',      '1', parsed.a);
    assert('parseJSON bad input',    'null', String(utils.parseJSON('not-json')));

    // Truncate
    assert('truncate 5 chars',    'hello', utils.truncate('hello world', 5));
    assert('truncate exact',      'hello', utils.truncate('hello', 5));
    assert('truncate empty',      '',      utils.truncate('', 5));
    assert('truncate null',       '',      utils.truncate(null, 5));

    // Nested get
    var nested = { x: { y: { z: 'deep' } } };
    assert('get x.y.z',       'deep', utils.get(nested, 'x.y.z'));
    assert('get x.y',         '[object Object]', utils.get(nested, 'x.y'));
    assert('get missing',     'null', String(utils.get(nested, 'x.y.q')));
    assert('get null obj',    'null', String(utils.get(null, 'x')));

    // isEmpty
    assert('isEmpty null',    'true',  String(utils.isEmpty(null)));
    assert('isEmpty empty',   'true',  String(utils.isEmpty('')));
    assert('isEmpty spaces',  'true',  String(utils.isEmpty('   ')));
    assert('isEmpty value',   'false', String(utils.isEmpty('hello')));
    assert('isEmpty 0',       'false', String(utils.isEmpty(0)));

    // Discovery source and scope
    assert('getDiscoverySource', 'vCenterETL',         utils.getDiscoverySource());
    assert('getScope',           'x_ftl_vcenter_etl',  utils.getScope());

    // Run ID format (YYYYMMDDHHMMSS-nnnn)
    var runId = utils.generateRunId();
    assert('runId is string',      'true', typeof runId === 'string');
    assert('runId length >= 18',   'true', runId.length >= 18);
    assert('runId has dash',       'true', runId.indexOf('-') >= 0);

    gs.info('=== Results: ' + passed + ' passed, ' + failed + ' failed ===');

})();
