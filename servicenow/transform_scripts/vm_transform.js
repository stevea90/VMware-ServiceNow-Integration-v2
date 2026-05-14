/**
 * Transform Script: Virtual Machine → cmdb_ci_vmware_instance
 * Scope: x_ftl_vcenter_etl
 *
 * Transform Map Configuration:
 *   Source Table:  x_ftl_vcenter_etl_vm_stg
 *   Target Table:  cmdb_ci_vmware_instance
 *   Coalesce:      u_instance_uuid (primary), u_bios_uuid (secondary), correlation_id
 *   Run BR:        false
 *
 * Field Mappings:
 *   moref              → correlation_id
 *   name               → name
 *   instance_uuid      → u_instance_uuid
 *   bios_uuid          → u_bios_uuid
 *   cpu_count          → vcpu_count
 *   cpu_cores_per_socket → u_cores_per_socket
 *   memory_size_gb*1024→ memory (MB)
 *   guest_os           → guest_os
 *   guest_hostname     → host_name
 *   num_disks          → num_disks
 *   num_nics           → num_nics
 *   hardware_version   → hardware_version
 *   power_state→mapped → operational_status
 *   (const) vCenterETL → discovery_source
 *   (const) 1          → install_status
 */

// ── onBefore ──────────────────────────────────────────────────────────────────
(function onBefore(source, target, action) {

    var utils  = new x_ftl_vcenter_etl.VCenterUtils();
    var logger = new x_ftl_vcenter_etl.VCenterLogger('VMTransform');

    target.setValue('discovery_source', utils.getDiscoverySource());
    target.setValue('install_status',   '1');

    // Map power state
    var powerState = source.getValue('power_state');
    target.setValue('operational_status', utils.mapPowerState(powerState));

    // Memory: GB → MB
    var memGB = parseFloat(source.getValue('memory_size_gb') || 0);
    target.setValue('memory', String(Math.round(memGB * 1024)));

    // Validate: at least one identifier must be present
    var instanceUuid = source.getValue('instance_uuid');
    var biosUuid     = source.getValue('bios_uuid');
    var moref        = source.getValue('moref');

    if (!instanceUuid && !biosUuid && !moref) {
        action = 'ignore';
        logger.warn('VM has no identifiers; skipping: ' + source.getValue('name'));
        return;
    }

    target.setValue('correlation_id',   moref        || '');
    target.setValue('u_instance_uuid',  instanceUuid || '');
    target.setValue('u_bios_uuid',      biosUuid     || '');

    logger.debug('VM onBefore: ' + source.getValue('name') + ' power=' + powerState);

})(source, target, action);


// ── onAfter ───────────────────────────────────────────────────────────────────
(function onAfter(source, target, action, error) {

    var logger = new x_ftl_vcenter_etl.VCenterLogger('VMTransform');

    source.setValue('stg_state', error ? 'error' : 'processed');
    if (error) source.setValue('error_msg', String(error).substring(0, 1000));
    source.update();

    if (target && target.getUniqueValue()) {
        logger.info('VM CI: ' + source.getValue('name') +
            ' → sys_id=' + target.getUniqueValue() + ' action=' + action);
    }

})(source, target, action, error);
