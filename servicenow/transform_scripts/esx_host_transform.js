/**
 * Transform Script: ESXi Host → cmdb_ci_esx_server
 * Scope: x_ftl_vcenter_etl
 *
 * Transform Map Configuration:
 *   Source Table:  x_ftl_vcenter_etl_host_stg
 *   Target Table:  cmdb_ci_esx_server
 *   Coalesce:      u_bios_uuid (primary), correlation_id (fallback)
 *   Run BR:        false
 *
 * Field Mappings:
 *   moref              → correlation_id
 *   name               → name
 *   bios_uuid          → u_bios_uuid
 *   cpu_count          → cpu_count
 *   cpu_cores          → cpu_core_count
 *   memory_size_gb*1024→ ram                (MB — set in script)
 *   model              → model_id
 *   vendor             → manufacturer
 *   os_type            → os
 *   power_state→mapped → operational_status (set in script)
 *   conn_state→mapped  → install_status     (set in script)
 *   (const) vCenterETL → discovery_source
 */

// ── onBefore ──────────────────────────────────────────────────────────────────
(function onBefore(source, target, action) {

    var utils  = new x_ftl_vcenter_etl.VCenterUtils();
    var logger = new x_ftl_vcenter_etl.VCenterLogger('ESXHostTransform');

    target.setValue('discovery_source', utils.getDiscoverySource());

    // Map power state → operational_status
    var powerState = source.getValue('power_state');
    target.setValue('operational_status', utils.mapPowerState(powerState));

    // Map connection state → install_status
    var connState = source.getValue('connection_state');
    target.setValue('install_status', utils.mapConnectionState(connState));

    // Convert memory GB → MB (CMDB stores ram in MB)
    var memGB = parseFloat(source.getValue('memory_size_gb') || 0);
    target.setValue('ram', String(Math.round(memGB * 1024)));

    // Validate required identifier
    var biosUuid = source.getValue('bios_uuid');
    var moref    = source.getValue('moref');

    if (!biosUuid && !moref) {
        action = 'ignore';
        logger.warn('ESXi host has neither bios_uuid nor moref; skipping: ' +
            source.getValue('name'));
        return;
    }

    // Primary coalesce on bios_uuid if present, else moref
    if (biosUuid) {
        target.setValue('u_bios_uuid', biosUuid);
    }
    target.setValue('correlation_id', moref);

    logger.debug('ESXi host onBefore: ' + source.getValue('name') +
        ' power=' + powerState + ' conn=' + connState);

})(source, target, action);


// ── onAfter ───────────────────────────────────────────────────────────────────
(function onAfter(source, target, action, error) {

    var logger = new x_ftl_vcenter_etl.VCenterLogger('ESXHostTransform');

    if (error) {
        source.setValue('stg_state', 'error');
        source.setValue('error_msg', String(error).substring(0, 1000));
    } else {
        source.setValue('stg_state', 'processed');
    }
    source.update();

    if (target && target.getUniqueValue()) {
        logger.info('ESXi host CI: ' + source.getValue('name') +
            ' → sys_id=' + target.getUniqueValue() + ' action=' + action);
    }

})(source, target, action, error);
