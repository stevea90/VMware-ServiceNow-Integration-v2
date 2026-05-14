/**
 * Transform Script: Distributed vSwitch → cmdb_ci_dvs_switch
 * Source: x_ftl_vcenter_etl_dvs_stg
 * Target: cmdb_ci_dvs_switch
 * Coalesce: u_dvs_uuid (primary), correlation_id (fallback)
 *
 * Field Mappings:
 *   moref        → correlation_id
 *   name         → name
 *   dvs_uuid     → u_dvs_uuid
 *   num_ports    → u_num_ports
 *   uplink_count → u_uplink_count
 */

(function onBefore(source, target, action) {
    var utils  = new x_ftl_vcenter_etl.VCenterUtils();
    var logger = new x_ftl_vcenter_etl.VCenterLogger('DVSTransform');

    target.setValue('discovery_source',   utils.getDiscoverySource());
    target.setValue('install_status',     '1');
    target.setValue('operational_status', '1');
    target.setValue('correlation_id',     source.getValue('moref'));

    var dvsUuid = source.getValue('dvs_uuid');
    if (dvsUuid) {
        target.setValue('u_dvs_uuid', dvsUuid);
    }

    target.setValue('u_num_ports',    source.getValue('num_ports'));
    target.setValue('u_uplink_count', source.getValue('uplink_count'));

    if (!source.getValue('moref') && !dvsUuid) {
        action = 'ignore';
        logger.warn('DVS has no identifiers; skipping: ' + source.getValue('name'));
    }

})(source, target, action);

(function onAfter(source, target, action, error) {
    source.setValue('stg_state', error ? 'error' : 'processed');
    if (error) source.setValue('error_msg', String(error).substring(0, 1000));
    source.update();
})(source, target, action, error);
