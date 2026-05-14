/**
 * Business Rule: vCenter CI Staleness Auto-Retire
 * Scope: x_ftl_vcenter_etl
 * Table: cmdb_ci (applies to all CMDB CI tables via inheritance)
 * When: Before Insert or Update
 * Condition: discovery_source = vCenterETL AND install_status changes to 7
 *
 * Purpose: When a CI is retired via the staleness manager, this BR fires
 * to cascade any additional cleanup actions (e.g., notify owners, remove
 * from service mappings).
 *
 * ServiceNow BR Configuration:
 *   Name:       vCenter ETL - CI Retirement Cascade
 *   Table:      cmdb_ci
 *   When:       Before
 *   Insert:     false
 *   Update:     true
 *   Condition:  current.discovery_source == 'vCenterETL' &&
 *               current.install_status.changesTo('7')
 *   Script:     (body below)
 */

(function executeRule(current, previous) {

    var logger = new x_ftl_vcenter_etl.VCenterLogger('StalenessBusinessRule');

    logger.info('CI retirement cascade triggered for: ' +
        current.getTableName() + ' name=' + current.getValue('name') +
        ' sys_id=' + current.getUniqueValue());

    // Remove from any active service mappings
    // This is a placeholder — extend per customer CSDM configuration
    try {
        var svcMap = new GlideRecord('svc_ci_assoc');
        svcMap.addQuery('ci', current.getUniqueValue());
        svcMap.query();
        while (svcMap.next()) {
            logger.debug('Removing service association: ' + svcMap.getUniqueValue());
            svcMap.deleteRecord();
        }
    } catch (e) {
        logger.warn('Could not remove service associations: ' + e.message);
    }

    // Log retirement event
    try {
        var log = new GlideRecord('x_ftl_vcenter_etl_log');
        log.initialize();
        log.setValue('level',   'INFO');
        log.setValue('source',  'StalenessBusinessRule');
        log.setValue('message', 'CI retired: ' + current.getTableName() +
            ' / ' + current.getValue('name'));
        log.setValue('detail',  JSON.stringify({
            sys_id: current.getUniqueValue(),
            table:  current.getTableName(),
            name:   current.getValue('name'),
            moref:  current.getValue('correlation_id')
        }));
        log.insert();
    } catch (e) { /* non-fatal */ }

})(current, previous);
