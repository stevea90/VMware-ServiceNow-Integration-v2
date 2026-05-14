/**
 * Transform Script: Datacenter → cmdb_ci_datacenter
 * Source: x_ftl_vcenter_etl_datacenter_stg
 * Target: cmdb_ci_datacenter
 * Coalesce: correlation_id (= moref)
 */

(function onBefore(source, target, action) {
    var utils = new x_ftl_vcenter_etl.VCenterUtils();
    target.setValue('discovery_source',   utils.getDiscoverySource());
    target.setValue('install_status',     '1');
    target.setValue('operational_status', '1');
    target.setValue('correlation_id',     source.getValue('moref'));
    if (!source.getValue('moref')) { action = 'ignore'; }
})(source, target, action);

(function onAfter(source, target, action, error) {
    source.setValue('stg_state', error ? 'error' : 'processed');
    if (error) source.setValue('error_msg', String(error).substring(0, 1000));
    source.update();
})(source, target, action, error);
