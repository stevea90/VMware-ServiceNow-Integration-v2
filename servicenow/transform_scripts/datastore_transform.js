/**
 * Transform Script: Datastore → cmdb_ci_datastore
 * Source: x_ftl_vcenter_etl_datastore_stg
 * Target: cmdb_ci_datastore
 * Coalesce: correlation_id (= moref)
 *
 * Field Mappings:
 *   moref          → correlation_id
 *   name           → name
 *   type           → u_type
 *   capacity_gb    → disk_space
 *   free_space_gb  → u_free_space_gb
 *   accessible     → u_accessible
 */

(function onBefore(source, target, action) {
    var utils = new x_ftl_vcenter_etl.VCenterUtils();
    target.setValue('discovery_source',   utils.getDiscoverySource());
    target.setValue('install_status',     '1');
    target.setValue('operational_status', '1');
    target.setValue('correlation_id',     source.getValue('moref'));
    target.setValue('disk_space',         source.getValue('capacity_gb'));
    target.setValue('u_type',             source.getValue('type'));
    target.setValue('u_free_space_gb',    source.getValue('free_space_gb'));
    target.setValue('u_accessible',       source.getValue('accessible'));
    if (!source.getValue('moref')) { action = 'ignore'; }
})(source, target, action);

(function onAfter(source, target, action, error) {
    source.setValue('stg_state', error ? 'error' : 'processed');
    if (error) source.setValue('error_msg', String(error).substring(0, 1000));
    source.update();
})(source, target, action, error);
