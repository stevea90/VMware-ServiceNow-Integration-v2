/**
 * Script Include: VCenterStalenessManager
 * Scope: x_ftl_vcenter_etl
 *
 * Manages CI staleness detection and retirement for the vCenter ETL.
 *
 * Strategy:
 *   After a full successful run, any CI managed by discovery_source=vCenterETL
 *   that was NOT updated in the current run (i.e. last_discovered > staleness
 *   threshold) is flagged for retirement.
 *
 *   Retirement = set install_status=7 (Retired) and operational_status=6 (Retired).
 *   A separate scheduled job or Business Rule escalates further if needed.
 *
 * Tables managed:
 *   cmdb_ci_vcenter, cmdb_ci_datacenter, cmdb_ci_cluster,
 *   cmdb_ci_esx_server, cmdb_ci_vmware_instance, cmdb_ci_datastore,
 *   cmdb_ci_storage_pool, cmdb_ci_dvs_switch
 */
var VCenterStalenessManager = Class.create();
VCenterStalenessManager.prototype = {

    MANAGED_TABLES: [
        'cmdb_ci_vcenter',
        'cmdb_ci_datacenter',
        'cmdb_ci_cluster',
        'cmdb_ci_esx_server',
        'cmdb_ci_vmware_instance',
        'cmdb_ci_datastore',
        'cmdb_ci_storage_pool',
        'cmdb_ci_dvs_switch'
    ],

    initialize: function(runId) {
        this.runId  = runId || '';
        this.logger = new VCenterLogger('VCenterStalenessManager', runId);
        this.cfg    = new VCenterConfig();
        this.stats  = { retired: 0, checked: 0 };
    },

    /**
     * Run staleness check across all managed tables.
     * @param {GlideDateTime} cutoff - CIs not seen after this date/time are stale.
     */
    runCheck: function(cutoff) {
        if (!cutoff) {
            cutoff = new GlideDateTime();
            cutoff.addDaysLocalTime(-this.cfg.stalenessDays());
        }

        this.logger.info('Running staleness check. Cutoff: ' + cutoff.getValue());

        for (var i = 0; i < this.MANAGED_TABLES.length; i++) {
            this._checkTable(this.MANAGED_TABLES[i], cutoff);
        }

        this.logger.info('Staleness check complete: ' + JSON.stringify(this.stats));
        return this.stats;
    },

    /**
     * Mark CIs in a table as retired if last_discovered < cutoff.
     */
    _checkTable: function(table, cutoff) {
        var gr = new GlideRecord(table);
        gr.addQuery('discovery_source', 'vCenterETL');
        gr.addQuery('install_status', '!=', '7'); // exclude already retired
        gr.addQuery('sys_updated_on', '<', cutoff.getValue());
        gr.query();

        while (gr.next()) {
            this.stats.checked++;
            this.logger.debug('Retiring stale CI: ' + table + ' name=' +
                gr.getValue('name') + ' sys_id=' + gr.getUniqueValue());

            gr.setValue('install_status',     '7'); // Retired
            gr.setValue('operational_status', '6'); // Retired
            gr.update();
            this.stats.retired++;
        }
    },

    /**
     * Restore a CI to operational state (called if CI reappears in next run).
     */
    restoreCI: function(table, sysId) {
        var gr = new GlideRecord(table);
        if (!gr.get(sysId)) return false;

        if (gr.getValue('install_status') === '7') {
            gr.setValue('install_status',     '1'); // Installed
            gr.setValue('operational_status', '1'); // Operational
            gr.update();
            this.logger.info('Restored CI: ' + table + ' sys_id=' + sysId);
            return true;
        }
        return false;
    },

    /**
     * Clean up orphaned CMDB relationships where one side is retired.
     */
    cleanOrphanedRelationships: function() {
        this.logger.info('Cleaning orphaned CMDB relationships');
        var cleaned = 0;

        var rel = new GlideRecord('cmdb_rel_ci');
        // Find relationships where parent or child is retired
        var qc = rel.addQuery('parent.discovery_source', 'vCenterETL');
        qc.addOrCondition('child.discovery_source', 'vCenterETL');
        rel.query();

        while (rel.next()) {
            var parentGr = new GlideRecord(rel.getElement('parent').getTableName());
            var childGr  = new GlideRecord(rel.getElement('child').getTableName());

            var parentRetired = parentGr.get(rel.getValue('parent')) &&
                parentGr.getValue('install_status') === '7';
            var childRetired  = childGr.get(rel.getValue('child')) &&
                childGr.getValue('install_status') === '7';

            if (parentRetired || childRetired) {
                rel.deleteRecord();
                cleaned++;
            }
        }

        this.logger.info('Cleaned ' + cleaned + ' orphaned relationships');
        return cleaned;
    },

    type: 'VCenterStalenessManager'
};
