/**
 * Transform Script: vCenter Instance → cmdb_ci_vcenter
 * Scope: x_ftl_vcenter_etl
 *
 * Used in IH ETL Transform Map for table x_ftl_vcenter_etl_vcenter_stg.
 * The "onBefore" script runs per staging row before field-level mapping.
 * The "onAfter" script stores the resolved CI sys_id back to staging.
 *
 * Place these scripts in the Transform Map's Script section in ServiceNow Studio.
 *
 * Transform Map Configuration:
 *   Source Table:  x_ftl_vcenter_etl_vcenter_stg
 *   Target Table:  cmdb_ci_vcenter
 *   Run Business Rules: false (IRE handles reconciliation)
 *   Coalesce:      correlation_id
 */

// ── onBefore ──────────────────────────────────────────────────────────────────
// Called once per staging row before field mapping.
// Resolves IRE identification and sets source.

(function onBefore(source, target, action) {

    var utils  = new x_ftl_vcenter_etl.VCenterUtils();
    var logger = new x_ftl_vcenter_etl.VCenterLogger('vCenterTransform');

    // Set discovery source on target
    target.setValue('discovery_source', utils.getDiscoverySource());

    // Resolve instance_uuid from staging
    var instanceUuid = source.getValue('instance_uuid');
    if (instanceUuid) {
        // Check for existing CI by instance_uuid
        var existing = new GlideRecord('cmdb_ci_vcenter');
        existing.addQuery('u_instance_uuid', instanceUuid);
        existing.setLimit(1);
        existing.query();
        if (existing.next()) {
            logger.debug('Matched vCenter CI by instance_uuid: ' + existing.getUniqueValue());
        }
    }

    // Ensure correlation_id is set (used as coalesce field)
    if (!source.getValue('moref')) {
        action = 'ignore';
        logger.warn('vCenter staging row has no moref; skipping.');
    }

})(source, target, action);


// ── Field Mappings (set in Transform Map field map, NOT script) ───────────────
// Source Field          → Target Field
// moref                 → correlation_id
// name                  → name
// vcenter_fqdn          → ip_address
// vcenter_fqdn          → fqdn
// version               → version
// build                 → u_build
// instance_uuid         → u_instance_uuid
// (constant) vCenterETL → discovery_source
// (constant) 1          → install_status
// (constant) 1          → operational_status


// ── onAfter ───────────────────────────────────────────────────────────────────
// Mark staging row as processed; store resolved sys_id.

(function onAfter(source, target, action, error) {

    var logger = new x_ftl_vcenter_etl.VCenterLogger('vCenterTransform');

    if (error) {
        source.setValue('stg_state', 'error');
        source.setValue('error_msg', String(error).substring(0, 1000));
    } else {
        source.setValue('stg_state', 'processed');
    }
    source.update();

    logger.debug('vCenter transform complete. Action: ' + action +
        ' CI sys_id: ' + (target ? target.getUniqueValue() : 'null'));

})(source, target, action, error);
