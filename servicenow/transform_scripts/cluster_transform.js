/**
 * Transform Script: Cluster → cmdb_ci_cluster
 * Source: x_ftl_vcenter_etl_cluster_stg
 * Target: cmdb_ci_cluster
 * Coalesce: correlation_id (= moref)
 *
 * Field Mappings:
 *   moref        → correlation_id
 *   name         → name
 *   ha_enabled   → u_ha_enabled
 *   drs_enabled  → u_drs_enabled
 */

(function onBefore(source, target, action) {
    var utils = new x_ftl_vcenter_etl.VCenterUtils();
    target.setValue('discovery_source',   utils.getDiscoverySource());
    target.setValue('install_status',     '1');
    target.setValue('operational_status', '1');
    target.setValue('correlation_id',     source.getValue('moref'));
    target.setValue('u_ha_enabled',       source.getValue('ha_enabled'));
    target.setValue('u_drs_enabled',      source.getValue('drs_enabled'));
    if (!source.getValue('moref')) { action = 'ignore'; }
})(source, target, action);

(function onAfter(source, target, action, error) {
    source.setValue('stg_state', error ? 'error' : 'processed');
    if (error) source.setValue('error_msg', String(error).substring(0, 1000));
    source.update();
})(source, target, action, error);
